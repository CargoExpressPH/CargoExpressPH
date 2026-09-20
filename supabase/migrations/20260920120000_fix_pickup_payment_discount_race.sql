-- ============================================================
-- Fix the PayMongo pickup-confirmation race.
--
-- The admin pickup flow can start a PayMongo checkout before the final
-- pickup-confirm button is pressed. The webhook may therefore insert the
-- payment while the order is still in a pre-pickup status. A later
-- record_pickup_payment() call must preserve the discount that was staged
-- before checkout; an omitted discount must never mean "clear it".
--
-- The client now omits the three discount arguments when it is only finishing
-- a pickup after payment. The NULL default below lets this function distinguish
-- that preserve operation from an explicit zero discount on a new pickup.
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_pickup_payment(
  p_order_id uuid,
  p_actual_weight numeric,
  p_payment_method text,
  p_payer_type text DEFAULT 'sender'::text,
  p_pickup_photos jsonb DEFAULT '[]'::jsonb,
  p_promised_payment_date date DEFAULT NULL::date,
  p_amount numeric DEFAULT NULL::numeric,
  p_reference text DEFAULT NULL::text,
  p_payment_date date DEFAULT NULL::date,
  p_receipt_url text DEFAULT NULL::text,
  p_payment_type text DEFAULT 'Initial Payment'::text,
  p_notes text DEFAULT 'Initial pickup payment'::text,
  p_idempotency_key uuid DEFAULT NULL::uuid,
  p_admin_verified_receipt boolean DEFAULT false,
  p_discount_amount numeric DEFAULT NULL::numeric,
  p_discount_reason text DEFAULT NULL::text,
  p_discount_notes text DEFAULT NULL::text
)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order                 public.orders;
  v_admin_name            TEXT;
  v_paid_after            NUMERIC;
  v_label                 TEXT;
  v_ref_norm              TEXT;
  v_method                TEXT := lower(COALESCE(p_payment_method, ''));
  v_has_recorded_payment BOOLEAN;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Retry of the SAME collection (double-click, or a lost response after the
  -- transaction committed) is a no-op.
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.payment_transactions
     WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN v_order;
  END IF;

  IF v_order.status NOT IN ('Pending Review', 'Pending', 'Assigned') THEN
    RAISE EXCEPTION 'This order has already been picked up (status: %). Pickup, and any discount applied with it, can no longer be changed.', v_order.status;
  END IF;

  IF COALESCE(p_actual_weight, 0) <= 0 THEN
    RAISE EXCEPTION 'Actual weight must be greater than zero';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial')
  ) INTO v_has_recorded_payment;

  -- A payment may have been reconciled by the PayMongo webhook between source
  -- creation and this final pickup confirmation. In that case, an omitted
  -- discount (and the legacy client's explicit 0/null/null payload) means
  -- preserve the already-staged value. A different positive value remains a
  -- forbidden post-payment edit.
  IF v_has_recorded_payment
     AND COALESCE(p_discount_amount, 0) = 0
     AND p_discount_reason IS NULL
     AND p_discount_notes IS NULL
  THEN
    p_discount_amount := v_order.discount_amount;
    p_discount_reason := v_order.discount_reason;
    p_discount_notes := v_order.discount_notes;
  ELSIF v_has_recorded_payment
     AND (
       p_discount_amount IS DISTINCT FROM v_order.discount_amount
       OR p_discount_reason IS DISTINCT FROM v_order.discount_reason
       OR p_discount_notes IS DISTINCT FROM v_order.discount_notes
     )
  THEN
    RAISE EXCEPTION 'This order already has a recorded payment; its discount can no longer be changed.';
  ELSE
    p_discount_amount := COALESCE(p_discount_amount, 0);
  END IF;

  IF COALESCE(p_amount, 0) > 0 AND v_method = 'gcash' THEN
    v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);
  END IF;

  UPDATE public.orders
     SET actual_weight         = p_actual_weight,
         payment_method        = p_payment_method,
         payer_type            = COALESCE(p_payer_type, payer_type, 'sender'),
         pickup_photos         = COALESCE(p_pickup_photos, pickup_photos),
         promised_payment_date = p_promised_payment_date,
         payment_reference     = COALESCE(p_reference, payment_reference),
         status                = 'Picked Up',
         discount_amount       = ROUND(COALESCE(p_discount_amount, 0), 2),
         discount_reason       = p_discount_reason,
         discount_notes        = p_discount_notes
   WHERE id = p_order_id;

  IF COALESCE(p_amount, 0) > 0 THEN
    SELECT name INTO v_admin_name
      FROM public.profiles
     WHERE id = auth.uid();

    SELECT COALESCE(SUM(amount), 0) + p_amount
      INTO v_paid_after
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial');

    SELECT CASE
             WHEN v_paid_after >= public.order_payable_amount(shipping_cost, discount_amount) THEN 'paid'
             ELSE 'partial'
           END
      INTO v_label
      FROM public.orders
     WHERE id = p_order_id;

    BEGIN
      INSERT INTO public.payment_transactions (
        order_id, amount, payment_method, payment_status,
        transaction_reference, transaction_reference_normalized, gcash_channel,
        admin_id, admin_name, notes, payment_type, payment_date, receipt_url,
        idempotency_key
      ) VALUES (
        p_order_id, p_amount, p_payment_method, v_label,
        p_reference, v_ref_norm, CASE WHEN v_ref_norm IS NOT NULL THEN 'manual' END,
        auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
        p_payment_type, p_payment_date, p_receipt_url, p_idempotency_key
      )
      ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
      DO NOTHING;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'This GCash reference was already recorded on another order. It cannot be credited again.'
        USING ERRCODE = '23505';
    END;
  END IF;

  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id;
  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_pickup_payment(uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_pickup_payment(uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean, numeric, text, text) TO service_role, authenticated;

