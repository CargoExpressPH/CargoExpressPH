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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { authorizeOrderUpdate } from './authorization.js'

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
    // order_id is selected for the ownership binding in ensureAttempt / poll —
    // without it, an attempt could be silently re-pointed at another order.
    .select('source_id, order_id, amount, status, payment_id, payment_status, payment_type, estimated_cost, promised_payment_date, actual_weight, payer_type, pickup_photos, created_by')
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

  // ───────────────────────────────────────────────────────────────────────────
  // SECURITY: a source is bound to the order it was first registered against.
  //
  // Without this, any authenticated user could re-point someone else's pending
  // attempt at their OWN order — the row is written with the service-role key,
  // so RLS does not apply here. The source id is not a secret: it is embedded
  // in the checkout URL that the admin displays as a QR code at the counter.
  // Photograph that QR, POST it back with your own orderId, and the victim's
  // payment reconciles against your order while theirs stays unpaid.
  //
  // Re-registering the SAME order is still allowed — that is the ordinary
  // retry path.
  // ───────────────────────────────────────────────────────────────────────────
  if (existing?.order_id && existing.order_id !== orderUpdate.orderId) {
    console.warn(
      `[paymongo-create-payment] ATTEMPT REBIND REJECTED source=${sourceId} ` +
      `bound_order=${existing.order_id} requested_order=${orderUpdate.orderId} user=${createdBy}`,
    )
    throw new Error('This payment source is already registered to a different order.')
  }

  const payload = {
    source_id: sourceId,
    order_id: orderUpdate.orderId,
    amount,
    description,
    actual_weight: orderUpdate.actualWeight ?? null,
    // No fallback to "sender" here. A customer payment must preserve the
    // order's existing Freight Prepaid / Freight Collect choice; only an
    // admin-authorized pickup attempt may stage a new value.
    payer_type: orderUpdate.payerType ?? null,
    pickup_photos: orderUpdate.pickupPhotos ?? null,
    // Bug Fix #2: Preserve payment_type, estimated_cost, promised_payment_date.
    // These are set by the frontend when creating the payment attempt and must
    // not be reset to defaults when the edge function re-upserts the row.
    payment_type: (existing?.payment_type ?? 'full') as string,
    estimated_cost: (existing?.estimated_cost ?? null) as number | null,
    promised_payment_date: (existing?.promised_payment_date ?? null) as string | null,
    created_by: createdBy,
  }

  if (existing) {
    // A PayMongo source is an idempotency key as well as an order binding.
    // Its creator and staged admin metadata are immutable after the first
    // registration. Otherwise an order owner who learns an admin checkout
    // source could re-register it and replace/erase the trusted pickup data.
    console.log(`[paymongo-create-payment] Attempt already registered for source ${sourceId}, status=${existing.status}`)
    return existing
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

    const orderUpdateAuthorization = authorizeOrderUpdate(orderUpdate, isAdmin)
    if (orderUpdateAuthorization.error) {
      console.warn(
        `[paymongo-create-payment] ORDER METADATA REJECTED user=${userData.user.id} ` +
        `role=${isAdmin ? 'admin' : 'customer'} reason=${orderUpdateAuthorization.error}`,
      )
      return json({ error: orderUpdateAuthorization.error }, orderUpdateAuthorization.status)
    }
    const authorizedOrderUpdate = orderUpdateAuthorization.value

    // Load the order once — needed for BOTH the ownership check and the
    // server-side amount validation below.
    let orderRow: {
      user_id: string
      remaining_balance: number | null
      tracking_number: string | null
    } | null = null

    if (authorizedOrderUpdate?.orderId) {
      const { data } = await adminSupabase
        .from('orders')
        .select('user_id, remaining_balance, tracking_number')
        .eq('id', authorizedOrderUpdate.orderId)
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
            `[paymongo-create-payment] AMOUNT REJECTED order=${authorizedOrderUpdate?.orderId} ` +
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
          `order=${authorizedOrderUpdate?.orderId} tracking=${orderRow.tracking_number} ` +
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

      // The ownership check above validated the caller against orderUpdate.orderId,
      // but the attempt is looked up by sourceId alone. Without this binding a
      // customer could poll a stranger's source while passing their own order id
      // and read back its amount, status and payment id.
      if (!isAdmin && attempt.order_id !== authorizedOrderUpdate?.orderId) {
        return json({ error: 'Unauthorized to poll this payment' }, 403)
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
        // The source itself is a bare status string with no payment id
        // attached (verified against PayMongo's current Source resource
        // docs — no such field exists, and List Payments cannot be
        // filtered by source). "Paid" here is a genuine, provider-confirmed
        // signal that SOME capture already succeeded — but it is not proof
        // of which caller's reconcile has (or will) run, and it is not
        // itself a payment id to credit with.
        //
        // BUG-01 (see PAYMENT_DUPLICATE_PREVENTION_FIX.md): this branch used
        // to paper over that by reconciling with a made-up
        // `auto_${sourceId}` reference, which the ledger's own idempotency
        // guard could not recognize as the same money once the real
        // `payment.paid` webhook reconciled again with the true id. Do not
        // invent a reference: whoever's capture call actually won already
        // has the real id from its own POST /v1/payments response and is
        // reconciling with it, and the `payment.paid` webhook is the
        // independent, authoritative finisher regardless of which internal
        // path won. Re-check our own attempt row — the winner may already
        // have committed — and otherwise report "confirmed by GCash,
        // finalizing" so the caller keeps polling instead of retrying a
        // capture or treating this as an error.
        const latest = await getAttempt(adminSupabase, sourceId)
        if (latest?.payment_id && latest.status === 'reconciled') {
          return json({
            paymentId: latest.payment_id,
            status: latest.payment_status || 'paid',
            amount: Number(latest.amount),
            orderReconciled: true,
          })
        }
        return json({
          status: 'paid',
          orderReconciled: false,
          settling: true,
          message: 'GCash confirmed this payment; finalizing the ledger entry. Check again in a few seconds.',
        })
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
            // Lost the capture race to a concurrent request (see the
            // `sourceStatus === 'paid'` branch above for why this does not
            // invent a reference). Re-check our own row in case the winner
            // already committed while we were talking to PayMongo.
            const latest = await getAttempt(adminSupabase, sourceId)
            if (latest?.payment_id && latest.status === 'reconciled') {
              return json({
                paymentId: latest.payment_id,
                status: latest.payment_status || 'paid',
                amount: Number(latest.amount),
                orderReconciled: true,
              })
            }
            return json({
              status: 'paid',
              orderReconciled: false,
              settling: true,
              message: 'GCash confirmed this payment; finalizing the ledger entry. Check again in a few seconds.',
            })
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
      authorizedOrderUpdate || null,
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
