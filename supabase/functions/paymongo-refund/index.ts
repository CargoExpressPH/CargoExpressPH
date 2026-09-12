// Supabase Edge Function: paymongo-refund
// Admin-only creation of full or partial refunds for verified PayMongo
// payments. The database reserves the amount before the provider request and
// the signed webhook remains the final reconciliation authority.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROVIDER_TIMEOUT_MS = 15_000
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

const providerError = (payload: any) => {
  const item = Array.isArray(payload?.errors) ? payload.errors[0] : null
  return {
    code: typeof item?.code === 'string' ? item.code : null,
    detail: typeof item?.detail === 'string' ? item.detail : 'PayMongo could not create the refund.',
  }
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

    if (!reservation?.created) {
      return json({
        success: reservation?.status === 'succeeded',
        duplicate: true,
        refundId: reservation?.refund_id || null,
        status: reservation?.status || 'processing',
        amount: Number(reservation?.amount || amount),
        message: reservation?.status === 'failed'
          ? 'This refund request already failed. Close this window and start a new refund.'
          : 'This refund request is already being processed.',
      }, reservation?.status === 'failed' ? 409 : 200)
    }

    let response: Response
    try {
      response = await fetch('https://api.paymongo.com/v1/refunds', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': paymongoAuthHeader(),
        },
        body: JSON.stringify({
          data: {
            attributes: {
              amount: Math.round(amount * 100),
              payment_id: reservation.payment_id,
              reason,
              ...(notes ? { notes } : {}),
            },
          },
        }),
      })
    } catch {
      await adminSupabase.rpc('mark_paymongo_refund_request', {
        p_idempotency_key: idempotencyKey,
        p_status: 'processing',
        p_error: 'Provider request timed out; awaiting signed webhook reconciliation',
      })
      return json({
        success: false,
        status: 'processing',
        outcomeUnknown: true,
        amount,
        message: 'PayMongo did not answer in time. Do not submit another refund; this request will be reconciled automatically.',
      }, 202)
    }

    let providerBody: any = null
    try { providerBody = await response.json() } catch { providerBody = null }

    if (!response.ok) {
      const failure = providerError(providerBody)
      await adminSupabase.rpc('mark_paymongo_refund_request', {
        p_idempotency_key: idempotencyKey,
        p_status: 'failed',
        p_error: `${failure.code || 'provider_error'}: ${failure.detail}`,
      })
      const sourceTypeUnsupported = /source type/i.test(failure.detail)
      return json({
        error: sourceTypeUnsupported
          ? 'PayMongo does not allow API refunds for this legacy Source payment. Refund it from the PayMongo dashboard; the webhook will still reconcile it here.'
          : failure.detail,
        code: failure.code,
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
      p_amount: refundAmount || amount,
      p_status: status,
      p_reason: attributes.reason || reason,
      p_notes: attributes.notes || notes || null,
      p_livemode: typeof attributes.livemode === 'boolean' ? attributes.livemode : null,
      p_event_id: null,
      p_provider_created_at: providerTimestamp(attributes.created_at),
      p_provider_updated_at: providerTimestamp(attributes.updated_at),
      p_idempotency_key: idempotencyKey,
    })
    if (reconcileError || !reconciled?.linked) {
      console.error('[paymongo-refund] Provider refund created but local reconciliation failed')
      return json({
        success: false,
        refundId: resource?.id || null,
        status,
        amount: refundAmount || amount,
        message: 'PayMongo accepted the refund. Local history is still reconciling from the signed webhook.',
      }, 202)
    }

    return json({
      success: status === 'succeeded',
      refundId: resource.id,
      status,
      amount: refundAmount || amount,
      message: status === 'succeeded'
        ? 'Refund completed and the order ledger was updated.'
        : 'Refund submitted to PayMongo and is awaiting completion.',
    }, status === 'succeeded' ? 200 : 202)
  } catch {
    console.error('[paymongo-refund] Refund processing failed')
    return json({ error: 'Refund processing failed unexpectedly.' }, 500)
  }
})
