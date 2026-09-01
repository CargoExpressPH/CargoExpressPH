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

async function getFirebaseAccessToken(serviceAccount: Record<string, string>) {
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
  if (!data.access_token) throw new Error('Firebase authentication failed')
}

const requireAdmin = async (authHeader: string) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
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
    const { serviceClient, userClient } = await requireAdmin(authHeader)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''

    const [bucketResult, firebaseResult, usageResult, planResult] = await Promise.allSettled([
      serviceClient.storage.getBucket('cargo-photos'),
      (async () => {
        const b64 = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_B64')
        const raw = b64 ? atob(b64) : Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
        if (!raw) throw new Error('Firebase is not configured')
        await getFirebaseAccessToken(JSON.parse(raw))
      })(),
      userClient.rpc('get_photo_storage_live_usage'),
      getSupabasePlanInfo(supabaseUrl),
    ])

    const supabaseHealthy = bucketResult.status === 'fulfilled' && !bucketResult.value.error && Boolean(bucketResult.value.data)
    const firebaseHealthy = firebaseResult.status === 'fulfilled'
    const liveUsage = usageResult.status === 'fulfilled' && !usageResult.value.error
      ? usageResult.value.data?.[0]
      : null
    const planInfo = planResult.status === 'fulfilled'
      ? planResult.value
      : { status: 'unavailable', plan: 'unknown', included_storage_bytes: null, quota_type: 'unknown' }
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
    })
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status)
    return json({ error: 'Storage health check failed' }, 500)
  }
})
