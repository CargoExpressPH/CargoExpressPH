// Supabase Edge Function: archive-expired-evidence-photos
//
// Deletes shipment evidence photos (pickup + delivery proofs) for orders
// that have been 'Delivered' or 'Cancelled' for more than 6 months, so the
// bucket does not grow forever on shipments nobody will look at again.
// Receipts are intentionally left alone — they are financial records with a
// different retention concern, not "shipment evidence" in the client's ask.
//
// Triggered exclusively by the `evidence_photo_archive` pg_cron job (see
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
  | { kind: 'unknown' }

function classifyPhoto(entry: unknown): PhotoDescriptor {
  if (typeof entry === 'string') {
    const value = entry.trim()
    if (!value) return { kind: 'unknown' }
    if (value.startsWith('{')) {
      try { return classifyPhoto(JSON.parse(value)) } catch { /* fall through */ }
    }
    if (value.startsWith('photoFallbacks/')) return { kind: 'firestore_fallback', firestorePath: value }
    if (/^(?:https?:|data:image\/|blob:|error:)/i.test(value)) return { kind: 'unknown' }
    return { kind: 'supabase_storage', path: value.replace(/^\/+/, '') }
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>
    if (obj.type === 'firestore_fallback' || obj.firestore_path) {
      return typeof obj.firestore_path === 'string'
        ? { kind: 'firestore_fallback', firestorePath: obj.firestore_path }
        : { kind: 'unknown' }
    }
    if (obj.type === 'supabase_storage' || obj.path) {
      return typeof obj.path === 'string' ? { kind: 'supabase_storage', path: obj.path } : { kind: 'unknown' }
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

    if (orders.length === 0) {
      return json({ success: true, orders_processed: 0, files_deleted: 0, note: `No evidence older than ${ARCHIVE_AFTER_MONTHS} months to archive.` })
    }

    // One Firebase token for the whole run — lazily fetched only if a
    // Firestore fallback photo actually turns up.
    let firebaseAccessTokenPromise: Promise<string> | null = null
    const getSharedFirebaseToken = () => {
      if (!firebaseAccessTokenPromise) {
        const account = loadFirebaseServiceAccount()
        firebaseAccessTokenPromise = account
          ? getFirebaseAccessToken(account)
          : Promise.reject(new Error('Firebase is not configured'))
      }
      return firebaseAccessTokenPromise
    }
    const firebaseProjectId = loadFirebaseServiceAccount()?.project_id

    const supabasePaths: string[] = []
    const firestorePaths: string[] = []
    const ordersByPath = new Map<string, string>() // path/firestorePath -> order_id, for the per-order clear step

    for (const order of orders) {
      const entries = [...(order.pickup_photos || []), ...(order.delivery_photos || [])]
      for (const entry of entries) {
        const descriptor = classifyPhoto(entry)
        if (descriptor.kind === 'supabase_storage') {
          supabasePaths.push(descriptor.path)
          ordersByPath.set(descriptor.path, order.order_id)
        } else if (descriptor.kind === 'firestore_fallback') {
          firestorePaths.push(descriptor.firestorePath)
          ordersByPath.set(descriptor.firestorePath, order.order_id)
        }
      }
    }

    let filesDeleted = 0
    const failedOrderIds = new Set<string>()

    // A batch with no error is trusted as fully removed rather than
    // correlated against the response body — see the identical note in
    // cleanup-orphaned-photos/index.ts. Every path here came straight from
    // get_expired_evidence_orders(), so a successful call is strong evidence
    // the whole batch is gone.
    for (const batch of chunk(supabasePaths, REMOVE_BATCH_SIZE)) {
      const { error: removeError } = await supabase.storage.from(BUCKET).remove(batch)
      if (removeError) {
        console.error('[archive-expired-evidence-photos] Storage batch remove failed:', removeError.message)
        for (const path of batch) failedOrderIds.add(ordersByPath.get(path) || '')
        continue
      }
      filesDeleted += batch.length
    }

    if (firestorePaths.length > 0) {
      try {
        const accessToken = await getSharedFirebaseToken()
        for (const firestorePath of firestorePaths) {
          const [, docId] = firestorePath.split('/')
          const response = await fetch(
            `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/photoFallbacks/${docId}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
          )
          if (response.ok || response.status === 404) {
            filesDeleted += 1
          } else {
            failedOrderIds.add(ordersByPath.get(firestorePath) || '')
          }
        }
      } catch (firebaseError) {
        console.error('[archive-expired-evidence-photos] Firestore fallback cleanup failed:', firebaseError)
        for (const firestorePath of firestorePaths) failedOrderIds.add(ordersByPath.get(firestorePath) || '')
      }
    }

    // Only clear pickup_photos/delivery_photos for orders whose evidence
    // fully deleted without any failure — a partial failure must leave the
    // order's references intact so tonight's run (or tomorrow's) can retry
    // rather than silently orphaning a reference to a file that is still there.
    const clearedOrderIds = orders
      .map((order) => order.order_id)
      .filter((orderId) => !failedOrderIds.has(orderId))

    if (clearedOrderIds.length > 0) {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ pickup_photos: [], delivery_photos: [] })
        .in('id', clearedOrderIds)
      if (updateError) console.error('[archive-expired-evidence-photos] Failed to clear archived photo references:', updateError.message)
    }

    await supabase.from('photo_storage_events').insert({
      event_type: 'cleanup',
      provider: 'system',
      outcome: failedOrderIds.size > 0 && clearedOrderIds.length === 0 ? 'failure' : 'success',
      message: `Auto-archive removed evidence for ${clearedOrderIds.length} of ${orders.length} eligible order(s) (${filesDeleted} file(s) deleted).`,
      metadata: {
        cleanup_kind: 'auto_archive',
        cutoff: cutoff.toISOString(),
        orders_eligible: orders.length,
        orders_archived: clearedOrderIds.length,
        orders_failed: failedOrderIds.size,
        files_deleted: filesDeleted,
      },
    })

    return json({
      success: true,
      orders_eligible: orders.length,
      orders_archived: clearedOrderIds.length,
      orders_failed: failedOrderIds.size,
      files_deleted: filesDeleted,
    })
  } catch (err) {
    console.error('[archive-expired-evidence-photos] failed:', err)
    return json({ error: 'Evidence archive run failed.' }, 500)
  }
})
