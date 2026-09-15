-- ============================================================
-- Correct the delivery-time payment rule: Cash or GCash while the admin is
-- physically receiving payment during delivery confirmation.
--
-- The blanket "GCash only after pickup" rule (20260909030000, tightened in
-- 20260912010000) was too broad. The actual business rule only forbids cash
-- for a balance settled AWAY from the handoff moment (record_additional_
-- payment, used by OrderDetailPage / UnsettledDeliveriesPage for a later,
-- out-of-band settlement) — because nobody is standing at a counter to
-- receive it there. During delivery confirmation itself, the admin/receiver
-- interaction is exactly the pickup counter's situation: money is changing
-- hands right now, so Cash is exactly as legitimate as GCash.
--
-- record_additional_payment() is UNCHANGED and stays GCash-only — it is the
-- correct implementation of "after delivery is completed, the remaining
-- balance can be settled through GCash", which this task explicitly keeps.
--
-- record_delivery_payment()'s signature is unchanged (still the 12-arg form
-- from 20260912010000), so this is a plain CREATE OR REPLACE — no DROP
-- FUNCTION / overload cleanup is needed.
--
-- Two changes to the function body:
--   1. The unconditional `v_method = 'cash' -> RAISE EXCEPTION` branch is
--      removed; 'cash' and 'gcash' are now both accepted. Only 'gcash' still
--      runs guard_manual_gcash_payment() (verification + reference required
--      + duplicate-reference guard) — cash has no reference to verify.
--   2. The ledger INSERT previously hardcoded payment_method = 'gcash' and
--      gcash_channel = 'manual' for EVERY row this function ever wrote, since
--      gcash was the only value that could reach that point. That hardcoding
--      is now wrong for a cash row (it would silently mislabel a cash
--      collection as a verified manual GCash transfer) — fixed to store the
--      actual method, and gcash_channel only when it truly is gcash.
--
-- Every other guard in this function is untouched: the idempotency-key
-- dedup/cross-order check, the 'Out for Delivery' lifecycle check, the
-- delivery-photo count check, the negative-amount check, the
-- discount-aware outstanding-balance cap (order_payable_amount), and the
-- promise-date requirement when a balance remains. Cash now simply passes
-- through the same authoritative checks GCash already had.
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
  v_gcash_channel          TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- The order lock makes a retry with the same key observe the first call's
  -- committed ledger row before deciding whether to do any work. This is the
  -- ONLY thing that stops a retried/double-clicked delivery confirmation
  -- from creating a second cash (or gcash) transaction — it does not depend
  -- on payment method, and nothing below it needs to duplicate this check.
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
    -- Cash or GCash: the admin is physically receiving this payment right
    -- now, during the same delivery-confirmation call — exactly the pickup
    -- counter's situation. A LATER, out-of-band balance settlement goes
    -- through record_additional_payment() instead, which stays GCash-only.
    IF v_method NOT IN ('cash', 'gcash') THEN
      RAISE EXCEPTION 'Unsupported payment method: %', COALESCE(p_payment_method, '(missing)')
        USING ERRCODE = '22023';
    END IF;

    IF v_method = 'gcash' THEN
      -- All GCash money entered through this RPC is a verified manual
      -- transfer (the automated PayMongo checkout settles through the
      -- webhook's own reconcile RPC, never through this parameter).
      v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);
      v_gcash_channel := 'manual';
    END IF;
    -- Cash needs no reference, no verification checkbox, and no
    -- gcash_channel — it is recorded as exactly what it is.
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
        -- Store the actual method collected (was hardcoded 'gcash' for every
        -- row this function wrote, back when gcash was the only value that
        -- could reach here). gcash_channel stays NULL for a cash row.
        p_order_id, p_amount, v_method, v_label,
        p_reference, v_ref_norm, v_gcash_channel,
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

-- Signature is unchanged from 20260912010000 — REVOKE/GRANT already in
-- effect for this exact signature and does not need to be reissued, but is
-- repeated here so this migration is self-sufficient to read in isolation.
REVOKE ALL ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) TO service_role, authenticated;

-- ============================================================
-- VERIFY (must return exactly 1 row on any database):
--   SELECT COUNT(*) FROM pg_proc WHERE proname = 'record_delivery_payment';
-- ============================================================
