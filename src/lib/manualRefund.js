import { supabase } from './supabase';

/**
 * Record that a Cash or manual-GCash payment was already physically
 * returned to a customer. This does not move money and never talks to
 * PayMongo — it exists only for the two payment methods PayMongo has no
 * record of at all (see supabase/functions/record-manual-refund and
 * supabase/migrations/20260918020000_manual_refund_recording.sql).
 *
 * The admin's password is sent once, over HTTPS, straight to the Edge
 * Function, which verifies it against Supabase Auth itself and never
 * returns or logs it. This client function never sees the verification
 * result of that check beyond success/failure — it has no independent way
 * to bypass it.
 */
export const recordManualRefund = async ({
  paymentTransactionId,
  amount,
  reason,
  notes = '',
  returnMethod,
  returnReference = '',
  returnedAt = null,
  confirmedReturned,
  password,
  idempotencyKey,
}) => {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!accessToken || !supabaseUrl || !anonKey) {
    throw new Error('Your admin session is unavailable. Sign in again and retry.');
  }

  let response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/record-manual-refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        paymentTransactionId,
        amount,
        reason,
        notes,
        returnMethod,
        returnReference,
        returnedAt,
        confirmedReturned,
        password,
        idempotencyKey,
      }),
    });
  } catch {
    throw new Error('Could not reach the server to record this refund. Check your connection and try again — do not retry blindly, since the request may have already gone through.');
  }

  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const error = new Error(body?.error || `Manual refund could not be recorded (${response.status}).`);
    error.status = response.status;
    error.lockedUntil = body?.lockedUntil || null;
    error.isLocked = response.status === 429;
    error.isPasswordError = response.status === 401;
    throw error;
  }
  return body || {};
};
