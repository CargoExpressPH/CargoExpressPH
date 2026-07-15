// Supabase Edge Function: paymongo-create-payment
// Captures a chargeable PayMongo source and reconciles it to an order through
// payment_attempts. The RPC update is idempotent and safe if a webhook already
// processed the same source.
//
// Required Supabase secrets:
//   PAYMONGO_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    },
  })

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

const getAttempt = async (adminSupabase: ReturnType<typeof createClient>, sourceId: string) => {
  const { data } = await adminSupabase
    .from('payment_attempts')
    .select('source_id, amount, status, payment_id, payment_status, payment_type, estimated_cost, promised_payment_date')
    .eq('source_id', sourceId)
    .maybeSingle()
  return data
}

const ensureAttempt = async (
  adminSupabase: ReturnType<typeof createClient>,
  sourceId: string,
  amount: number,
  description: string | null,
  orderUpdate: Record<string, unknown> | null,
  createdBy: string,
) => {
  const existing = await getAttempt(adminSupabase, sourceId)
  if (!orderUpdate?.orderId) return existing

  const payload = {
    source_id: sourceId,
    order_id: orderUpdate.orderId,
    amount,
    description,
    actual_weight: orderUpdate.actualWeight ?? null,
    payer_type: orderUpdate.payerType || 'sender',
    pickup_photos: orderUpdate.pickupPhotos || [],
    // Bug Fix #2: Preserve payment_type, estimated_cost, promised_payment_date.
    // These are set by the frontend when creating the payment attempt and must
    // not be reset to defaults when the edge function re-upserts the row.
    payment_type: (existing?.payment_type ?? 'full') as string,
    estimated_cost: (existing?.estimated_cost ?? null) as number | null,
    promised_payment_date: (existing?.promised_payment_date ?? null) as string | null,
    created_by: createdBy,
  }

  if (existing) {
    if (existing.status !== 'reconciled') {
      console.log(`[paymongo-create-payment] Updating existing attempt for source ${sourceId}, status=${existing.status}`)
      await adminSupabase
        .from('payment_attempts')
        .update(payload)
        .eq('source_id', sourceId)
    } else {
      console.log(`[paymongo-create-payment] Attempt already reconciled for source ${sourceId}`)
    }
    return getAttempt(adminSupabase, sourceId)
  }

  console.log(`[paymongo-create-payment] Inserting new attempt for source ${sourceId}`)
  const { data, error } = await adminSupabase
    .from('payment_attempts')
    .insert(payload)
    .select('source_id, amount, status, payment_id, payment_status, payment_type, estimated_cost, promised_payment_date')
    .single()

  if (error) throw error
  return data
}

const capturePayment = async (sourceId: string, amount: number, description: string | null) => {
  const response = await fetch('https://api.paymongo.com/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': paymongoAuthHeader(),
    },
    body: JSON.stringify({
      data: {
        attributes: {
          amount: Math.round(amount * 100),
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      return json({ error: 'Authentication required' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData.user) {
      return json({ error: 'Authentication required' }, 401)
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single()

    if (profileError || profile?.role !== 'admin') {
      return json({ error: 'Admin access required' }, 403)
    }

    const { sourceId, amount, description, orderUpdate } = await req.json()
    const parsedAmount = Number(amount)

    if (!sourceId || typeof sourceId !== 'string') {
      return json({ error: 'sourceId is required' }, 400)
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return json({ error: 'amount must be greater than zero' }, 400)
    }

    console.log(`[paymongo-create-payment] Request from user=${userData.user.id}, sourceId=${sourceId}, amount=${parsedAmount}`)

    const adminSupabase = serviceClient()
    let attempt = await ensureAttempt(
      adminSupabase,
      sourceId,
      parsedAmount,
      description || null,
      orderUpdate || null,
      userData.user.id,
    )

    // Bug Fix #3: Return early if already reconciled (idempotency)
    if (attempt?.payment_id && attempt.status === 'reconciled') {
      console.log(`[paymongo-create-payment] Already reconciled. payment_id=${attempt.payment_id}`)
      return json({
        paymentId: attempt.payment_id,
        status: attempt.payment_status || 'paid',
        amount: Number(attempt.amount || parsedAmount),
        orderReconciled: true,
      })
    }

    // Bug Fix #3: If a payment_id exists but status is NOT reconciled, the PayMongo
    // capture succeeded but the DB reconcile transaction failed. Attempt reconcile again.
    if (attempt?.payment_id && attempt.status !== 'reconciled') {
      console.log(`[paymongo-create-payment] Found orphaned payment_id=${attempt.payment_id}, re-reconciling...`)
      try {
        const result = await reconcile(adminSupabase, sourceId, attempt.payment_id, parsedAmount, 'paid')
        return json({
          paymentId: attempt.payment_id,
          status: 'paid',
          amount: parsedAmount,
          orderReconciled: !!result?.order_reconciled,
        })
      } catch (reReconcileErr) {
        console.error(`[paymongo-create-payment] Re-reconcile failed: ${reReconcileErr}`)
        // Fall through to attempt capture again
      }
    }

    try {
      console.log(`[paymongo-create-payment] Marking attempt as chargeable, sourceId=${sourceId}`)
      await adminSupabase
        .from('payment_attempts')
        .update({ status: 'chargeable', last_error: null })
        .eq('source_id', sourceId)

      console.log(`[paymongo-create-payment] Calling PayMongo capture, amount=${parsedAmount}`)
      const payment = await capturePayment(sourceId, parsedAmount, description || null)
      console.log(`[paymongo-create-payment] Capture success. paymentId=${payment.paymentId}, status=${payment.status}`)

      const result = await reconcile(adminSupabase, sourceId, payment.paymentId, payment.amount, payment.status)
      console.log(`[paymongo-create-payment] Reconcile complete. orderReconciled=${result?.order_reconciled}`)

      return json({
        paymentId: payment.paymentId,
        status: payment.status,
        amount: payment.amount,
        orderReconciled: !!result?.order_reconciled,
      })
    } catch (captureErr) {
      attempt = await getAttempt(adminSupabase, sourceId)
      if (attempt?.payment_id && attempt.status === 'reconciled') {
        console.log(`[paymongo-create-payment] Race: webhook already reconciled. payment_id=${attempt.payment_id}`)
        return json({
          paymentId: attempt.payment_id,
          status: attempt.payment_status || 'paid',
          amount: Number(attempt.amount || parsedAmount),
          orderReconciled: true,
        })
      }

      const message = captureErr instanceof Error ? captureErr.message : 'Payment capture failed'
      console.error(`[paymongo-create-payment] Capture error: ${message}`)
      await adminSupabase
        .from('payment_attempts')
        .update({ status: 'failed', last_error: message })
        .eq('source_id', sourceId)

      return json({ error: message }, 502)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected payment error'
    return json({ error: message }, 500)
  }
})
