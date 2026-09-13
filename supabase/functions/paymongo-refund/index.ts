// Supabase Edge Function: paymongo-refund
// Admin-only creation of full or partial refunds for verified PayMongo
// payments. The database reserves the amount before the provider request and
// the signed webhook remains the final reconciliation authority.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { postPayMongoRefund, providerError } from './provider.js'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROVIDER_TIMEOUT_MS = 15_000
const PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000
const MAX_BODY_BYTES = 32 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REFUND_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer', 'others'])

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
})

const serviceClient = () => {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', key)
}

const paymongoAuthHeader = () => {
  const key = Deno.env.get('PAYMONGO_SECRET_KEY')
  if (!key) throw new Error('PAYMONGO_SECRET_KEY is not configured')
  return `Basic ${btoa(`${key}:`)}`
}

const providerTimestamp = (value: unknown) => {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

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

    const userSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: userData, error: userError } = await userSupabase.auth.getUser()
    if (userError || !userData.user) return json({ error: 'Authentication required' }, 401)

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

    if (!UUID.test(paymentTransactionId || '') || !UUID.test(idempotencyKey || '')) {
      return json({ error: 'Valid payment and idempotency identifiers are required' }, 400)
    }
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
      return json({ error: 'Refund amount must be greater than zero with at most two decimal places' }, 400)
    }
    if (!REFUND_REASONS.has(reason)) return json({ error: 'Select a valid refund reason' }, 400)
    if (notes.length > 255) return json({ error: 'Refund notes must be 255 characters or fewer' }, 400)

    const adminSupabase = serviceClient()
    const { data: reservation, error: prepareError } = await adminSupabase.rpc('prepare_paymongo_refund', {
      p_payment_transaction_id: paymentTransactionId,
      p_amount: amount,
      p_reason: reason,
      p_notes: notes || null,
      p_idempotency_key: idempotencyKey,
      p_initiated_by: userData.user.id,
    })
    if (prepareError) {
      const safeMessage = prepareError.message?.includes('remaining refundable amount')
        ? prepareError.message
        : prepareError.message?.includes('Only a verified PayMongo')
          ? prepareError.message
          : 'This refund could not be reserved. Refresh the order and try again.'
      return json({ error: safeMessage }, 409)
    }

    const reservationStatus = String(reservation?.status || 'processing').toLowerCase()
    const canRetryUnresolvedRequest = !reservation?.created
      && ['creating', 'processing'].includes(reservationStatus)
      && !reservation?.refund_id

    if (!reservation?.created && !canRetryUnresolvedRequest) {
      const duplicateMessage = reservationStatus === 'succeeded'
        ? 'Refund completed. PayMongo already confirmed it as succeeded, and the order ledger is reconciled.'
        : reservationStatus === 'failed'
          ? 'This refund request failed. No refund amount was deducted from the order’s collected total.'
          : reservationStatus === 'pending'
            ? 'PayMongo received this refund request. It is pending and has not completed yet.'
            : 'PayMongo is processing this refund request. It has not completed yet.'
      return json({
        success: reservationStatus === 'succeeded',
        duplicate: true,
        refundId: reservation?.refund_id || null,
        status: reservationStatus,
        amount: Number(reservation?.amount || amount),
        ledgerReconciled: reservationStatus === 'succeeded',
        message: duplicateMessage,
      }, reservationStatus === 'failed' ? 409 : 200)
    }

    if (canRetryUnresolvedRequest) {
      const reservedAt = Date.parse(String(reservation?.created_at || ''))
      const reservationAge = Date.now() - reservedAt
      if (!Number.isFinite(reservedAt)
        || reservationAge < 0
        || reservationAge >= PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS) {
        return json({
          error: 'This protected refund request is outside PayMongo\'s safe retry window and cannot be safely resubmitted. Do not create another refund; automatic recovery will continue checking its provider status.',
          status: reservationStatus,
          manualReviewRequired: true,
          ledgerReconciled: false,
        }, 409)
      }
    }

    // Retry from the database reservation, not mutable browser input. This
    // guarantees the exact same PayMongo request is paired with the same key.
    const reservedAmount = Number(reservation?.amount || amount)
    const reservedReason = String(reservation?.reason || reason)
    const reservedNotes = typeof reservation?.notes === 'string' ? reservation.notes : ''
    const reservedIdempotencyKey = String(reservation?.idempotency_key || idempotencyKey)

    const providerResult = await postPayMongoRefund({
      authorization: paymongoAuthHeader(),
      idempotencyKey: reservedIdempotencyKey,
      paymentId: reservation.payment_id,
      amount: reservedAmount,
      reason: reservedReason,
      notes: reservedNotes,
      timeoutMs: PROVIDER_TIMEOUT_MS,
    })
    const { response, providerBody, outcomeUnknown } = providerResult

    if (outcomeUnknown || !response) {
      await adminSupabase.rpc('mark_paymongo_refund_uncertain', {
        p_idempotency_key: reservedIdempotencyKey,
        p_error: 'Provider outcome unknown after safe idempotent retry; awaiting reconciliation',
      })
      return json({
        success: false,
        status: 'uncertain',
        outcomeUnknown: true,
        ledgerReconciled: false,
        amount: reservedAmount,
        message: 'PayMongo has not confirmed the refund outcome. Do not create another refund. Automatic recovery will check this protected request, or you can retry the same request below.',
      }, 202)
    }

    if (!response.ok) {
      const failure = providerError(providerBody)
      await adminSupabase.rpc('mark_paymongo_refund_failed', {
        p_idempotency_key: reservedIdempotencyKey,
        p_error: `${failure.code || 'provider_error'}: ${failure.detail}`,
        p_public_error: failure.publicMessage,
      })
      const sourceTypeUnsupported = /source type/i.test(failure.detail)
      return json({
        error: sourceTypeUnsupported
          ? 'This older GCash payment cannot be refunded automatically. Create the refund in the PayMongo Dashboard; CargoExpress will reconcile it automatically.'
          : failure.publicMessage,
        status: 'failed',
        ledgerReconciled: false,
      }, response.status >= 400 && response.status < 500 ? 422 : 502)
    }

    const resource = providerBody?.data
    const attributes = resource?.attributes || {}
    const rawStatus = String(attributes.status || 'pending').toLowerCase()
    const status = ['pending', 'processing', 'succeeded', 'failed'].includes(rawStatus) ? rawStatus : 'pending'
    const refundAmount = Number(attributes.amount || 0) / 100

    const { data: reconciled, error: reconcileError } = await adminSupabase.rpc('reconcile_paymongo_refund', {
      p_refund_id: resource?.id,
      p_payment_id: attributes.payment_id || reservation.payment_id,
      p_amount: refundAmount || reservedAmount,
      p_status: status,
      p_reason: attributes.reason || reservedReason,
      p_notes: attributes.notes || reservedNotes || null,
      p_livemode: typeof attributes.livemode === 'boolean' ? attributes.livemode : null,
      p_event_id: null,
      p_provider_created_at: providerTimestamp(attributes.created_at),
      p_provider_updated_at: providerTimestamp(attributes.updated_at),
      p_idempotency_key: reservedIdempotencyKey,
    })
    if (reconcileError || !reconciled?.linked) {
      console.error('[paymongo-refund] Provider refund created but local reconciliation failed')
      return json({
        success: false,
        refundId: resource?.id || null,
        status,
        ledgerReconciled: false,
        amount: refundAmount || reservedAmount,
        message: status === 'succeeded'
          ? 'PayMongo reports the refund as succeeded, but CargoExpress has not yet reconciled the order ledger. Automatic recovery will keep checking; do not submit another refund.'
          : 'PayMongo accepted the refund request, but CargoExpress is still reconciling its status. It is not shown as completed; do not submit another refund.',
      }, 202)
    }

    return json({
      success: status === 'succeeded',
      refundId: resource.id,
      status,
      ledgerReconciled: true,
      amount: refundAmount || reservedAmount,
      message: status === 'succeeded'
        ? 'Refund completed. PayMongo confirmed it as succeeded, and the order’s financial totals were updated. Posting to the original GCash account may take additional time.'
        : status === 'failed'
          ? 'PayMongo could not complete the refund. No refund amount was deducted from the order’s collected total.'
        : status === 'processing'
          ? 'PayMongo is processing the refund. It has not completed yet; CargoExpress will update it automatically.'
          : 'PayMongo received the refund request. It is pending and has not completed yet; CargoExpress will update it automatically.',
    }, status === 'succeeded' ? 200 : 202)
  } catch {
    console.error('[paymongo-refund] Refund processing failed')
    return json({ error: 'Refund processing failed unexpectedly.' }, 500)
  }
})
