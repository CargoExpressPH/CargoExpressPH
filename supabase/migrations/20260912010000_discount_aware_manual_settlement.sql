-- ============================================================
-- Discount-aware manual delivery and balance settlement
--
-- Shipping discounts were introduced in 2026091101..04. The shared ledger
-- trigger, pickup RPC, order guard and sales summary were made discount-aware,
-- but record_delivery_payment() and record_additional_payment() retained the
-- gross `shipping_cost` comparisons from 20260909030000. Consequences:
--
--   * collecting the exact discounted balance at delivery still appeared to
--     leave the discount amount owing, so delivery required a promise date;
--   * an exact later settlement was labelled `partial` / `Additional Payment`
--     even though the ledger trigger correctly marked the order paid.
--
-- Both functions below now use order_payable_amount() for every final-fee
-- comparison. While each order row is locked, they also enforce the existing
-- client rule that a manual payment cannot exceed the outstanding balance.
-- Delivery now rejects missing/unsupported methods whenever money is supplied
-- instead of silently storing such a payment as GCash without verification.
-- It also enforces the existing delivery lifecycle/proof requirements at the
-- database boundary and rejects an idempotency key already bound to a
-- different order rather than returning a false success.
-- ============================================================


CREATE OR REPLACE FUNCTION public.record_delivery_payment(
  p_order_id uuid,
  p_delivery_photos jsonb DEFAULT '[]'::jsonb,
  p_payment_method text DEFAULT NULL::text,
  p_amount numeric DEFAULT NULL::numeric,
  p_reference text DEFAULT NULL::text,
  p_payment_date date DEFAULT NULL::date,
  p_receipt_url text DEFAULT NULL::text,
  p_payment_type text DEFAULT 'Balance Settlement'::text,
  p_notes text DEFAULT 'Balance settlement upon delivery'::text,
  p_promised_payment_date date DEFAULT NULL::date,
  p_idempotency_key uuid DEFAULT NULL::uuid,
  p_admin_verified_receipt boolean DEFAULT false
)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order                  public.orders;
  v_admin_name             TEXT;
  v_paid_after             NUMERIC;
  v_label                  TEXT;
  v_total_paid_before      NUMERIC;
  v_total_paid_projected   NUMERIC;
  v_payable                NUMERIC;
  v_outstanding_before     NUMERIC;
  v_remaining_projected    NUMERIC;
  v_effective_promise_date DATE;
  v_idempotency_order_id   UUID;
  v_ref_norm               TEXT;
  v_method                 TEXT := lower(COALESCE(p_payment_method, ''));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- The order lock makes a retry with the same key observe the first call's
  -- committed ledger row before deciding whether to do any work.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT order_id INTO v_idempotency_order_id
      FROM public.payment_transactions
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_idempotency_order_id = p_order_id THEN
        RETURN v_order;
      END IF;
      RAISE EXCEPTION 'This payment attempt identifier is already associated with another order.'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  -- Delivery is the final state transition, not a generic status override.
  -- Enforce the same lifecycle and proof rules as DeliveryModal on the trusted
  -- side of the API so a direct authenticated RPC call cannot bypass them.
  IF v_order.status <> 'Out for Delivery' THEN
    RAISE EXCEPTION 'Only an order that is Out for Delivery can be marked as delivered.'
      USING ERRCODE = '22023';
  END IF;

  IF p_delivery_photos IS NULL
     OR jsonb_typeof(p_delivery_photos) <> 'array'
     OR jsonb_array_length(p_delivery_photos) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Attach between 1 and 3 photos as proof of delivery.'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_amount, 0) < 0 THEN
    RAISE EXCEPTION 'Amount cannot be negative'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_amount, 0) > 0 THEN
    IF v_method = 'cash' THEN
      RAISE EXCEPTION 'Cash is no longer accepted once an order has been picked up. Collect the remaining balance via GCash.'
        USING ERRCODE = '22023';
    END IF;

    IF v_method <> 'gcash' THEN
      RAISE EXCEPTION 'Unsupported payment method: %', COALESCE(p_payment_method, '(missing)')
        USING ERRCODE = '22023';
    END IF;

    -- All GCash money entered through this RPC is a verified manual transfer.
    v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_paid_before
    FROM public.payment_transactions
   WHERE order_id = p_order_id
     AND payment_status IN ('paid', 'partial');

  v_payable            := public.order_payable_amount(v_order.shipping_cost, v_order.discount_amount);
  v_outstanding_before := GREATEST(0, v_payable - v_total_paid_before);

  -- The UI caps at remaining_balance; this is the authoritative equivalent
  -- under the same lock that serializes concurrent admin submissions.
  IF COALESCE(p_amount, 0) > v_outstanding_before + 0.005 THEN
    RAISE EXCEPTION 'Payment amount of ₱% exceeds the outstanding balance of ₱%.',
      TO_CHAR(p_amount, 'FM999999990.00'),
      TO_CHAR(v_outstanding_before, 'FM999999990.00')
      USING ERRCODE = '22023';
  END IF;

  v_total_paid_projected := v_total_paid_before + GREATEST(COALESCE(p_amount, 0), 0);
  v_remaining_projected  := GREATEST(0, v_payable - v_total_paid_projected);
  v_effective_promise_date := COALESCE(p_promised_payment_date, v_order.promised_payment_date);

  IF v_remaining_projected > 0.005 AND v_effective_promise_date IS NULL THEN
    RAISE EXCEPTION
      'Cannot mark order % as delivered with ₱% still owing and no promise date on record. Record a Promise Date or collect the balance first.',
      v_order.tracking_number,
      TO_CHAR(v_remaining_projected, 'FM999999990.00');
  END IF;

  -- Order metadata and ledger insertion remain in this single transaction.
  UPDATE public.orders
     SET delivery_photos       = COALESCE(p_delivery_photos, delivery_photos),
         payment_method        = COALESCE(p_payment_method, payment_method),
         payment_reference     = COALESCE(p_reference, payment_reference),
         promised_payment_date = COALESCE(p_promised_payment_date, promised_payment_date),
         status                = 'Delivered'
   WHERE id = p_order_id;

  IF COALESCE(p_amount, 0) > 0 THEN
    SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

    v_paid_after := v_total_paid_before + p_amount;
    v_label := CASE WHEN v_paid_after >= v_payable THEN 'paid' ELSE 'partial' END;

    BEGIN
      INSERT INTO public.payment_transactions (
        order_id, amount, payment_method, payment_status,
        transaction_reference, transaction_reference_normalized, gcash_channel,
        admin_id, admin_name, notes, payment_type, payment_date, receipt_url,
        idempotency_key
      ) VALUES (
        p_order_id, p_amount, 'gcash', v_label,
        p_reference, v_ref_norm, 'manual',
        auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
        p_payment_type, p_payment_date, p_receipt_url, p_idempotency_key
      );
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'This GCash reference was already recorded on another order. It cannot be credited again.'
        USING ERRCODE = '23505';
    END;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) TO service_role, authenticated;


CREATE OR REPLACE FUNCTION public.record_additional_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_payment_date date DEFAULT NULL::date,
  p_receipt_url text DEFAULT NULL::text,
  p_idempotency_key uuid DEFAULT NULL::uuid,
  p_admin_verified_receipt boolean DEFAULT false
)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order              public.orders;
  v_admin_name         TEXT;
  v_paid_before        NUMERIC;
  v_paid_after         NUMERIC;
  v_payable            NUMERIC;
  v_outstanding_before NUMERIC;
  v_label              TEXT;
  v_ref_norm           TEXT;
  v_idempotency_order_id UUID;
  v_method             TEXT := lower(COALESCE(p_payment_method, ''));
  v_type               TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT order_id INTO v_idempotency_order_id
      FROM public.payment_transactions
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_idempotency_order_id = p_order_id THEN
        RETURN v_order;
      END IF;
      RAISE EXCEPTION 'This payment attempt identifier is already associated with another order.'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  IF v_method = 'cash' THEN
    RAISE EXCEPTION 'Cash is no longer accepted once an order has been picked up. Collect the remaining balance via GCash.'
      USING ERRCODE = '22023';
  END IF;

  IF v_method <> 'gcash' THEN
    RAISE EXCEPTION 'Unsupported payment method: %', COALESCE(p_payment_method, '(missing)')
      USING ERRCODE = '22023';
  END IF;

  v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);

  SELECT COALESCE(SUM(amount), 0)
    INTO v_paid_before
    FROM public.payment_transactions
   WHERE order_id = p_order_id
     AND payment_status IN ('paid', 'partial');

  v_payable            := public.order_payable_amount(v_order.shipping_cost, v_order.discount_amount);
  v_outstanding_before := GREATEST(0, v_payable - v_paid_before);

  IF p_amount > v_outstanding_before + 0.005 THEN
    RAISE EXCEPTION 'Payment amount of ₱% exceeds the outstanding balance of ₱%.',
      TO_CHAR(p_amount, 'FM999999990.00'),
      TO_CHAR(v_outstanding_before, 'FM999999990.00')
      USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

  v_paid_after := v_paid_before + p_amount;
  v_label := CASE WHEN v_paid_after >= v_payable THEN 'paid' ELSE 'partial' END;
  v_type  := CASE
               WHEN v_label = 'paid' AND v_outstanding_before > 0.005 THEN 'Balance Settlement'
               ELSE 'Additional Payment'
             END;

  BEGIN
    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, transaction_reference_normalized, gcash_channel,
      admin_id, admin_name, notes, payment_type, payment_date, receipt_url,
      idempotency_key
    ) VALUES (
      p_order_id, p_amount, 'gcash', v_label,
      p_reference, v_ref_norm, 'manual',
      auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
      v_type, p_payment_date, p_receipt_url, p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This GCash reference was already recorded on another order. It cannot be credited again.'
      USING ERRCODE = '23505';
  END;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_additional_payment(uuid, numeric, text, text, text, date, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_additional_payment(uuid, numeric, text, text, text, date, text, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_additional_payment(uuid, numeric, text, text, text, date, text, uuid, boolean) TO service_role, authenticated;
