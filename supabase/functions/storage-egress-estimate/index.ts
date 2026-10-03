import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const MAX_LOG_ROWS = 1000
const LOG_WINDOW_MS = 24 * 60 * 60 * 1000
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
})

type LogRow = { filepath?: unknown; cached?: unknown; num_requests?: unknown }
type ObjectSize = { bucket_id: string; name: string; size_bytes: number | string }

const storageObjectFromPath = (path: unknown) => {
  if (typeof path !== 'string') return null
  const match = path.split('?')[0].match(/(?:^|\/)storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/)
  if (!match) return null
  try {
    return { bucket_id: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) }
  } catch {
    return null
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const token = Deno.env.get('CARGOEXPRESS_SUPABASE_PAT') || ''
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'Monitoring is unavailable' }, 503)

  try {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: authData, error: authError } = await userClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Authentication required' }, 401)
    const serviceClient = createClient(supabaseUrl, serviceRoleKey)
    const { data: profile, error: profileError } = await serviceClient.from('profiles')
      .select('role').eq('id', authData.user.id).single()
    if (profileError || profile?.role !== 'admin') return json({ error: 'Admin access required' }, 403)
    if (!token) return json({ error: 'Storage egress estimate is unavailable' }, 503)

    const projectRef = new URL(supabaseUrl).hostname.split('.')[0]
    const end = new Date()
    const start = new Date(end.getTime() - LOG_WINDOW_MS)
    // The same request-count method documented by Supabase for Storage
    // bandwidth. A bounded, on-demand query avoids continuous log rescans.
    const sql = `select log_attributes['request.path'] as filepath,
      (log_attributes['response.headers.cf_cache_status'] = 'HIT') as cached,
      count() as num_requests
      from logs
      where source = 'edge_logs'
        and log_attributes['request.path'] like '%storage/v1/object/%'
        and log_attributes['request.method'] = 'GET'
        and toInt32OrZero(log_attributes['response.status_code']) = 200
      group by filepath, cached
      order by num_requests desc
      limit ${MAX_LOG_ROWS + 1}`
    const params = new URLSearchParams({
      sql,
      iso_timestamp_start: start.toISOString(),
      iso_timestamp_end: end.toISOString(),
    })
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/analytics/endpoints/logs?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      },
    )
    if (!response.ok) throw new Error(`Supabase logs query returned ${response.status}`)
    const body = await response.json()
    if (body.error || !Array.isArray(body.result)) throw new Error('Supabase logs query failed')

    const logRows = (body.result as LogRow[]).slice(0, MAX_LOG_ROWS)
    const truncated = body.result.length > MAX_LOG_ROWS
    const objects = new Map<string, { bucket_id: string; name: string }>()
    const requests: Array<{ key: string | null; count: number; cached: boolean }> = []
    for (const row of logRows) {
      const count = Number(row.num_requests)
      if (!Number.isSafeInteger(count) || count < 1) continue
      const object = storageObjectFromPath(row.filepath)
      const key = object ? `${object.bucket_id}\u0000${object.name}` : null
      if (object && key) objects.set(key, object)
      requests.push({ key, count, cached: row.cached === 1 || row.cached === true || row.cached === '1' })
    }

    const { data: sizes, error: sizesError } = await serviceClient.rpc('get_storage_object_sizes_for_egress', {
      p_objects: [...objects.values()],
    })
    if (sizesError) throw sizesError
    const sizeByKey = new Map((sizes as ObjectSize[] || []).map((item) => [
      `${item.bucket_id}\u0000${item.name}`, Number(item.size_bytes),
    ]))
    let cachedBytes = 0
    let uncachedBytes = 0
    let matchedRequests = 0
    let unmatchedRequests = 0
    for (const request of requests) {
      const size = request.key ? sizeByKey.get(request.key) : undefined
      if (size == null || !Number.isFinite(size) || size < 0) {
        unmatchedRequests += request.count
        continue
      }
      if (request.cached) cachedBytes += size * request.count
      else uncachedBytes += size * request.count
      matchedRequests += request.count
    }

    return json({
      status: 'available',
      measured_at: new Date().toISOString(),
      window_start: start.toISOString(),
      window_end: end.toISOString(),
      cached_estimated_bytes: cachedBytes,
      uncached_estimated_bytes: uncachedBytes,
      matched_requests: matchedRequests,
      unmatched_requests: unmatchedRequests,
      truncated,
      sample_limit: MAX_LOG_ROWS,
    })
  } catch (error) {
    console.error('[storage-egress-estimate] Failed to estimate storage traffic:', error)
    return json({ error: 'Storage egress estimate is unavailable' }, 503)
  }
})
