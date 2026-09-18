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

// Mirrors src/utils/gcashReference.js and the equivalent checks in
// record_manual_refund() (20260919000000_manual_refund_reference_validation.sql)
// — kept in sync by hand across the three layers (browser, Edge Function,
// database) rather than shared code, since a Vite frontend module and a Deno
// Edge Function do not share a build step in this project. There is no
// single universal GCash reference format to enforce exactly (see that
// migration's header comment for the sources), so this checks structure and
// clearly-wrong values rather than one fixed length/pattern. Browser
// validation is a UX convenience only — this is the layer that actually
// matters, since nothing stops a request from arriving here without ever
// having gone through the browser form.
const EMAIL_PATTERN = /\S+@\S+\.\S+/
// Checked FIRST, before any digit-stripping — otherwise stripping
// non-digits from an alphanumeric value (e.g. a PayMongo id like
// "pay_9f8a7b6c5d4e3f2a1b0c") can coincidentally leave a 10-digit string
// starting with 9, which would misread as a phone number even though the
// original value plainly wasn't one.
const PHONE_SHAPED_PATTERN = /^[\d\s()+-]+$/
const PH_MOBILE_DIGITS_PATTERN = /^(?:63|0)?9\d{9}$/
const PAYMONGO_ID_PATTERN = /^(?:pay|ref|src|link|paym|pi|re|sub|cus|evt)_[A-Za-z0-9_-]+$/i

const gcashReferenceError = (value: string, originalReference: string | null): string | null => {
  if (!value) return 'Enter the reference number from the completed GCash transfer receipt'
  if (value.length < 4) return 'That reference looks too short'
  if (value.length > 255) return 'That reference is too long'
  if (EMAIL_PATTERN.test(value)) return 'That looks like an email address, not a GCash transfer reference'
  const digitsOnly = value.replace(/\D/g, '')
  if (PHONE_SHAPED_PATTERN.test(value) && PH_MOBILE_DIGITS_PATTERN.test(digitsOnly) && digitsOnly.length <= 12) {
    return 'That looks like a phone number, not a GCash transfer reference'
  }
  if (PAYMONGO_ID_PATTERN.test(value)) return 'That looks like an internal payment system ID, not a GCash transfer reference'
  if (originalReference && value.toLowerCase() === originalReference.trim().toLowerCase()) {
    return "That matches the original payment's own reference. Enter the reference of the NEW outgoing refund transfer."
  }
  if ((digitsOnly.match(/\d/g) || []).length < 4) {
    return 'Enter the reference number from the completed GCash transfer receipt'
  }
  return null
}

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
    if (returnMethod === 'gcash') {
      // Stateless format checks only (no original-payment-reference match
      // here — that needs a DB lookup this function doesn't otherwise make;
      // record_manual_refund() performs that specific check authoritatively
      // once it has the payment row loaded).
      const referenceError = gcashReferenceError(returnReference, null)
      if (referenceError) return json({ error: referenceError }, 400)
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

    // Clean up the throwaway verification session. Per the installed SDK
    // (GoTrueClient._signOut → GoTrueAdminApi.signOut):
    //   scope='local'  → POST /logout?scope=local  — the Auth server revokes
    //                    ONLY this session's refresh token, leaving every other
    //                    session for the same user (including the admin's real
    //                    browser session) intact. The client then removes its
    //                    own local storage entry (_removeSession).
    //   scope='global' → POST /logout?scope=global — revokes ALL sessions for
    //                    the user server-side, which is what the original
    //                    void signOut().catch() was doing and why the admin
    //                    was being logged out.
    // Note: if the project ever enables single-session enforcement in the
    // Supabase Dashboard (Auth → Advanced), the throwaway signInWithPassword
    // above creates a new token family that would itself displace the admin's
    // original session regardless of scope. That setting is UNKNOWN for this
    // project — verify in the Dashboard before deploying.
    const { error: cleanupError } = await verifyClient.auth.signOut({ scope: 'local' }).catch(
      (thrown: unknown) => ({ error: thrown })
    )
    if (cleanupError) {
      // Non-fatal: the refund has already been written (or idempotently
      // found). Logging the failure is enough — do not surface it to the
      // caller as a refund error, which would incorrectly suggest the
      // operation failed and invite a duplicate submission.
      console.error('[record-manual-refund] Non-fatal: could not clean up verification session')
    }

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
        || /email address/.test(recordError.message || '')
        || /phone number/.test(recordError.message || '')
        || /internal payment system ID/.test(recordError.message || '')
        || /own reference/.test(recordError.message || '')
        || /completed GCash transfer receipt/.test(recordError.message || '')
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
