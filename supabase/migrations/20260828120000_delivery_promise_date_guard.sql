-- ============================================================
-- Delivery promise-date guard, moved from JS-only to the database
--
-- PaymentCollectionPanel already refuses to let an admin submit a Pay-Later
-- delivery that would leave a balance owing with no promise date recorded
-- (see validatePaymentCollection's `needsPromiseDate`). That was the ONLY
-- place the rule lived — record_delivery_payment itself had no equivalent
-- check, so a direct RPC call (a future admin tool, a bug in some other
-- caller, or just a client that skips this validation) could mark an order
-- 'Delivered' with money still owing and no promise date anywhere on record
-- to chase it against later. Unlike the pickup-time equivalent, there is no
-- later gate that would catch this — Delivered is terminal, and nothing
-- downstream ever re-checks a delivered order's payment status.
--
-- This mirrors the client's own rule exactly (same math, same threshold),
-- now enforced as the actual authority rather than a courtesy. Projects the
-- balance FORWARD to include the payment being recorded in this same call,
-- so an admin settling the balance in full right now is never blocked by
-- their own payment.
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_delivery_payment(
  p_order_id              UUID,
  p_delivery_photos       JSONB   DEFAULT '[]'::jsonb,
  p_payment_method        TEXT    DEFAULT NULL,
  p_amount                NUMERIC DEFAULT NULL,
  p_reference             TEXT    DEFAULT NULL,
  p_payment_date          DATE    DEFAULT NULL,
  p_receipt_url           TEXT    DEFAULT NULL,
  p_payment_type          TEXT    DEFAULT 'Balance Settlement',
  p_notes                 TEXT    DEFAULT 'Balance settlement upon delivery',
  p_promised_payment_date DATE    DEFAULT NULL
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order                  public.orders;
  v_admin_name             TEXT;
  v_paid_after             NUMERIC;
  v_label                  TEXT;
  v_total_paid_projected   NUMERIC;
  v_remaining_projected    NUMERIC;
  v_effective_promise_date DATE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- ── Promise-date guard ──────────────────────────────────────────────────
  -- Sum the ledger as it stands, add the payment about to be recorded (never
  -- negative — a malformed p_amount must not reduce the projected total),
  -- and compare against shipping_cost exactly like update_order_payment_totals
  -- will a moment from now.
  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_paid_projected
    FROM public.payment_transactions
   WHERE order_id = p_order_id
     AND payment_status IN ('paid', 'partial');

  v_total_paid_projected := v_total_paid_projected + GREATEST(COALESCE(p_amount, 0), 0);
  v_remaining_projected  := GREATEST(0, COALESCE(v_order.shipping_cost, 0) - v_total_paid_projected);
  -- A date given in THIS call counts, same as one already on file — either
  -- is enough to satisfy the rule, matching needsPromiseDate's own check.
  v_effective_promise_date := COALESCE(p_promised_payment_date, v_order.promised_payment_date);

  IF v_remaining_projected > 0.005 AND v_effective_promise_date IS NULL THEN
    RAISE EXCEPTION
      'Cannot mark order % as delivered with ₱% still owing and no promise date on record. Record a Promise Date or collect the balance first.',
      v_order.tracking_number,
      TO_CHAR(v_remaining_projected, 'FM999999990.00');
  END IF;

  -- Step 1 — order metadata ONLY. The ledger owns the totals.
  UPDATE public.orders
     SET delivery_photos       = COALESCE(p_delivery_photos, delivery_photos),
         payment_method        = COALESCE(p_payment_method, payment_method),
         payment_reference     = COALESCE(p_reference, payment_reference),
         promised_payment_date = COALESCE(p_promised_payment_date, promised_payment_date),
         status                = 'Delivered'
   WHERE id = p_order_id;

  -- Step 2 — the ledger, only when money actually changed hands.
  IF COALESCE(p_amount, 0) > 0 THEN
    SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

    SELECT COALESCE(SUM(amount), 0) + p_amount
      INTO v_paid_after
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial');

    SELECT CASE
             WHEN v_paid_after >= COALESCE(shipping_cost, 0) THEN 'paid'
             ELSE 'partial'
           END
      INTO v_label
      FROM public.orders
     WHERE id = p_order_id;

    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, admin_id, admin_name, notes,
      payment_type, payment_date, receipt_url
    ) VALUES (
      p_order_id, p_amount, COALESCE(p_payment_method, 'cash'), v_label,
      p_reference, auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
      p_payment_type, p_payment_date, p_receipt_url
    )
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE) TO authenticated;

-- ============================================================
-- VERIFY:
--   -- Should now raise "still owing and no promise date on record":
--   SELECT record_delivery_payment(
--     '<a real order id with an unpriced or partially-paid balance>'::uuid,
--     '[]'::jsonb, NULL, NULL, NULL, NULL, NULL, 'Balance Settlement',
--     'test', NULL
--   );
--
--   -- Should succeed (promise date supplied in the same call):
--   SELECT record_delivery_payment(
--     '<same order id>'::uuid,
--     '[]'::jsonb, NULL, NULL, NULL, NULL, NULL, 'Balance Settlement',
--     'test', CURRENT_DATE + 3
--   );
-- ============================================================
