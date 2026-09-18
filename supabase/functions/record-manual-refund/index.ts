// Supabase Edge Function: record-manual-refund
//
// Records that a Cash or manual-GCash payment was already physically
// returned to a customer — it does not move money, and it does not talk to
// PayMongo (there is nothing for PayMongo to refund; it has no record of
// either payment type). It exists only so these two payment methods stop
// permanently inflating their sales totals in every report after a
// cancellation is manually refunded.
//
// SECURITY DESIGN — why this lives in an Edge Function and not purely in the
// database:
//   Postgres has no access to Supabase Auth's password hashes, and reading
//   auth.users directly to compare a hash would be exactly the "elevated
//   privileges, read the hash yourself" shortcut this feature must avoid.
//   The only correct way to verify a password against Supabase Auth is to
//   ask Supabase Auth itself — `signInWithPassword`. That call happens here,
//   server-side, using a throwaway client scoped to this single request. It
//   never touches the admin's own browser session (a different client
//   instance, never returned to the browser), so their existing session is
//   preserved untouched.
//
//   The database write (record_manual_refund) is reachable only by
//   service_role (see the REVOKE/GRANT at the end of
//   20260918020000_manual_refund_recording.sql) — an authenticated browser
//   session cannot call it directly and skip straight to the write, no
//   matter what it sends. This function is the only path in.
//
//   initiated_by on the resulting refund row, and admin_id on its
//   activity_logs entry, are always this function's OWN verified
//   `userData.user.id` — never anything read from the request body. The RPC
//   re-checks that id is really an admin, independently, before it accepts
//   it (see record_manual_refund's own comment).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_BODY_BYTES = 8 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REFUND_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer', 'others'])
const RETURN_METHODS = new Set(['cash', 'gcash'])

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
})

const serviceClient = () => {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', key)
}

// A throwaway client, never reused, never exposing its session to the
// browser. Verifying a password this way is the whole point: it is a real
// Supabase Auth check, not a comparison this code performs itself.
const passwordVerificationClient = () => createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_ANON_KEY') ?? '',
)

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const declaredLength = Number(req.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ error: 'Request is too large' }, 413)
    }

    // Step 1: who is calling, per their own JWT — never trusted from the body.
    const userSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: userData, error: userError } = await userSupabase.auth.getUser()
    if (userError || !userData.user) return json({ error: 'Authentication required' }, 401)
    if (!userData.user.email) return json({ error: 'This account has no password-based login and cannot use manual refund recording.' }, 403)

    const { data: profile } = await userSupabase
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .maybeSingle()
    if (profile?.role !== 'admin') return json({ error: 'Admin access required' }, 403)

    let body: any
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid JSON request' }, 400)
    }

    const paymentTransactionId = body?.paymentTransactionId
    const idempotencyKey = body?.idempotencyKey
    const amount = Number(body?.amount)
    const reason = typeof body?.reason === 'string' ? body.reason.trim().toLowerCase() : ''
    const notes = typeof body?.notes === 'string' ? body.notes.trim() : ''
    const returnMethod = typeof body?.returnMethod === 'string' ? body.returnMethod.trim().toLowerCase() : ''
    const returnReference = typeof body?.returnReference === 'string' ? body.returnReference.trim() : ''
    const returnedAt = typeof body?.returnedAt === 'string' ? body.returnedAt : null
    const confirmedReturned = body?.confirmedReturned === true
    // The password itself: read once, used once, never logged, never placed
    // in any response, never persisted anywhere (not even transiently in a
    // variable that outlives this request).
    const password = typeof body?.password === 'string' ? body.password : ''

    if (!UUID.test(paymentTransactionId || '') || !UUID.test(idempotencyKey || '')) {
      return json({ error: 'Valid payment and idempotency identifiers are required' }, 400)
    }
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
      return json({ error: 'Refund amount must be greater than zero with at most two decimal places' }, 400)
    }
    if (!REFUND_REASONS.has(reason)) return json({ error: 'Select a valid refund reason' }, 400)
    if (notes.length > 255) return json({ error: 'Notes must be 255 characters or fewer' }, 400)
    if (!RETURN_METHODS.has(returnMethod)) return json({ error: 'Select how the money was actually returned: Cash or GCash' }, 400)
    if (returnMethod === 'gcash' && returnReference.length < 4) {
      return json({ error: 'Enter the GCash transfer reference for this return' }, 400)
    }
    if (returnMethod === 'cash' && notes.length < 5) {
      return json({ error: 'Enter a short acknowledgement note for this cash return' }, 400)
    }
    if (!confirmedReturned) {
      return json({ error: 'Confirm that the money has already been returned to the customer before recording it' }, 400)
    }
    if (!password) return json({ error: 'Enter your account password to confirm this action' }, 400)

    const adminSupabase = serviceClient()

    // Step 2: rate limit BEFORE spending a real password attempt against
    // Supabase Auth — an admin already locked out gets told so immediately,
    // without this function making another guess on their behalf.
    const { data: lockoutState, error: lockoutError } = await adminSupabase.rpc('check_manual_refund_reauth_lockout', {
      p_admin_id: userData.user.id,
    })
    if (lockoutError) {
      console.error('[record-manual-refund] Lockout check failed')
      return json({ error: 'Could not verify re-authentication status. Try again shortly.' }, 500)
    }
    if (lockoutState?.locked) {
      return json({
        error: 'Too many incorrect password attempts. Try again later.',
        lockedUntil: lockoutState.locked_until,
      }, 429)
    }

    // Step 3: the actual password check — a real call to Supabase Auth, in
    // a throwaway client whose session is discarded when this request ends.
    const verifyClient = passwordVerificationClient()
    const { data: signInData, error: signInError } = await verifyClient.auth.signInWithPassword({
      email: userData.user.email,
      password,
    })

    // The verified identity must be the SAME identity that presented the
    // original bearer token — closes any path where a mismatched email
    // could verify a different account's password and still attribute the
    // refund to the original caller.
    const verified = !signInError && signInData?.user?.id === userData.user.id

    const { data: attemptState, error: attemptError } = await adminSupabase.rpc('record_manual_refund_reauth_attempt', {
      p_admin_id: userData.user.id,
      p_success: verified,
    })
    if (attemptError) {
      console.error('[record-manual-refund] Failed to record re-authentication attempt')
    }

    // Always sign the throwaway verification session back out — it is not
    // needed after this check, and there is no reason to leave a live
    // session sitting in memory past the moment it was used.
    void verifyClient.auth.signOut().catch(() => {})

    if (!verified) {
      const nowLocked = attemptState?.locked === true
      return json({
        error: nowLocked
          ? 'Incorrect password. Too many incorrect attempts — re-authentication is now temporarily locked.'
          : 'Incorrect password.',
        lockedUntil: nowLocked ? attemptState?.locked_until : null,
      }, 401)
    }

    // Step 4: the actual write. p_admin_id is userData.user.id — the
    // identity this function itself resolved from the bearer token AND just
    // re-verified with a real password check. Nothing here comes from the
    // request body.
    const { data: result, error: recordError } = await adminSupabase.rpc('record_manual_refund', {
      p_payment_transaction_id: paymentTransactionId,
      p_amount: amount,
      p_reason: reason,
      p_notes: notes || null,
      p_return_method: returnMethod,
      p_return_reference: returnMethod === 'gcash' ? returnReference : null,
      p_returned_at: returnedAt,
      p_idempotency_key: idempotencyKey,
      p_admin_id: userData.user.id,
    })
    if (recordError) {
      const safeMessage = /remaining refundable amount/.test(recordError.message || '')
        || /Use the provider refund instead/.test(recordError.message || '')
        || /acknowledgement note is required/.test(recordError.message || '')
        || /transfer reference is required/.test(recordError.message || '')
        || /Only a paid or partially paid/.test(recordError.message || '')
        ? recordError.message
        : 'This manual refund could not be recorded. Refresh the order and try again.'
      return json({ error: safeMessage }, 409)
    }

    return json({
      success: true,
      created: result?.created === true,
      id: result?.id,
      amount: Number(result?.amount ?? amount),
      status: result?.status,
      returnMethod: result?.return_method,
      succeededAt: result?.succeeded_at,
      message: result?.created === false
        ? 'This manual refund was already recorded (safe retry of the same request).'
        : 'Manual refund recorded. Remember: this only updates CargoExpress\'s records — the money must already have been handed back.',
    }, 200)
  } catch (error) {
    console.error('[record-manual-refund] Unexpected failure')
    return json({ error: 'Manual refund recording failed unexpectedly.' }, 500)
  }
})
