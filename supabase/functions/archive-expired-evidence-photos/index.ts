// Supabase Edge Function: archive-expired-evidence-photos
//
// Permanently removes old shipment evidence photos (pickup + delivery proofs) for orders
// that have been 'Delivered' or 'Cancelled' for more than 6 months, so the
// bucket does not grow forever on shipments nobody will look at again.
// Receipts are intentionally left alone — they are financial records with a
// different retention concern, not "shipment evidence" in the client's ask.
//
// Triggered exclusively by the scheduled old-photo cleanup job (see
// 20260901020000_photo_storage_cleanup_archiving_and_alerts.sql) once a day
// — never called from the app itself. Same "service role key as bearer
// token" gate as process-daily-reminders, for the same reason: this mutates
// evidence for every eligible order in one call, which no single logged-in
// session should be able to trigger on demand.
//
// Required Supabase secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional: FIREBASE_SERVICE_ACCOUNT_B64 / FIREBASE_SERVICE_ACCOUNT — only
// needed if any archived order's evidence used the Firestore fallback.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BUCKET = 'cargo-photos'
const REMOVE_BATCH_SIZE = 100
const QUEUE_BATCH_SIZE = 500
const ARCHIVE_AFTER_MONTHS = 6

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ── Mirrors src/lib/photoReference.js's classification, just enough of it
// to route each stored descriptor to the right deletion call. ──
type PhotoDescriptor =
  | { kind: 'supabase_storage'; path: string }
  | { kind: 'firestore_fallback'; firestorePath: string }
  | { kind: 'embedded_photo' }
  | { kind: 'unknown' }

const isManagedEvidencePath = (value: string) =>
  /^(?:pickup-proofs|delivery-proofs)\/[^/]+\/.+/.test(value)

function storagePathFromUrl(value: string): string | null {
  try {
    const url = new URL(value)
    const marker = '/storage/v1/object/'
    const markerIndex = url.pathname.indexOf(marker)
    if (markerIndex < 0) return null
    const remainder = url.pathname.slice(markerIndex + marker.length)
    const match = remainder.match(/^(?:public|sign|authenticated)\/cargo-photos\/(.+)$/)
    return match?.[1] ? decodeURIComponent(match[1]).replace(/^\/+/, '') : null
  } catch {
    return null
  }
}

function classifyPhoto(entry: unknown): PhotoDescriptor {
  if (typeof entry === 'string') {
    const value = entry.trim()
    if (!value) return { kind: 'unknown' }
    if (value.startsWith('{')) {
      try { return classifyPhoto(JSON.parse(value)) } catch { /* fall through */ }
    }
    if (/^photoFallbacks\/[^/]+$/.test(value)) return { kind: 'firestore_fallback', firestorePath: value }
    if (/^https?:/i.test(value)) {
      const storagePath = storagePathFromUrl(value)
      return storagePath && isManagedEvidencePath(storagePath)
        ? { kind: 'supabase_storage', path: storagePath }
        : { kind: 'unknown' }
    }
    if (/^data:image\//i.test(value)) return { kind: 'embedded_photo' }
    if (/^(?:blob:|error:)/i.test(value)) return { kind: 'unknown' }
    const path = value.replace(/^\/+/, '')
    return isManagedEvidencePath(path) ? { kind: 'supabase_storage', path } : { kind: 'unknown' }
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>
    if (obj.type === 'firestore_fallback' || obj.firestore_path) {
      return typeof obj.firestore_path === 'string' && /^photoFallbacks\/[^/]+$/.test(obj.firestore_path)
        ? { kind: 'firestore_fallback', firestorePath: obj.firestore_path }
        : { kind: 'unknown' }
    }
    if (obj.type === 'supabase_storage' || obj.path) {
      const path = typeof obj.path === 'string' ? obj.path.replace(/^\/+/, '') : ''
      const bucket = typeof obj.bucket === 'string' ? obj.bucket : BUCKET
      return bucket === BUCKET && isManagedEvidencePath(path)
        ? { kind: 'supabase_storage', path }
        : { kind: 'unknown' }
    }
    if (obj.type === 'direct_url' || obj.url || obj.data_url) {
      const value = typeof obj.url === 'string' ? obj.url : typeof obj.data_url === 'string' ? obj.data_url : ''
      if (/^https?:/i.test(value)) {
        const storagePath = storagePathFromUrl(value)
        return storagePath && isManagedEvidencePath(storagePath)
          ? { kind: 'supabase_storage', path: storagePath }
          : { kind: 'unknown' }
      }
      return /^data:image\//i.test(value) ? { kind: 'embedded_photo' } : { kind: 'unknown' }
    }
  }
  return { kind: 'unknown' }
}

const encodeBase64Url = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function getFirebaseAccessToken(serviceAccount: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const unsignedToken = `${encodeBase64Url({ alg: 'RS256', typ: 'JWT' })}.${encodeBase64Url({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`
  const pemContents = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsignedToken))
  const signedToken = `${unsignedToken}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedToken}`,
  })
  const data = await response.json()
  if (!response.ok || !data.access_token) throw new Error(data.error_description || 'Failed to authenticate with Firebase')
  return data.access_token
}

const loadFirebaseServiceAccount = () => {
  const b64 = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_B64')
  const raw = b64 ? atob(b64) : Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
  return raw ? JSON.parse(raw) : null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  try {
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!serviceRoleKey || token !== serviceRoleKey) {
      return json({ error: 'Forbidden' }, 403)
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const cutoff = new Date()
    cutoff.setUTCMonth(cutoff.getUTCMonth() - ARCHIVE_AFTER_MONTHS)

    const { data: expiredOrders, error: expiredError } = await supabase
      .rpc('get_expired_evidence_orders', { p_cutoff: cutoff.toISOString() })
    if (expiredError) return json({ error: expiredError.message || 'Could not list expired evidence orders' }, 500)

    const orders = (expiredOrders || []) as Array<{
      order_id: string; tracking_number: string; status: string; terminal_status_at: string
      pickup_photos: unknown[] | null; delivery_photos: unknown[] | null
    }>

    // One Firebase token for the whole run — lazily fetched only if a
    // Firestore fallback photo actually turns up.
    const firebaseServiceAccount = loadFirebaseServiceAccount()
    let firebaseAccessTokenPromise: Promise<string> | null = null
    const getSharedFirebaseToken = () => {
      if (!firebaseAccessTokenPromise) {
        firebaseAccessTokenPromise = firebaseServiceAccount
          ? getFirebaseAccessToken(firebaseServiceAccount)
          : Promise.reject(new Error('Firebase is not configured'))
      }
      return firebaseAccessTokenPromise
    }
    const firebaseProjectId = firebaseServiceAccount?.project_id

    const failedOrderIds = new Set<string>()
    const readyOrderIds: string[] = []
    const queuedItems = new Map<string, { provider: 'supabase' | 'firebase'; storage_path: string }>()

    for (const order of orders) {
      const entries = [...(order.pickup_photos || []), ...(order.delivery_photos || [])]
      const orderItems: Array<{ provider: 'supabase' | 'firebase'; storage_path: string }> = []
      let hasUnknownReference = false
      for (const entry of entries) {
        const descriptor = classifyPhoto(entry)
        if (descriptor.kind === 'supabase_storage') {
          orderItems.push({ provider: 'supabase', storage_path: descriptor.path })
        } else if (descriptor.kind === 'firestore_fallback') {
          orderItems.push({ provider: 'firebase', storage_path: descriptor.firestorePath })
        } else if (descriptor.kind === 'unknown') {
          // Never clear a row when a stored reference cannot be understood.
          // Keeping it visible is safer than claiming it was removed.
          hasUnknownReference = true
        }
      }
      if (hasUnknownReference) {
        failedOrderIds.add(order.order_id)
        continue
      }
      readyOrderIds.push(order.order_id)
      for (const item of orderItems) queuedItems.set(`${item.provider}:${item.storage_path}`, item)
    }

    // The RPC adds every managed file to a durable retry queue and clears all
    // selected orders in one database transaction. A database error therefore
    // cannot leave deleted files behind references that still appear on an order.
    let clearedOrderIds: string[] = []
    if (readyOrderIds.length > 0) {
      const { error: queueError } = await supabase.rpc('queue_expired_evidence_cleanup', {
        p_order_ids: readyOrderIds,
        p_items: Array.from(queuedItems.values()),
      })
      if (queueError) {
        console.error('[archive-expired-evidence-photos] Could not queue old-photo cleanup:', queueError.message)
        for (const orderId of readyOrderIds) failedOrderIds.add(orderId)
      } else {
        clearedOrderIds = readyOrderIds
      }
    }

    type QueueRow = { id: number; provider: 'supabase' | 'firebase'; storage_path: string }
    const { data: pendingData, error: pendingError } = await supabase
      .from('photo_cleanup_queue')
      .select('id, provider, storage_path')
      .is('completed_at', null)
      .order('queued_at', { ascending: true })
      .limit(QUEUE_BATCH_SIZE)
    const pendingRows = (pendingData || []) as QueueRow[]

    let filesDeleted = 0
    let filesFailed = 0

    const recordQueueResult = async (ids: number[], errorMessage: string | null) => {
      if (ids.length === 0) return true
      const { error } = await supabase.rpc('record_photo_cleanup_queue_result', {
        p_ids: ids,
        p_error: errorMessage,
      })
      if (error) console.error('[archive-expired-evidence-photos] Could not update cleanup queue:', error.message)
      return !error
    }

    // A batch with no error is trusted as fully removed rather than
    // correlated against the response body — see the identical note in
    // cleanup-orphaned-photos/index.ts. Every path here came straight from
    // get_expired_evidence_orders(), so a successful call is strong evidence
    // the whole batch is gone.
    const pendingSupabase = pendingRows.filter((row) => row.provider === 'supabase')
    for (const batch of chunk(pendingSupabase, REMOVE_BATCH_SIZE)) {
      const { error: removeError } = await supabase.storage.from(BUCKET).remove(batch.map((row) => row.storage_path))
      if (removeError) {
        console.error('[archive-expired-evidence-photos] Storage batch remove failed:', removeError.message)
        await recordQueueResult(batch.map((row) => row.id), removeError.message)
        filesFailed += batch.length
        continue
      }
      const recorded = await recordQueueResult(batch.map((row) => row.id), null)
      if (recorded) filesDeleted += batch.length
      else filesFailed += batch.length
    }

    const pendingFirebase = pendingRows.filter((row) => row.provider === 'firebase')
    if (pendingFirebase.length > 0) {
      try {
        const accessToken = await getSharedFirebaseToken()
        const completedIds: number[] = []
        const failedIds: number[] = []
        for (const row of pendingFirebase) {
          const [, docId] = row.storage_path.split('/')
          const response = await fetch(
            `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/photoFallbacks/${docId}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
          )
          if (response.ok || response.status === 404) completedIds.push(row.id)
          else failedIds.push(row.id)
        }
        const completedRecorded = await recordQueueResult(completedIds, null)
        await recordQueueResult(failedIds, 'Firebase Backup could not remove the photo.')
        if (completedRecorded) filesDeleted += completedIds.length
        else filesFailed += completedIds.length
        filesFailed += failedIds.length
      } catch (firebaseError) {
        console.error('[archive-expired-evidence-photos] Firestore fallback cleanup failed:', firebaseError)
        await recordQueueResult(pendingFirebase.map((row) => row.id), 'Firebase Backup is temporarily unavailable.')
        filesFailed += pendingFirebase.length
      }
    }

    // Anything still pending remains in the retry queue for the next run.
    let filesPending = 0
    const { count: pendingCount, error: pendingCountError } = await supabase
      .from('photo_cleanup_queue')
      .select('id', { count: 'exact', head: true })
      .is('completed_at', null)
    if (!pendingCountError) filesPending = pendingCount || 0

    if (orders.length === 0 && pendingRows.length === 0 && !pendingError) {
      return json({
        success: true,
        orders_eligible: 0,
        orders_cleaned: 0,
        orders_failed: 0,
        files_deleted: 0,
        files_failed: 0,
        files_pending: filesPending,
        note: `No pickup or delivery photos older than ${ARCHIVE_AFTER_MONTHS} months need cleanup.`,
      })
    }

    const hasFailures = Boolean(pendingError || pendingCountError || failedOrderIds.size > 0 || filesFailed > 0)

    await supabase.from('photo_storage_events').insert({
      event_type: 'cleanup',
      provider: 'system',
      outcome: hasFailures ? 'failure' : 'success',
      message: hasFailures
        ? `Scheduled cleanup removed old photos for ${clearedOrderIds.length} order(s), but some work will be retried.`
        : `Scheduled cleanup permanently removed old photos for ${clearedOrderIds.length} order(s).`,
      metadata: {
        cleanup_kind: 'scheduled_old_photos',
        cutoff: cutoff.toISOString(),
        orders_eligible: orders.length,
        orders_archived: clearedOrderIds.length,
        orders_cleaned: clearedOrderIds.length,
        orders_failed: failedOrderIds.size,
        files_deleted: filesDeleted,
        files_failed: filesFailed,
        files_pending: filesPending,
      },
    })

    return json({
      success: !hasFailures,
      orders_eligible: orders.length,
      orders_archived: clearedOrderIds.length,
      orders_cleaned: clearedOrderIds.length,
      orders_failed: failedOrderIds.size,
      files_deleted: filesDeleted,
      files_failed: filesFailed,
      files_pending: filesPending,
    }, hasFailures ? 500 : 200)
  } catch (err) {
    console.error('[archive-expired-evidence-photos] failed:', err)
    return json({ error: 'Evidence archive run failed.' }, 500)
  }
})
