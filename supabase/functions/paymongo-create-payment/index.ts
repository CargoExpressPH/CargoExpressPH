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
    pickup_photos: orderUpdate.pickupPhotos || null,
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

    const { sourceId, amount, description, orderUpdate, action } = await req.json()
    const parsedAmount = Number(amount)

    if (!sourceId || typeof sourceId !== 'string') {
      return json({ error: 'sourceId is required' }, 400)
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return json({ error: 'amount must be greater than zero' }, 400)
    }

    const adminSupabase = serviceClient()
    const isAdmin = !profileError && profile?.role === 'admin'

    // Load the order once — needed for BOTH the ownership check and the
    // server-side amount validation below.
    let orderRow: {
      user_id: string
      remaining_balance: number | null
      tracking_number: string | null
    } | null = null

    if (orderUpdate?.orderId) {
      const { data } = await adminSupabase
        .from('orders')
        .select('user_id, remaining_balance, tracking_number')
        .eq('id', orderUpdate.orderId)
        .single()
      orderRow = data as typeof orderRow
    }

    // Access Check: Admin OR Owner of the order
    if (!isAdmin) {
      if (!orderRow) {
        return json({ error: 'Admin access or valid order ID required' }, 403)
      }
      if (orderRow.user_id !== userData.user.id) {
        return json({ error: 'Unauthorized to pay for this order' }, 403)
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECURITY: the amount is supplied by the client and must never be trusted.
    //
    // Before this check, a caller could create a PayMongo source for any amount
    // (the browser holds the PUBLIC key and calls /v1/sources directly), then
    // register it here — paying ₱1 against a ₱5,000 order. See P-1 in
    // docs/payment-redesign-v2.md.
    //
    // The order's outstanding balance is the authority. 'poll' is exempt: it
    // sends a placeholder amount of 1 and the server uses the stored attempt
    // amount instead.
    // ─────────────────────────────────────────────────────────────────────────
    if (action !== 'poll') {
      if (!orderRow) {
        return json({ error: 'A valid order ID is required to create a payment.' }, 400)
      }

      const balance   = Number(orderRow.remaining_balance ?? 0)
      const TOLERANCE = 0.01   // remaining_balance is DECIMAL(10,2)
      const exceeds   = parsedAmount > balance + TOLERANCE

      if (!isAdmin) {
        // Customers may never pay more than they owe, nor pay a settled order.
        if (!(balance > 0)) {
          return json({ error: 'This order has no outstanding balance.' }, 409)
        }
        if (exceeds) {
          console.warn(
            `[paymongo-create-payment] AMOUNT REJECTED order=${orderUpdate?.orderId} ` +
            `tracking=${orderRow.tracking_number} requested=${parsedAmount} ` +
            `balance=${balance} user=${userData.user.id}`,
          )
          return json({
            error: `Amount ₱${parsedAmount.toFixed(2)} exceeds the outstanding balance of ₱${balance.toFixed(2)}.`,
          }, 400)
        }
      } else if (exceeds || !(balance > 0)) {
        // Admins legitimately charge ABOVE the stored balance. At pickup the new
        // actual_weight has not been saved yet, so orders.shipping_cost is still
        // the booking estimate — e.g. booked 10 kg (₱800) but weighed 15 kg
        // (₱1,200). Rejecting that would break the admin pickup flow entirely.
        // Admins can already write orders directly, so this is not a new hole.
        // Logged for audit; the ledger records what was actually collected.
        console.warn(
          `[paymongo-create-payment] ADMIN OVER-BALANCE CHARGE (allowed) ` +
          `order=${orderUpdate?.orderId} tracking=${orderRow.tracking_number} ` +
          `requested=${parsedAmount} stored_balance=${balance} admin=${userData.user.id}`,
        )
      }
    }

    console.log(`[paymongo-create-payment] Request from user=${userData.user.id}, sourceId=${sourceId}, amount=${parsedAmount}, action=${action || 'capture'}`)

    // Poll action: called by frontend when customer returns from PayMongo.
    // Uses getAttempt (read-only) — does NOT call ensureAttempt to avoid overwriting the stored amount.
    if (action === 'poll') {
      console.log(`[paymongo-create-payment] Poll request for sourceId=${sourceId}`)

      const attempt = await getAttempt(adminSupabase, sourceId)
      if (!attempt) {
        return json({ error: 'No payment attempt found for this source' }, 404)
      }

      // If already reconciled, return immediately
      if (attempt.payment_id && attempt.status === 'reconciled') {
        console.log(`[paymongo-create-payment] Poll: already reconciled. payment_id=${attempt.payment_id}`)
        return json({
          paymentId: attempt.payment_id,
          status: attempt.payment_status || 'paid',
          amount: Number(attempt.amount),
          orderReconciled: true,
        })
      }

      // Check source status from PayMongo
      const sourceRes = await fetch(`https://api.paymongo.com/v1/sources/${sourceId}`, {
        headers: { 'Authorization': paymongoAuthHeader() },
      })
      const sourceData = await sourceRes.json()
      const sourceStatus = sourceData?.data?.attributes?.status
      const sourceAmount = Number(sourceData?.data?.attributes?.amount || 0) / 100

      console.log(`[paymongo-create-payment] Poll: PayMongo source status="${sourceStatus}", amount=${sourceAmount}`)

      if (sourceStatus === 'paid') {
        // PayMongo already captured — reconcile directly using the real amount
        const healAmount = sourceAmount || Number(attempt.amount)
        try {
          const result = await reconcile(adminSupabase, sourceId, `auto_${sourceId}`, healAmount, 'paid')
          console.log(`[paymongo-create-payment] Poll: reconciled. orderReconciled=${result?.order_reconciled}`)
          return json({
            paymentId: `auto_${sourceId}`,
            status: 'paid',
            amount: healAmount,
            orderReconciled: !!result?.order_reconciled,
          })
        } catch (reconcileErr) {
          const errMsg = reconcileErr instanceof Error ? reconcileErr.message : JSON.stringify(reconcileErr)
          console.error(`[paymongo-create-payment] Poll: reconcile failed: ${errMsg}`)
          return json({ error: 'Reconciliation failed, please refresh the page' }, 502)
        }
      }

      if (sourceStatus === 'chargeable') {
        // Source is chargeable — capture it now
        const captureAmount = sourceAmount || Number(attempt.amount)
        try {
          const payment = await capturePayment(sourceId, captureAmount, description || null)
          const result = await reconcile(adminSupabase, sourceId, payment.paymentId, payment.amount, payment.status)
          console.log(`[paymongo-create-payment] Poll: captured and reconciled. paymentId=${payment.paymentId}`)
          return json({
            paymentId: payment.paymentId,
            status: payment.status,
            amount: payment.amount,
            orderReconciled: !!result?.order_reconciled,
          })
        } catch (captureErr) {
          const msg = captureErr instanceof Error ? captureErr.message : String(captureErr)
          if (msg.includes('not chargeable')) {
            try {
              const healAmount = sourceAmount || Number(attempt.amount)
              const result = await reconcile(adminSupabase, sourceId, `auto_${sourceId}`, healAmount, 'paid')
              return json({
                paymentId: `auto_${sourceId}`,
                status: 'paid',
                amount: healAmount,
                orderReconciled: !!result?.order_reconciled,
              })
            } catch (e) {
              const eMsg = e instanceof Error ? e.message : JSON.stringify(e)
              return json({ error: `Payment reconciliation failed: ${eMsg}` }, 502)
            }
          }
          return json({ error: msg }, 502)
        }
      }

      // Source is still pending or failed
      return json({
        status: sourceStatus || 'pending',
        orderReconciled: false,
        message: sourceStatus === 'pending' ? 'Payment not yet authorized' : `Source status: ${sourceStatus}`,
      })
    }

    let attempt = await ensureAttempt(
      adminSupabase,
      sourceId,
      parsedAmount,
      description || null,
      orderUpdate || null,
      userData.user.id,
    )

    if (action === 'register') {
      console.log(`[paymongo-create-payment] Registration complete for sourceId=${sourceId}`)
      return json({ success: true, sourceId })
    }

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
