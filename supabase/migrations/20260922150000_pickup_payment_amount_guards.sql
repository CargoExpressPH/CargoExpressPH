-- ============================================================
-- Migration: 20260922150000_pickup_payment_amount_guards.sql
-- Purpose  : Close two amount-validation gaps in record_pickup_payment().
--            Body is reproduced VERBATIM from
--            20260920120000_fix_pickup_payment_discount_race.sql except for
--            the two blocks marked "NEW (20260922150000)" and this header.
--
-- ── GAP 1 (audit F-02): negative p_amount was silently accepted ──────────
--   The function only ever inserted a ledger row under
--   `IF COALESCE(p_amount, 0) > 0`. A negative amount therefore fell through
--   that branch: the order was moved to 'Picked Up' with NO payment row, as
--   if the admin had deliberately collected nothing. The UI's shared
--   validator rejects a minus sign, and record_delivery_payment() has
--   rejected negatives server-side since 20260915100000 — pickup was the
--   odd one out, so a direct authenticated RPC call bypassed the only check.
--
--   Fixed by an explicit rejection placed BEFORE any mutation. Because the
--   whole RPC runs in one transaction, the RAISE leaves the booking and the
--   payment ledger completely unchanged.
--
--   Deliberately NOT changed — these remain valid and are covered by tests:
--     * p_amount IS NULL      -> Pay Later / no collection now.
--     * p_amount = 0          -> explicit zero collection.
--     * Freight Collect       -> payer_type 'receiver', collected at the door.
--     * Fully discounted      -> payable is 0, nothing to collect.
--     * PayMongo already paid -> the client sends no p_amount at all; the
--                                webhook's reconcile RPC owns that money.
--   Only a value strictly below zero is rejected. `-0.01` is rejected.
--
-- ── GAP 2 (audit P-01): no upper bound against the FINAL payable ─────────
--   The business decision recorded with this migration: money entered at the
--   pickup counter may not exceed what the booking still owes. An excess is
--   treated as an entry mistake to correct, NOT as a tip — this system has no
--   tip/gratuity/excess-collection model anywhere in its schema (verified:
--   no such column, table or RPC exists), so an accepted excess would land in
--   payment_transactions as an ordinary shipping payment. It would then
--   inflate shipping revenue in the sales/period reports and become
--   refundable as shipping money. Recording it that way would make the books
--   untrue, so it is refused rather than quietly absorbed.
--
--   WHY THE CHECK RUNS AFTER THE UPDATE, NOT BEFORE IT
--   A new booking has no price. shipping_cost is derived by
--   guard_order_update() from actual_weight x the trip's effective rate at
--   the moment the weight lands, and the discount is written by this same
--   statement. So BEFORE the UPDATE there is no authoritative payable to
--   compare against — v_order.shipping_cost is still the pre-weighing value
--   (typically 0) and the client's figure is an ESTIMATE from a price-per-kilo
--   preview (PickupModal sets capAtExpected: false for exactly this reason,
--   and that stays false — the browser must not be the one capping).
--   The check therefore re-reads the order AFTER the UPDATE, when
--   shipping_cost and discount_amount are the database's own post-weighing,
--   post-discount values, and subtracts refund-aware payments already on the
--   ledger. This mirrors record_additional_payment() and
--   record_delivery_payment(), which have both enforced the same bound since
--   20260919020000 / 20260915100000.
--
--   Raising here rolls the transaction back in full: the weight, the status
--   change, the discount and the ledger are all left exactly as they were.
--   Nothing is half-applied, and the admin can re-submit a corrected amount.
--
--   MONEY ALREADY RECEIVED IS NEVER ERASED BY THIS CHECK. A payment that
--   PayMongo confirmed was inserted by the webhook's own reconcile RPC in a
--   separate, already-committed transaction. This function does not touch,
--   reverse or re-label those rows — it only counts them when working out
--   what is still owed, and only ever refuses the NEW amount being entered
--   now. A pickup finished after a PayMongo settlement sends p_amount NULL
--   and never reaches this check at all.
--
--   The 0.005 tolerance is the same one used by the two sibling RPCs: it
--   absorbs half-centavo rounding in the weight x rate product, not a real
--   overpayment.
--
-- DEPENDENCY
--   The refund-aware part reads public.payment_refunds, created in
--   20260912184434_paymongo_refunds_and_failures.sql — well before this
--   migration, and already read the same way by record_additional_payment()
--   and record_delivery_payment() since 20260919020000. Any test harness
--   that scaffolds its own orders/payment_transactions tables in order to
--   exercise this function must provide payment_refunds too.
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
  -- NEW (20260922150000) — authoritative post-weighing settlement figures.
  v_gross_paid_before     NUMERIC;
  v_refunded_before       NUMERIC;
  v_paid_before           NUMERIC;
  v_payable               NUMERIC;
  v_outstanding           NUMERIC;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- ── NEW (20260922150000) — GAP 1: reject a negative collection ─────────
  -- Placed before the row is even locked, so an invalid amount cannot touch
  -- the booking, the discount or the ledger. NULL and 0 fall through
  -- untouched: they are the supported "nothing collected now" cases.
  IF p_amount IS NOT NULL AND p_amount < 0 THEN
    RAISE EXCEPTION 'Payment amount cannot be negative (received ₱%). Enter ₱0.00 or leave it blank if nothing was collected.',
      TO_CHAR(p_amount, 'FM999999990.00')
      USING ERRCODE = '22023';
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

  -- ── NEW (20260922150000) — GAP 2: cap against the FINAL payable ────────
  -- Re-read AFTER the UPDATE: guard_order_update() has now recomputed
  -- shipping_cost from the measured weight and this trip's rate, and the
  -- discount decided above is committed to the row. This, minus payments
  -- already on the ledger net of succeeded refunds, is the authoritative
  -- amount still payable — never a stale remaining_balance and never the
  -- browser's estimate.
  IF COALESCE(p_amount, 0) > 0 THEN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;

    SELECT COALESCE(SUM(amount), 0)
      INTO v_gross_paid_before
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial');

    SELECT COALESCE(SUM(amount), 0)
      INTO v_refunded_before
      FROM public.payment_refunds
     WHERE order_id = p_order_id
       AND status = 'succeeded';

    v_paid_before := GREATEST(0, v_gross_paid_before - v_refunded_before);
    v_payable     := public.order_payable_amount(v_order.shipping_cost, v_order.discount_amount);
    v_outstanding := GREATEST(0, v_payable - v_paid_before);

    IF p_amount > v_outstanding + 0.005 THEN
      RAISE EXCEPTION
        'The entered amount of ₱% exceeds the amount still payable by ₱%. Please check the amount. Extra money is not automatically recorded as a tip.',
        TO_CHAR(p_amount, 'FM999999990.00'),
        TO_CHAR(p_amount - v_outstanding, 'FM999999990.00')
        USING ERRCODE = '22023',
              DETAIL  = 'Amount still payable: ' || TO_CHAR(v_outstanding, 'FM999999990.00')
                        || ' (fee ' || TO_CHAR(COALESCE(v_order.shipping_cost, 0), 'FM999999990.00')
                        || ' less discount ' || TO_CHAR(COALESCE(v_order.discount_amount, 0), 'FM999999990.00')
                        || ' less payments already received ' || TO_CHAR(v_paid_before, 'FM999999990.00') || ').',
              HINT    = 'Correct the amount to the amount still payable, or record the excess outside this booking.';
    END IF;
  END IF;

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
