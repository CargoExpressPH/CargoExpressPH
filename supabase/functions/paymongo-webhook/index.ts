// Supabase Edge Function: paymongo-webhook
// Handles PayMongo source/payment events with raw-body signature verification.
//
// Required Supabase secrets:
//   PAYMONGO_SECRET_KEY
//   PAYMONGO_WEBHOOK_SECRET
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, paymongo-signature',
}

const PROVIDER_TIMEOUT_MS = 15_000
const MAX_WEBHOOK_BYTES = 512 * 1024
const providerFetch = (input: string | URL, init: RequestInit = {}) => fetch(input, {
  ...init,
  redirect: 'error',
  signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    },
  })

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

const parseSignature = (header: string) => {
  return header.split(',').reduce<Record<string, string>>((acc, part) => {
    const [key, value] = part.split('=')
    if (key && value !== undefined) acc[key.trim()] = value.trim()
    return acc
  }, {})
}

const verifySignature = async (rawBody: string, signatureHeader: string | null) => {
  const secret = Deno.env.get('PAYMONGO_WEBHOOK_SECRET')
  if (!secret) throw new Error('PAYMONGO_WEBHOOK_SECRET is not configured')
  if (!signatureHeader) return false

  const parts = parseSignature(signatureHeader)
  if (!parts.t) return false

  const signedPayload = `${parts.t}.${rawBody}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload)))

  return [parts.te, parts.li].some(value => value && timingSafeEqual(expected, value))
}

const serviceClient = () => {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')

  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceRoleKey,
  )
}

const paymongoAuthHeader = () => {
  const paymongoSecretKey = Deno.env.get('PAYMONGO_SECRET_KEY')
  if (!paymongoSecretKey) throw new Error('PAYMONGO_SECRET_KEY is not configured')
  return `Basic ${btoa(`${paymongoSecretKey}:`)}`
}

const capturePayment = async (sourceId: string, amountPhp: number, description: string | null) => {
  const response = await providerFetch('https://api.paymongo.com/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': paymongoAuthHeader(),
    },
    body: JSON.stringify({
      data: {
        attributes: {
          amount: Math.round(amountPhp * 100),
          source: { id: sourceId, type: 'source' },
          currency: 'PHP',
          description: description || 'CargoExpress PH Shipping Payment',
        },
      },
    }),
  })

  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.errors?.[0]?.detail || 'Failed to process payment')
  }

  return {
    paymentId: result.data.id,
    status: result.data.attributes.status,
    amount: result.data.attributes.amount / 100,
  }
}

const reconcile = async (
  adminSupabase: ReturnType<typeof createClient>,
  sourceId: string,
  paymentId: string,
  amount: number,
  status: string,
) => {
  const { data, error } = await adminSupabase.rpc('reconcile_paymongo_payment_attempt', {
    p_source_id: sourceId,
    p_payment_id: paymentId,
    p_payment_amount: amount,
    p_payment_status: status,
  })

  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}

const markAttempt = async (
  adminSupabase: ReturnType<typeof createClient>,
  sourceId: string,
  fields: Record<string, unknown>,
) => {
  await adminSupabase
    .from('payment_attempts')
    .update(fields)
    .eq('source_id', sourceId)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const declaredLength = Number(req.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
      return json({ error: 'Webhook payload is too large' }, 413)
    }
    const rawBody = await req.text()
    if (new TextEncoder().encode(rawBody).length > MAX_WEBHOOK_BYTES) {
      return json({ error: 'Webhook payload is too large' }, 413)
    }
    const validSignature = await verifySignature(rawBody, req.headers.get('Paymongo-Signature'))
    if (!validSignature) {
      return json({ error: 'Invalid PayMongo signature' }, 401)
    }

    const payload = JSON.parse(rawBody)
    const eventId = payload?.data?.id
    const eventType = payload?.data?.attributes?.type
    const resource = payload?.data?.attributes?.data
    const attributes = resource?.attributes || {}
    const adminSupabase = serviceClient()

    if (eventType === 'source.chargeable') {
      const sourceId = resource?.id
      const amount = Number(attributes.amount || 0) / 100
      if (!sourceId || amount <= 0) return json({ received: true, ignored: true })

      console.log('[paymongo-webhook] Received a chargeable source event')

      const { data: attempt } = await adminSupabase
        .from('payment_attempts')
        .select('source_id, status, payment_id, amount')
        .eq('source_id', sourceId)
        .maybeSingle()

      if (!attempt) {
        console.log('[paymongo-webhook] No matching payment attempt')
        return json({ received: true, ignored: true, reason: 'No matching payment attempt' })
      }
      if (attempt.status === 'reconciled' && attempt.payment_id) {
        console.log('[paymongo-webhook] Payment attempt already reconciled')
        return json({ received: true, orderReconciled: true })
      }

      // Use the stored attempt amount (correct for partial payments) rather than
      // the PayMongo event amount which may differ due to rounding.
      const chargeAmount = Number(attempt.amount) || amount
      console.log('[paymongo-webhook] Capturing the registered payment amount')

      await markAttempt(adminSupabase, sourceId, { status: 'chargeable', last_error: null })
      
      try {
        const payment = await capturePayment(sourceId, chargeAmount, attributes.description || null)
        console.log('[paymongo-webhook] Payment capture succeeded')

        const result = await reconcile(adminSupabase, sourceId, payment.paymentId, payment.amount, payment.status)
        console.log('[paymongo-webhook] Payment reconciliation completed')

        return json({
          received: true,
          eventId,
          paymentId: payment.paymentId,
          orderReconciled: !!result?.order_reconciled,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('not chargeable')) {
          // "Not chargeable" here means a sibling capture call — the
          // customer's own poll, invoked when they land back on the app
          // right after approving GCash — won this source's ONE allowed
          // capture a few hundred milliseconds before this webhook tried.
          // That sibling already has the REAL PayMongo payment id from its
          // own POST /v1/payments response and is reconciling with it right
          // now (or already has).
          //
          // BUG-01 (see PAYMENT_DUPLICATE_PREVENTION_FIX.md): this branch
          // used to treat the source's own "paid" status as license to
          // reconcile anyway, using a MADE-UP reference (`auto_${sourceId}`)
          // because the source endpoint does not return a payment id. That
          // is exactly the "not proof of successful payment" shortcut the
          // task forbids, and it defeated the ledger's own idempotency
          // guard (two different reference strings for one real payment).
          //
          // There is no documented PayMongo endpoint that maps a source id
          // back to the payment id captured against it (the Source resource
          // has no such field, and List Payments cannot be filtered by
          // source — verified against the current PayMongo API docs), so
          // there is no way to obtain a REAL id from here. The correct move
          // is to do nothing: the sibling's own reconcile call, and/or the
          // independent `payment.paid` webhook event PayMongo fires once
          // the capture settles, will finish the job with the real id. This
          // event is safely re-driveable — returning success here without
          // reconciling just means this specific delivery had nothing to
          // do.
          console.log('[paymongo-webhook] Concurrent capture won; awaiting the payment.paid event')
          return json({ received: true, ignored: true, reason: 'Captured by a concurrent request; awaiting payment.paid', raced: true })
        }
        throw err
      }
    }

    if (eventType === 'payment.paid') {
      const paymentId = resource?.id
      const sourceId = attributes.source?.id
      const amount = Number(attributes.amount || 0) / 100
      const status = attributes.status || 'paid'
      if (!sourceId || !paymentId || amount <= 0) return json({ received: true, ignored: true })

      console.log('[paymongo-webhook] Received a paid payment event')
      const result = await reconcile(adminSupabase, sourceId, paymentId, amount, status)
      console.log('[paymongo-webhook] Paid payment event reconciled')
      return json({ received: true, eventId, paymentId, orderReconciled: !!result?.order_reconciled })
    }

    return json({ received: true, ignored: true, eventType })
  } catch {
    console.error('[paymongo-webhook] Webhook processing failed')
    return json({ error: 'Webhook processing failed' }, 500)
  }
})
