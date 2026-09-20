// Public, narrowly scoped verification for the PayMongo return page.
//
// This function is intentionally anonymous at the gateway. The caller proves
// possession of a high-entropy return capability embedded in the PayMongo
// redirect URL. The raw capability is hashed before the service-role lookup;
// RLS stays closed to the public and the response contains only a status enum.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

const RETURN_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes))
  .map(byte => byte.toString(16).padStart(2, '0'))
  .join('')

const hashReturnToken = async (returnToken: string) => hex(await crypto.subtle.digest(
  'SHA-256',
  new TextEncoder().encode(returnToken),
))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
})

const serviceClient = () => {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceRoleKey)
}

const statusForAttempt = (attempt: any) => {
  if (!attempt) return 'invalid'

  const expiresAt = Date.parse(attempt.return_token_expires_at || '')
  if (Number.isFinite(expiresAt) && expiresAt < Date.now()) return 'invalid'

  // Only the backend's reconciled attempt with a real provider payment id is
  // success. A return URL query string or a PayMongo browser redirect alone is
  // never sufficient.
  if (attempt.status === 'reconciled' && attempt.payment_id && attempt.payment_status !== 'failed') {
    return 'confirmed'
  }
  if (attempt.status === 'failed' || ['failed', 'cancelled'].includes(attempt.payment_status)) {
    return 'failed'
  }
  return 'processing'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ status: 'invalid' }, 405)

  try {
    const body = await req.json()
    const returnToken = typeof body?.returnToken === 'string' ? body.returnToken.trim() : ''
    if (!RETURN_TOKEN.test(returnToken)) return json({ status: 'invalid' })

    const adminSupabase = serviceClient()
    const tokenHash = await hashReturnToken(returnToken)
    const { data: attempt, error } = await adminSupabase
      .from('payment_attempts')
      .select('status, payment_id, payment_status, return_token_expires_at')
      .eq('return_token_hash', tokenHash)
      .maybeSingle()

    if (error) {
      console.error('[verify-payment-return] Backend lookup failed')
      return json({ status: 'unavailable' }, 503)
    }

    return json({ status: statusForAttempt(attempt) })
  } catch {
    // Do not reflect database/provider details through this anonymous endpoint.
    return json({ status: 'unavailable' }, 503)
  }
})
