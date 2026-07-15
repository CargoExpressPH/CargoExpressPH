// Supabase Edge Function: paymongo-webhook
// Handles PayMongo source/payment events with raw-body signature verification.
//
// Required Supabase secrets:
//   PAYMONGO_SECRET_KEY
//   PAYMONGO_WEBHOOK_SECRET
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, paymongo-signature',
}

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
  const response = await fetch('https://api.paymongo.com/v1/payments', {
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
    const rawBody = await req.text()
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

      console.log(`[paymongo-webhook] source.chargeable: sourceId=${sourceId}, amount=${amount}`)

      const { data: attempt } = await adminSupabase
        .from('payment_attempts')
        .select('source_id, status, payment_id, amount')
        .eq('source_id', sourceId)
        .maybeSingle()

      if (!attempt) {
        console.log(`[paymongo-webhook] No matching payment attempt for sourceId=${sourceId}`)
        return json({ received: true, ignored: true, reason: 'No matching payment attempt' })
      }
      if (attempt.status === 'reconciled' && attempt.payment_id) {
        console.log(`[paymongo-webhook] Already reconciled. payment_id=${attempt.payment_id}`)
        return json({ received: true, orderReconciled: true })
      }

      // Use the stored attempt amount (correct for partial payments) rather than
      // the PayMongo event amount which may differ due to rounding.
      const chargeAmount = Number(attempt.amount) || amount
      console.log(`[paymongo-webhook] Capturing payment. chargeAmount=${chargeAmount}`)

      await markAttempt(adminSupabase, sourceId, { status: 'chargeable', last_error: null })
      const payment = await capturePayment(sourceId, chargeAmount, attributes.description || null)
      console.log(`[paymongo-webhook] Captured. paymentId=${payment.paymentId}, status=${payment.status}`)

      const result = await reconcile(adminSupabase, sourceId, payment.paymentId, payment.amount, payment.status)
      console.log(`[paymongo-webhook] Reconciled. orderReconciled=${result?.order_reconciled}`)

      return json({
        received: true,
        eventId,
        paymentId: payment.paymentId,
        orderReconciled: !!result?.order_reconciled,
      })
    }

    if (eventType === 'payment.paid') {
      const paymentId = resource?.id
      const sourceId = attributes.source?.id
      const amount = Number(attributes.amount || 0) / 100
      const status = attributes.status || 'paid'
      if (!sourceId || !paymentId || amount <= 0) return json({ received: true, ignored: true })

      console.log(`[paymongo-webhook] payment.paid: paymentId=${paymentId}, sourceId=${sourceId}, amount=${amount}`)
      const result = await reconcile(adminSupabase, sourceId, paymentId, amount, status)
      console.log(`[paymongo-webhook] payment.paid reconciled. orderReconciled=${result?.order_reconciled}`)
      return json({ received: true, eventId, paymentId, orderReconciled: !!result?.order_reconciled })
    }

    return json({ received: true, ignored: true, eventType })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected webhook error'
    console.error(message)
    return json({ error: message }, 500)
  }
})
