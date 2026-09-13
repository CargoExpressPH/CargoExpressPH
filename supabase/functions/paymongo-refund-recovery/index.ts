// Supabase Edge Function: paymongo-refund-recovery
// Independent reconciliation path for missed refund webhooks. The worker:
//   1. lists every provider refund for each due PayMongo payment,
//   2. idempotently reconciles those resources through the same ledger RPC,
//   3. safely replays only unresolved app requests using their original UUID,
//   4. never creates a new logical refund request.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import {
  listPayMongoRefunds,
  postPayMongoRefund,
  providerError,
  retrievePayMongoPaymentMode,
  sanitizeDiagnosticText,
} from './provider.js'

const MAX_BODY_BYTES = 8 * 1024
const MAX_JOBS = 25
const DEFAULT_JOBS = 15
const JOB_CONCURRENCY = 5
const PROVIDER_TIMEOUT_MS = 12_000
const MIN_AUTOMATIC_RETRY_AGE_MS = 2 * 60 * 1000
const PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAYMENT_ID = /^pay_[A-Za-z0-9_-]{4,128}$/
const REFUND_ID = /^ref_[A-Za-z0-9_-]{4,128}$/
const REFUND_STATUSES = new Set(['pending', 'processing', 'succeeded', 'failed'])
const REFUND_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer', 'others'])

type RecoveryJob = {
  payment_transaction_id: string
  payment_id: string
  claim_token: string
  livemode: boolean | null
}

type RefundReservation = {
  idempotency_key: string | null
  amount: number | string
  reason: string
  notes: string | null
  status: string
  refund_id: string | null
  created_at: string
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let result = 0
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return result === 0
}

const serviceClient = () => {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceRoleKey)
}

const paymongoConfiguration = () => {
  const key = Deno.env.get('PAYMONGO_SECRET_KEY')
  if (!key) throw new Error('PAYMONGO_SECRET_KEY is not configured')
  if (!key.startsWith('sk_test_') && !key.startsWith('sk_live_')) {
    throw new Error('PAYMONGO_SECRET_KEY does not identify test or live mode')
  }
  return {
    authorization: `Basic ${btoa(`${key}:`)}`,
    livemode: key.startsWith('sk_live_'),
  }
}

const providerTimestamp = (value: unknown) => {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

const recoveryDiagnostic = (error: unknown, stage: string) => {
  const candidate = error as { message?: unknown; code?: unknown; status?: unknown } | null
  const message = sanitizeDiagnosticText(
    candidate?.message || (typeof error === 'string' ? error : ''),
    'Unexpected non-error failure',
  )
  const code = typeof candidate?.code === 'string'
    ? candidate.code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)
    : null
  const status = Number.isInteger(candidate?.status) ? candidate?.status : null
  return `${stage}${code ? ` [${code}]` : ''}${status ? ` HTTP ${status}` : ''}: ${message}`
}

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
) => {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        results[index] = await worker(items[index])
      }
    },
  )
  await Promise.all(runners)
  return results
}

const normalizeRefund = (resource: any, expectedPaymentId: string) => {
  const attributes = resource?.attributes || {}
  const amountCents = Number(attributes.amount)
  const paymentId = String(attributes.payment_id || '')
  const rawStatus = String(attributes.status || '').toLowerCase()
  const rawReason = String(attributes.reason || 'others').toLowerCase()

  if (!REFUND_ID.test(String(resource?.id || ''))
      || paymentId !== expectedPaymentId
      || !Number.isInteger(amountCents)
      || amountCents <= 0
      || (attributes.currency && attributes.currency !== 'PHP')) {
    throw new Error('PayMongo returned a refund that did not match its payment')
  }

  return {
    refundId: resource.id as string,
    paymentId,
    amount: amountCents / 100,
    status: REFUND_STATUSES.has(rawStatus) ? rawStatus : 'pending',
    reason: REFUND_REASONS.has(rawReason) ? rawReason : 'others',
    notes: typeof attributes.notes === 'string' ? attributes.notes : null,
    livemode: typeof attributes.livemode === 'boolean' ? attributes.livemode : null,
    providerCreatedAt: providerTimestamp(attributes.created_at),
    providerUpdatedAt: providerTimestamp(attributes.updated_at),
  }
}

serve(async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const expectedAuthorization = `Bearer ${serviceRoleKey}`
    const suppliedAuthorization = req.headers.get('Authorization') || ''
    if (!serviceRoleKey || !timingSafeEqual(suppliedAuthorization, expectedAuthorization)) {
      return json({ error: 'Service authentication required' }, 401)
    }

    const declaredLength = Number(req.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ error: 'Request is too large' }, 413)
    }

    let body: Record<string, unknown> = {}
    try { body = await req.json() } catch { body = {} }
    const requestedLimit = Number(body.limit)
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_JOBS)
      : DEFAULT_JOBS

    const adminSupabase = serviceClient()
    const paymongo = paymongoConfiguration()
    const { data: jobs, error: claimError } = await adminSupabase.rpc(
      'claim_paymongo_refund_recovery_jobs',
      { p_limit: limit, p_livemode: paymongo.livemode },
    )
    if (claimError) throw claimError

    const results = await mapWithConcurrency(
      (jobs || []) as RecoveryJob[],
      JOB_CONCURRENCY,
      async job => {
        let providerRefundCount = 0
        let stage = 'validate_job'

        try {
          if (!UUID.test(job.payment_transaction_id)
              || !UUID.test(job.claim_token)
              || !PAYMENT_ID.test(job.payment_id)) {
            throw new Error('Recovery queue returned an invalid job')
          }

          if (job.livemode === null) {
            stage = 'verify_payment_mode'
            const verifiedMode = await retrievePayMongoPaymentMode({
              authorization: paymongo.authorization,
              paymentId: job.payment_id,
              timeoutMs: PROVIDER_TIMEOUT_MS,
            })
            if (verifiedMode !== paymongo.livemode) {
              throw new Error('PayMongo payment belongs to a different API mode')
            }
          }

          // The list endpoint discovers both webhook-missed app refunds and
          // refunds created directly in PayMongo Dashboard.
          stage = 'list_provider_refunds'
          const providerRefunds = await listPayMongoRefunds({
            authorization: paymongo.authorization,
            paymentId: job.payment_id,
            timeoutMs: PROVIDER_TIMEOUT_MS,
          })
          providerRefundCount = providerRefunds.length

          stage = 'reconcile_provider_refunds'
          for (const resource of providerRefunds) {
            const refund = normalizeRefund(resource, job.payment_id)
            if (refund.livemode !== null && refund.livemode !== paymongo.livemode) {
              throw new Error('PayMongo refund belongs to a different API mode')
            }
            const { data, error } = await adminSupabase.rpc('reconcile_paymongo_refund', {
              p_refund_id: refund.refundId,
              p_payment_id: refund.paymentId,
              p_amount: refund.amount,
              p_status: refund.status,
              p_reason: refund.reason,
              p_notes: refund.notes,
              p_livemode: refund.livemode,
              p_event_id: null,
              p_provider_created_at: refund.providerCreatedAt,
              p_provider_updated_at: refund.providerUpdatedAt,
              p_idempotency_key: null,
            })
            if (error || !data?.linked) {
              throw error || new Error('Provider refund could not be linked to its payment')
            }
          }

          // Reload after list reconciliation. If PayMongo already accepted an
          // uncertain app request, the provider resource above attached to the
          // reservation and it will not be replayed here.
          stage = 'load_local_reservations'
          const { data: unresolvedRows, error: unresolvedError } = await adminSupabase
            .from('payment_refunds')
            .select('idempotency_key, amount, reason, notes, status, refund_id, created_at')
            .eq('payment_transaction_id', job.payment_transaction_id)
            .in('status', ['creating', 'processing'])
            .is('refund_id', null)
          if (unresolvedError) throw unresolvedError

          for (const reservation of (unresolvedRows || []) as RefundReservation[]) {
            stage = 'retry_protected_request'
            if (!reservation.idempotency_key || !UUID.test(reservation.idempotency_key)) {
              throw new Error('Unresolved refund is missing its protected idempotency key')
            }

            const reservationAge = Date.now() - Date.parse(reservation.created_at)
            if (!Number.isFinite(reservationAge) || reservationAge < MIN_AUTOMATIC_RETRY_AGE_MS) {
              continue
            }

            if (reservationAge >= PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS) {
              const { error } = await adminSupabase.rpc('mark_paymongo_refund_failed', {
                p_idempotency_key: reservation.idempotency_key,
                p_error: 'No PayMongo refund was found before the protected retry window expired',
                p_public_error: 'PayMongo did not confirm this refund before its protected retry window expired. No refund amount was deducted from the order’s collected total.',
              })
              if (error) throw error
              continue
            }

            const providerResult = await postPayMongoRefund({
              authorization: paymongo.authorization,
              idempotencyKey: reservation.idempotency_key,
              paymentId: job.payment_id,
              amount: Number(reservation.amount),
              reason: reservation.reason,
              notes: reservation.notes || '',
              timeoutMs: PROVIDER_TIMEOUT_MS,
            })

            if (providerResult.outcomeUnknown || !providerResult.response) {
              const { error } = await adminSupabase.rpc('mark_paymongo_refund_uncertain', {
                p_idempotency_key: reservation.idempotency_key,
                p_error: 'Automatic protected retry outcome is unknown; recovery will check again',
              })
              if (error) throw error
              continue
            }

            if (!providerResult.response.ok) {
              const failure = providerError(providerResult.providerBody)
              const { error } = await adminSupabase.rpc('mark_paymongo_refund_failed', {
                p_idempotency_key: reservation.idempotency_key,
                p_error: `${failure.code || 'provider_error'}: ${failure.detail}`,
                p_public_error: failure.publicMessage,
              })
              if (error) throw error
              continue
            }

            const refund = normalizeRefund(providerResult.providerBody?.data, job.payment_id)
            if (refund.livemode !== null && refund.livemode !== paymongo.livemode) {
              throw new Error('PayMongo retry returned a refund from a different API mode')
            }
            const { data, error } = await adminSupabase.rpc('reconcile_paymongo_refund', {
              p_refund_id: refund.refundId,
              p_payment_id: refund.paymentId,
              p_amount: refund.amount,
              p_status: refund.status,
              p_reason: refund.reason,
              p_notes: refund.notes,
              p_livemode: refund.livemode,
              p_event_id: null,
              p_provider_created_at: refund.providerCreatedAt,
              p_provider_updated_at: refund.providerUpdatedAt,
              p_idempotency_key: reservation.idempotency_key,
            })
            if (error || !data?.linked) {
              throw error || new Error('Retried refund could not be linked to its reservation')
            }
          }

          stage = 'count_unresolved_refunds'
          const { count: unresolvedCount, error: countError } = await adminSupabase
            .from('payment_refunds')
            .select('id', { count: 'exact', head: true })
            .eq('payment_transaction_id', job.payment_transaction_id)
            .in('status', ['creating', 'pending', 'processing'])
          if (countError) throw countError

          stage = 'finish_recovery_job'
          const { data: finished, error: finishError } = await adminSupabase.rpc(
            'finish_paymongo_refund_recovery_job',
            {
              p_payment_transaction_id: job.payment_transaction_id,
              p_claim_token: job.claim_token,
              p_success: true,
              p_livemode: paymongo.livemode,
              p_has_unresolved: (unresolvedCount || 0) > 0,
              p_refund_count: providerRefundCount,
              p_error: null,
            },
          )
          if (finishError || finished !== true) {
            throw finishError || new Error('Recovery job lease could not be completed')
          }

          return { success: true, refunds: providerRefundCount, diagnostic: null }
        } catch (error) {
          const safeError = recoveryDiagnostic(error, stage)
          console.error(`[paymongo-refund-recovery] ${safeError}`)
          const { error: finishError } = await adminSupabase.rpc(
            'finish_paymongo_refund_recovery_job',
            {
              p_payment_transaction_id: job.payment_transaction_id,
              p_claim_token: job.claim_token,
              p_success: false,
              p_livemode: paymongo.livemode,
              p_has_unresolved: false,
              p_refund_count: providerRefundCount,
              p_error: safeError,
            },
          )
          if (finishError) {
            console.error(`[paymongo-refund-recovery] ${recoveryDiagnostic(finishError, 'release_failed_job')}`)
          }
          return { success: false, refunds: providerRefundCount, diagnostic: safeError }
        }
      },
    )

    return json({
      success: results.every(result => result.success),
      claimed: results.length,
      completed: results.filter(result => result.success).length,
      failed: results.filter(result => !result.success).length,
      refundsObserved: results.reduce((total, result) => total + result.refunds, 0),
      diagnostics: results.filter(result => !result.success).map(result => result.diagnostic),
    })
  } catch (error) {
    const diagnostic = recoveryDiagnostic(error, 'worker_invocation')
    console.error(`[paymongo-refund-recovery] ${diagnostic}`)
    return json({ error: 'Refund recovery worker failed', diagnostic }, 500)
  }
})
