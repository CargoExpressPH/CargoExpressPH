// Supabase Edge Function: delete-storage-photos
//
// Backs the simplified Storage Monitoring gallery's "Delete Selected" action.
// Replaces cleanup-orphaned-photos (removed) — orphan detection is now just
// one case the shared eligibility check in delete_evidence_photos() handles,
// alongside pickup/delivery evidence photos that have passed the existing
// 6-month Delivered/Cancelled retention window.
//
// Two-step design, same shape as archive-expired-evidence-photos:
//   1. Ask delete_evidence_photos() — using the CALLER's own JWT, so its
//      internal is_admin() check and full eligibility recompute are real —
//      which of the requested photos may actually be deleted. It rejects
//      anything it can't re-verify right now (active shipment, featured,
//      receipt, not yet 6 months, or the reference no longer matches the
//      booking) and queues everything else in the existing
//      photo_cleanup_queue, exactly like the scheduled archive job does.
//   2. Physically delete only the items that were just queued, using
//      service-role credentials (Supabase Storage batch remove / Firestore
//      document delete — same calls archive-expired-evidence-photos already
//      makes), then record the result via record_photo_cleanup_queue_result
//      so a crash here leaves the work retryable, not lost or duplicated.
//
// The set of paths to delete is never taken on faith from the request body —
// step 1 re-derives eligibility from the database itself for every item.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROVIDER_TIMEOUT_MS = 15_000
const BUCKET = 'cargo-photos'
const REMOVE_BATCH_SIZE = 100
const MAX_ITEMS = 100

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const encodeBase64Url = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Identical to the Firebase auth helper already reviewed and running in
// archive-expired-evidence-photos and delete-photo-fallback.
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
    redirect: 'error',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
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

const requireAdmin = async (authHeader: string) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey)

  const { data, error } = await userClient.auth.getUser()
  if (error || !data.user) throw new Response('Authentication required', { status: 401 })

  const { data: profile } = await serviceClient.from('profiles').select('role').eq('id', data.user.id).single()
  if (profile?.role !== 'admin') throw new Response('Admin access required', { status: 403 })

  return { user: data.user, userClient, serviceClient }
}

type RequestedItem = { order_id: string | null; photo_field: string | null; provider: unknown; storage_path: unknown }
type EligibilityRow = { item_key: string; queue_id: number | null; queued: boolean; reason: string | null; size_bytes: number | null }

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
    const { user, userClient, serviceClient } = await requireAdmin(authHeader)

    const body = await req.json().catch(() => ({})) as { items?: unknown }
    const rawItems = Array.isArray(body.items) ? body.items : []
    if (rawItems.length === 0) return json({ error: 'Select at least one photo' }, 400)
    if (rawItems.length > MAX_ITEMS) return json({ error: `Select at most ${MAX_ITEMS} photos at once` }, 400)

    const items: RequestedItem[] = rawItems.map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>
      return {
        order_id: typeof r.order_id === 'string' && r.order_id ? r.order_id : null,
        photo_field: typeof r.photo_field === 'string' ? r.photo_field : null,
        provider: r.provider,
        storage_path: r.storage_path,
      }
    })

    // Re-verify eligibility server-side, for real, using the ADMIN's own JWT
    // — never trust the "eligible" label the client saw on an earlier list.
    const { data: results, error: rpcError } = await userClient.rpc('delete_evidence_photos', {
      p_items: items,
    })
    if (rpcError) return json({ error: rpcError.message || 'Could not process the selected photos' }, 500)

    const rows = (results || []) as EligibilityRow[]
    const byKey = new Map(items.map((it) => [`${it.provider}:${it.storage_path}`, it]))
    const rejected = rows.filter((r) => !r.queued).map((r) => ({ item_key: r.item_key, reason: r.reason || 'Not eligible' }))
    const queued = rows.filter((r) => r.queued && r.queue_id != null)

    let deletedCount = 0
    let failedCount = 0
    let freedBytes = 0
    const failedKeys: string[] = []

    const recordResult = async (ids: number[], errorMessage: string | null) => {
      if (ids.length === 0) return true
      const { error } = await serviceClient.rpc('record_photo_cleanup_queue_result', { p_ids: ids, p_error: errorMessage })
      if (error) console.error('[delete-storage-photos] Could not update cleanup queue:', error.message)
      return !error
    }

    const supabaseQueued = queued.filter((r) => byKey.get(r.item_key)?.provider === 'supabase')
    const firebaseQueued = queued.filter((r) => byKey.get(r.item_key)?.provider === 'firebase')

    // A batch with no error is trusted as fully removed — same reasoning as
    // the identical note in cleanup-orphaned-photos (now removed) and
    // archive-expired-evidence-photos: every path here was just confirmed to
    // exist by delete_evidence_photos() moments earlier.
    for (const batch of chunk(supabaseQueued, REMOVE_BATCH_SIZE)) {
      const paths = batch.map((r) => byKey.get(r.item_key)!.storage_path as string)
      const { error: removeError } = await serviceClient.storage.from(BUCKET).remove(paths)
      const ids = batch.map((r) => r.queue_id as number)
      if (removeError) {
        await recordResult(ids, removeError.message)
        failedCount += batch.length
        failedKeys.push(...batch.map((r) => r.item_key))
        continue
      }
      const recorded = await recordResult(ids, null)
      if (recorded) {
        deletedCount += batch.length
        freedBytes += batch.reduce((sum, r) => sum + Number(r.size_bytes || 0), 0)
      } else {
        failedCount += batch.length
        failedKeys.push(...batch.map((r) => r.item_key))
      }
    }

    if (firebaseQueued.length > 0) {
      const firebaseServiceAccount = loadFirebaseServiceAccount()
      try {
        if (!firebaseServiceAccount) throw new Error('Firebase is not configured')
        const accessToken = await getFirebaseAccessToken(firebaseServiceAccount)
        const projectId = firebaseServiceAccount.project_id
        for (const r of firebaseQueued) {
          const item = byKey.get(r.item_key)!
          const [, docId] = String(item.storage_path).split('/')
          const response = await fetch(
            `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/photoFallbacks/${docId}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${accessToken}` },
              redirect: 'error',
              signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
            },
          )
          if (response.ok || response.status === 404) {
            const recorded = await recordResult([r.queue_id as number], null)
            if (recorded) { deletedCount += 1; freedBytes += Number(r.size_bytes || 0) } else { failedCount += 1; failedKeys.push(r.item_key) }
          } else {
            await recordResult([r.queue_id as number], `Backup storage returned ${response.status}`)
            failedCount += 1
            failedKeys.push(r.item_key)
          }
        }
      } catch (firebaseError) {
        console.error('[delete-storage-photos] Firestore fallback deletion failed:', firebaseError)
        await recordResult(firebaseQueued.map((r) => r.queue_id as number), 'Backup storage is temporarily unavailable.')
        failedCount += firebaseQueued.length
        failedKeys.push(...firebaseQueued.map((r) => r.item_key))
      }
    }

    const hasFailures = failedCount > 0

    await serviceClient.from('photo_storage_events').insert({
      event_type: 'cleanup',
      provider: 'system',
      outcome: hasFailures ? 'failure' : 'success',
      message: hasFailures
        ? `Admin-selected cleanup removed ${deletedCount} photo(s); ${failedCount} still need attention.`
        : `Admin-selected cleanup permanently removed ${deletedCount} photo(s).`,
      metadata: {
        cleanup_kind: 'admin_selected_photos',
        requested: items.length,
        queued: queued.length,
        rejected: rejected.length,
        deleted: deletedCount,
        failed: failedCount,
      },
      created_by: user.id,
    })

    return json({
      requested: items.length,
      deleted_count: deletedCount,
      failed_count: failedCount,
      failed: failedKeys,
      freed_bytes: freedBytes,
      rejected,
    })
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status)
    console.error('[delete-storage-photos] failed:', error)
    return json({ error: 'Could not delete the selected photos' }, 500)
  }
})
