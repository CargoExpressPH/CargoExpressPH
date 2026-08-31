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
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single()
  if (profile?.role !== 'admin') throw new Response('Admin access required', { status: 403 })
  return { user: data.user, serviceClient }
}

const isPhotoType = (value: unknown) => ['pickup', 'delivery', 'receipt'].includes(String(value))
const isProvider = (value: unknown) => ['supabase', 'firebase'].includes(String(value))
const isOutcome = (value: unknown) => ['success', 'failure'].includes(String(value))

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
    const { user, serviceClient } = await requireAdmin(authHeader)
    const { provider, outcome, photo_type, order_id, storage_path, size_bytes, message } = await req.json()

    if (!isProvider(provider) || !isOutcome(outcome) || !isPhotoType(photo_type)) {
      return json({ error: 'Invalid storage event' }, 400)
    }
    if (typeof order_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(order_id)) {
      return json({ error: 'A valid order_id is required' }, 400)
    }
    if (storage_path != null && (typeof storage_path !== 'string' || storage_path.length > 500 || storage_path.startsWith('data:'))) {
      return json({ error: 'Invalid storage_path' }, 400)
    }
    if (message != null && (typeof message !== 'string' || message.length > 500 || message.startsWith('data:'))) {
      return json({ error: 'Invalid event message' }, 400)
    }
    if (size_bytes != null && (!Number.isSafeInteger(size_bytes) || size_bytes < 0)) {
      return json({ error: 'Invalid size_bytes' }, 400)
    }

    const { error } = await serviceClient.from('photo_storage_events').insert({
      event_type: 'upload',
      provider,
      outcome,
      photo_type,
      order_id,
      storage_path: storage_path || null,
      size_bytes: size_bytes ?? null,
      message: message || null,
      created_by: user.id,
    })
    if (error) return json({ error: 'Could not record storage event' }, 500)
    return json({ recorded: true })
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status)
    return json({ error: 'Unexpected storage event error' }, 500)
  }
})
