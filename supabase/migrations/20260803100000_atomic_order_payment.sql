-- ============================================================
-- 20260803100000_atomic_order_payment.sql
--
-- P0-1 — Make the ledger the sole writer of order payment totals.
--
-- BEFORE: the admin pickup/delivery flow ran two separate round trips —
--   (1) UPDATE orders SET amount_paid/remaining_balance/payment_status  (client-computed)
--   (2) INSERT payment_transactions  → trigger recomputes the same three columns
-- If (2) failed (e.g. unique_tx_ref 23505 on a retried or webhook-raced
-- reference, which recordPaymentTransaction did not handle), the order was
-- left marked paid with ZERO backing ledger rows. get_sales_summary() sums
-- orders.amount_paid, so the drift propagated into revenue reporting.
--
-- AFTER: one transaction per pickup/delivery. These RPCs write order METADATA
-- only; update_order_payment_totals derives amount_paid / remaining_balance /
-- payment_status from the ledger, exactly as reconcile_paymongo_payment_attempt
-- already does.
--
-- Ordering inside each RPC is load-bearing:
--   1. UPDATE orders  → fires guard_order_update, which recomputes shipping_cost
--                       from the new actual_weight.
--   2. INSERT ledger  → fires update_order_payment_totals, which READS that
--                       shipping_cost to derive the remaining balance.
-- Reversing these two steps would derive the balance from a stale cost.
--
-- Idempotency: the ledger INSERT uses the same ON CONFLICT arbiter as the
-- PayMongo reconcile RPC. The index predicate is required to infer the PARTIAL
-- unique index unique_tx_ref. Rows with a NULL reference (cash) never conflict.
-- ============================================================


-- ─── Pickup ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_pickup_payment(
  p_order_id              UUID,
  p_actual_weight         NUMERIC,
  p_payment_method        TEXT,
  p_payer_type            TEXT    DEFAULT 'sender',
  p_pickup_photos         JSONB   DEFAULT '[]'::jsonb,
  p_promised_payment_date DATE    DEFAULT NULL,
  p_amount                NUMERIC DEFAULT NULL,
  p_reference             TEXT    DEFAULT NULL,
  p_payment_date          DATE    DEFAULT NULL,
  p_receipt_url           TEXT    DEFAULT NULL,
  p_payment_type          TEXT    DEFAULT 'Initial Payment',
  p_notes                 TEXT    DEFAULT 'Initial pickup payment'
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order      public.orders;
  v_admin_name TEXT;
  v_paid_after NUMERIC;
  v_label      TEXT;
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

  IF COALESCE(p_actual_weight, 0) <= 0 THEN
    RAISE EXCEPTION 'Actual weight must be greater than zero';
  END IF;

  -- Step 1 — order metadata ONLY.
  -- amount_paid / remaining_balance / payment_status are deliberately absent:
  -- the ledger trigger owns them.
  UPDATE public.orders
     SET actual_weight         = p_actual_weight,
         payment_method        = p_payment_method,
         payer_type            = COALESCE(p_payer_type, payer_type, 'sender'),
         pickup_photos         = COALESCE(p_pickup_photos, pickup_photos),
         promised_payment_date = p_promised_payment_date,
         payment_reference     = COALESCE(p_reference, payment_reference),
         status                = 'Picked Up'
   WHERE id = p_order_id;

  -- Step 2 — the ledger, only when money actually changed hands.
  IF COALESCE(p_amount, 0) > 0 THEN
    SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

    SELECT COALESCE(SUM(amount), 0) + p_amount
      INTO v_paid_after
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial');

    -- Per-transaction label. Must be 'paid' or 'partial' — those are the only
    -- two values update_order_payment_totals counts toward amount_paid.
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
      p_order_id, p_amount, p_payment_method, v_label,
      p_reference, auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
      p_payment_type, p_payment_date, p_receipt_url
    )
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;
  END IF;

  -- Re-read AFTER the ledger trigger has recomputed the totals.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$$;


-- ─── Delivery ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_delivery_payment(
  p_order_id        UUID,
  p_delivery_photos JSONB   DEFAULT '[]'::jsonb,
  p_payment_method  TEXT    DEFAULT NULL,
  p_amount          NUMERIC DEFAULT NULL,
  p_reference       TEXT    DEFAULT NULL,
  p_payment_date    DATE    DEFAULT NULL,
  p_receipt_url     TEXT    DEFAULT NULL,
  p_payment_type    TEXT    DEFAULT 'Balance Settlement',
  p_notes           TEXT    DEFAULT 'Balance settlement upon delivery'
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order      public.orders;
  v_admin_name TEXT;
  v_paid_after NUMERIC;
  v_label      TEXT;
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

  -- Step 1 — order metadata ONLY (see the pickup RPC for why).
  UPDATE public.orders
     SET delivery_photos   = COALESCE(p_delivery_photos, delivery_photos),
         payment_method    = COALESCE(p_payment_method, payment_method),
         payment_reference = COALESCE(p_reference, payment_reference),
         status            = 'Delivered'
   WHERE id = p_order_id;

  -- Step 2 — the ledger.
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


-- Both RPCs gate on public.is_admin() internally. Revoking the implicit
-- PUBLIC grant keeps anon from probing them at all.
REVOKE EXECUTE ON FUNCTION public.record_pickup_payment(UUID, NUMERIC, TEXT, TEXT, JSONB, DATE, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_pickup_payment(UUID, NUMERIC, TEXT, TEXT, JSONB, DATE, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;
