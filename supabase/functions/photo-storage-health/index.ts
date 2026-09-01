import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
})

const GIB = 1024 ** 3
// Supabase's Management API exposes the live plan name but currently does not
// expose the total Storage Size quota through PAT-compatible entitlements.
// These are the published included quotas; the selected value still changes
// automatically as soon as the organization plan returned by Supabase changes.
const INCLUDED_STORAGE_BYTES_BY_PLAN: Record<string, number | null> = {
  free: 1 * GIB,
  pro: 100 * GIB,
  team: 100 * GIB,
  enterprise: null,
  platform: null,
}

// Firestore has no per-collection quota API to read against. Keep the
// published free-plan figure only as a clearly labelled reference; it is not
// presented as the project's detected plan or current maximum.
const FIRESTORE_FREE_TIER_REFERENCE_BYTES = 1 * GIB

// Crossing this triggers the low-storage admin notification below. 85% is
// deliberately before the "stop admitting new uploads" thresholds elsewhere
// in this file (usageTone escalates at 80/95 in the UI) — the notification
// exists to give admins time to act before uploads actually start failing.
const LOW_STORAGE_WARNING_PERCENT = 85
const LOW_STORAGE_WARNING_COOLDOWN_HOURS = 6
const LOW_STORAGE_WARNING_MESSAGE =
  'Warning: Your Supabase storage is almost full. Please run a cleanup or switch to Force Firebase routing to prevent upload failures.'

const managementJson = async (path: string, token: string) => {
  const response = await fetch(`https://api.supabase.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`Supabase Management API returned ${response.status}`)
  return await response.json()
}

const getSupabasePlanInfo = async (supabaseUrl: string) => {
  const token = Deno.env.get('CARGOEXPRESS_SUPABASE_PAT')
  if (!token) throw new Error('Supabase Management API is not configured')
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]
  if (!projectRef) throw new Error('Could not identify Supabase project')

  const project = await managementJson(`/v1/projects/${encodeURIComponent(projectRef)}`, token)
  const organizationSlug = project.organization_slug
  if (!organizationSlug) throw new Error('Could not identify Supabase organization')

  const [organization, entitlements, storageConfig, projects] = await Promise.all([
    managementJson(`/v1/organizations/${encodeURIComponent(organizationSlug)}`, token),
    managementJson(`/v1/organizations/${encodeURIComponent(organizationSlug)}/entitlements`, token),
    managementJson(`/v1/projects/${encodeURIComponent(projectRef)}/config/storage`, token),
    managementJson(`/v1/organizations/${encodeURIComponent(organizationSlug)}/projects?limit=100&offset=0`, token),
  ])
  const plan = String(organization.plan || 'unknown').toLowerCase()
  const maxFileEntitlement = entitlements?.entitlements?.find(
    (item: Record<string, unknown>) => (item.feature as Record<string, unknown>)?.key === 'storage.max_file_size',
  )

  return {
    status: 'available',
    plan,
    included_storage_bytes: INCLUDED_STORAGE_BYTES_BY_PLAN[plan] ?? null,
    quota_type: INCLUDED_STORAGE_BYTES_BY_PLAN[plan] == null ? 'custom' : 'included',
    plan_max_file_size_bytes: maxFileEntitlement?.config?.value ?? null,
    configured_max_file_size_bytes: storageConfig?.fileSizeLimit ?? null,
    organization_project_count: Number(projects?.pagination?.count ?? projects?.projects?.length ?? 1),
  }
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
    Uint8Array.from(atob(pemContents), char => char.charCodeAt(0)),
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
  if (!response.ok) throw new Error('Firebase authentication failed')
  const data = await response.json()
  // Bug fix: this used to validate the token existed and then return
  // nothing, so every caller silently got `undefined` back. Harmless for the
  // old call site (it only cared whether auth succeeded, for the healthy/
  // unavailable badge) but fatal now that getFirestoreCollectionStats()
  // actually needs the token to call Firestore.
  if (!data.access_token) throw new Error('Firebase authentication failed')
  return data.access_token
}

// Document count + total stored bytes for a Firestore collection, via a
// server-side aggregation query — never lists/downloads documents, so this
// stays cheap and fast no matter how large photoFallbacks grows.
async function getFirestoreCollectionStats(serviceAccount: Record<string, string>, collectionId: string) {
  const accessToken = await getFirebaseAccessToken(serviceAccount)
  const projectId = serviceAccount.project_id
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runAggregationQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredAggregationQuery: {
          structuredQuery: { from: [{ collectionId }] },
          aggregations: [
            { alias: 'doc_count', count: {} },
            { alias: 'total_bytes', sum: { field: { fieldPath: 'size_bytes' } } },
          ],
        },
      }),
      signal: AbortSignal.timeout(8000),
    },
  )
  if (!response.ok) throw new Error(`Firestore aggregation query failed (${response.status})`)

  // Streamed as an array of partial results — summed rather than indexed by
  // [0], since a large collection can come back as more than one chunk.
  const rows = await response.json() as Array<{ result?: { aggregateFields?: Record<string, { integerValue?: string; doubleValue?: number }> } }>
  let documentCount = 0
  let totalBytes = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const fields = row.result?.aggregateFields
    if (!fields) continue
    documentCount += Number(fields.doc_count?.integerValue ?? 0)
    totalBytes += Number(fields.total_bytes?.integerValue ?? fields.total_bytes?.doubleValue ?? 0)
  }
  // Firestore stores each image as a base64 data URL. Base64 uses four bytes
  // for every three source bytes, plus the short data-URL prefix per photo.
  // Firestore's own record and index overhead is not available here, so this
  // value is deliberately reported as an estimate rather than an exact quota.
  const estimatedPhotoDataBytes = Math.ceil(totalBytes / 3) * 4
    + documentCount * 'data:image/jpeg;base64,'.length
  return {
    document_count: documentCount,
    source_image_bytes: totalBytes,
    estimated_photo_data_bytes: estimatedPhotoDataBytes,
  }
}

const loadFirebaseServiceAccount = (): Record<string, string> | null => {
  try {
    const b64 = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_B64')
    const raw = b64 ? atob(b64) : Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Fans a high-priority alert out to every admin once, then stays quiet for
// LOW_STORAGE_WARNING_COOLDOWN_HOURS — otherwise the scheduled check and the
// screen's refresh could re-fire it. serviceClient bypasses RLS, same as every other server-side
// write in this function family (record-photo-storage-event, etc.).
async function maybeNotifyAdminsOfLowStorage(serviceClient: ReturnType<typeof createClient>, usagePercent: number) {
  if (usagePercent < LOW_STORAGE_WARNING_PERCENT) return
  try {
    const cooldownSince = new Date(Date.now() - LOW_STORAGE_WARNING_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString()
    const { data: recent } = await serviceClient
      .from('notifications')
      .select('id')
      .eq('type', 'system_alert')
      .gte('created_at', cooldownSince)
      .limit(1)
    if (recent && recent.length > 0) return

    const { data: admins, error: adminsError } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
    if (adminsError || !admins || admins.length === 0) return

    await serviceClient.from('notifications').insert(admins.map((admin: { id: string }) => ({
      user_id: admin.id,
      title: 'Storage Warning',
      message: LOW_STORAGE_WARNING_MESSAGE,
      type: 'system_alert',
    })))
  } catch (error) {
    // Best-effort — a failed notification must never fail the health check itself.
    console.error('[photo-storage-health] Low storage notification failed:', error)
  }
}

const requireAdminOrScheduledCheck = async (authHeader: string) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const suppliedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  if (serviceRoleKey && suppliedToken === serviceRoleKey) {
    return { serviceClient, userClient: serviceClient }
  }
  const { data, error } = await userClient.auth.getUser()
  if (error || !data.user) throw new Response('Authentication required', { status: 401 })
  const { data: profile } = await serviceClient
    .from('profiles').select('role').eq('id', data.user.id).single()
  if (profile?.role !== 'admin') throw new Response('Admin access required', { status: 403 })
  return { serviceClient, userClient }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
    const { serviceClient, userClient } = await requireAdminOrScheduledCheck(authHeader)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''

    const firebaseServiceAccount = loadFirebaseServiceAccount()

    const [bucketResult, usageResult, planResult, firestoreStatsResult] = await Promise.allSettled([
      serviceClient.storage.getBucket('cargo-photos'),
      userClient.rpc('get_photo_storage_live_usage'),
      getSupabasePlanInfo(supabaseUrl),
      (async () => {
        if (!firebaseServiceAccount) throw new Error('Firebase is not configured')
        return await getFirestoreCollectionStats(firebaseServiceAccount, 'photoFallbacks')
      })(),
    ])

    const supabaseHealthy = bucketResult.status === 'fulfilled' && !bucketResult.value.error && Boolean(bucketResult.value.data)
    const firebaseHealthy = firestoreStatsResult.status === 'fulfilled'
    const liveUsage = usageResult.status === 'fulfilled' && !usageResult.value.error
      ? usageResult.value.data?.[0]
      : null
    const planInfo = planResult.status === 'fulfilled'
      ? planResult.value
      : { status: 'unavailable', plan: 'unknown', included_storage_bytes: null, quota_type: 'unknown' }
    const firestoreStats = firestoreStatsResult.status === 'fulfilled' ? firestoreStatsResult.value : null

    // Awaited (not fire-and-forget): an Edge Function's isolate can be torn
    // down as soon as the response is sent, so a detached promise here could
    // simply never finish. maybeNotifyAdminsOfLowStorage() already swallows
    // its own errors, so this can't fail the health check either way.
    const usedBytes = liveUsage?.total_size_bytes != null ? Number(liveUsage.total_size_bytes) : null
    const quotaBytes = planInfo?.included_storage_bytes != null ? Number(planInfo.included_storage_bytes) : null
    if (usedBytes != null && quotaBytes != null && quotaBytes > 0) {
      await maybeNotifyAdminsOfLowStorage(serviceClient, (usedBytes / quotaBytes) * 100)
    }

    return json({
      checked_at: new Date().toISOString(),
      supabase: {
        status: supabaseHealthy ? 'healthy' : 'unavailable',
        bucket_file_size_limit_bytes: bucketResult.status === 'fulfilled'
          ? bucketResult.value.data?.file_size_limit ?? null
          : null,
      },
      firebase: { status: firebaseHealthy ? 'healthy' : 'unavailable' },
      supabase_storage: {
        ...planInfo,
        live_usage_status: liveUsage ? 'available' : 'unavailable',
        total_size_bytes: liveUsage?.total_size_bytes ?? null,
        object_count: liveUsage?.object_count ?? null,
        buckets: liveUsage?.buckets ?? [],
        measured_at: liveUsage?.measured_at ?? null,
      },
      // Firebase does not expose a reliable live project limit here. Report
      // the app's estimated photo payload and keep the published free-plan
      // figure separate as a reference, never as a detected current quota.
      firebase_storage: {
        status: firestoreStats ? 'available' : 'unavailable',
        provider: 'firestore',
        collection: 'photoFallbacks',
        document_count: firestoreStats?.document_count ?? null,
        estimated_photo_data_bytes: firestoreStats?.estimated_photo_data_bytes ?? null,
        source_image_bytes: firestoreStats?.source_image_bytes ?? null,
        free_tier_reference_bytes: FIRESTORE_FREE_TIER_REFERENCE_BYTES,
        measurement_type: 'estimated_photo_payload',
        measured_at: firestoreStats ? new Date().toISOString() : null,
      },
    })
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status)
    return json({ error: 'Storage health check failed' }, 500)
  }
})
