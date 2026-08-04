-- ============================================================
-- 20260804100000_settlement_guards.sql
--
-- Phase 1b — Enforce the CargoExpress settlement rules in the database.
--
-- BUSINESS RULES (confirmed 2026-08-04):
--   1. Cargo always travels to the destination warehouse, paid or not.
--      An UNPAID shipment is then HELD there — it is not dispatched for
--      doorstep delivery until the balance is settled.
--   2. Exception: an admin may dispatch anyway by recording a PROMISE DATE.
--      That is the override, and it is logged.
--   3. Freight Collect (payer_type = 'receiver') is EXEMPT from the hold —
--      payment is due at the door, so a COD order is unpaid by definition
--      until delivery. Gating it would deadlock it in the warehouse forever.
--   4. A TRIP cannot be completed while any of its orders still owes money.
--
-- DESIGN NOTE — why `Delivered` is NOT gated on payment:
--   `orders.status` answers "where is the cargo"; `payment_status` answers
--   "where is the money". Rule 2 describes a real state — goods handed over,
--   balance owing, payment promised — which is only representable if the two
--   stay independent. Gating Delivered would strand that parcel at
--   "Out for Delivery" and show the customer a tracking timeline that
--   contradicts the box in their hands.
--
-- No new columns: promised_payment_date and remaining_balance already exist.
-- ============================================================


-- ============================================================
-- 1. record_delivery_payment — accept a Promise Date
--
-- DeliveryModal had no way to record a partial or zero collection at the door
-- (it hardcoded the full balance), and no way to capture a promise. Both are
-- required by rule 2.
--
-- The parameter list changes, so the old signature must be DROPped rather
-- than replaced — CREATE OR REPLACE with a different arg list would create a
-- second overload and make the PostgREST RPC call ambiguous.
-- ============================================================

DROP FUNCTION IF EXISTS public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT);

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
  v_order      public.orders;
  v_admin_name TEXT;
  v_paid_after NUMERIC;
  v_label      TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
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
-- 2. guard_order_update — the warehouse dispatch gate
--
-- Unchanged from the previous version except for the final block. The gate
-- fires only on the TRANSITION into 'Out for Delivery', so an order already
-- dispatched is never re-checked by an unrelated later update.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_order_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  trip_row public.trips%ROWTYPE;
  weight NUMERIC;
  price NUMERIC;
  next_weight NUMERIC;
BEGIN
  IF NEW.trip_id IS NOT NULL AND NEW.status <> 'Cancelled' THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
    weight := COALESCE(NEW.actual_weight, NEW.package_weight, 0);
    next_weight := public.current_trip_weight(NEW.trip_id, NEW.id) + weight;
    -- Capacity check removed to allow administrators to manually exceed limits.

    IF OLD.trip_id IS DISTINCT FROM NEW.trip_id AND NEW.status = 'Pending' THEN
      NEW.status := 'Assigned';
    END IF;
  END IF;

  IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN
    weight := COALESCE(NEW.actual_weight, NEW.package_weight, 0);
    price := CASE
      WHEN NEW.trip_id IS NOT NULL THEN public.effective_trip_price(NEW.trip_id)
      ELSE public.global_price_per_kilo()
    END;
    NEW.shipping_cost := ROUND(weight * price, 2);
    NEW.remaining_balance := GREATEST(0, NEW.shipping_cost - COALESCE(NEW.amount_paid, 0));
  END IF;

  -- ── Warehouse dispatch gate (Phase 1b) ───────────────────────────────────
  -- Placed last so it sees the recomputed remaining_balance above.
  IF NEW.status = 'Out for Delivery' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF COALESCE(NEW.payer_type, 'sender') <> 'receiver'
       AND COALESCE(NEW.remaining_balance, 0) > 0
       AND NEW.promised_payment_date IS NULL
    THEN
      RAISE EXCEPTION
        'Cannot dispatch order % — ₱% is still owing. Settle the balance, or record a Promise Date to dispatch anyway.',
        NEW.tracking_number,
        TO_CHAR(COALESCE(NEW.remaining_balance, 0), 'FM999999990.00');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- 3. guard_trip_completion — a trip cannot complete while money is owed
--
-- This is the enforceable reading of "an order can never be tagged Completed
-- while unpaid": orders have no Completed status (their flow ends at
-- Delivered), but trips do.
--
-- Safe to add: updateTrip's cascade map covers in_progress / arrived /
-- cancelled only — 'completed' touches no order rows, so this guard is
-- standalone.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_trip_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count     INT;
  v_unsettled TEXT;
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    SELECT COUNT(*)
      INTO v_count
      FROM public.orders
     WHERE trip_id = NEW.id
       AND status <> 'Cancelled'
       AND COALESCE(remaining_balance, 0) > 0;

    IF v_count > 0 THEN
      SELECT STRING_AGG(tracking_number, ', ')
        INTO v_unsettled
        FROM (
          SELECT tracking_number
            FROM public.orders
           WHERE trip_id = NEW.id
             AND status <> 'Cancelled'
             AND COALESCE(remaining_balance, 0) > 0
           ORDER BY tracking_number
           LIMIT 5
        ) t;

      -- The truncation marker is appended to the string, NOT passed as another
      -- RAISE argument: '%%' in a RAISE format string is an escaped literal '%',
      -- not two placeholders, so the earlier version passed 4 arguments to a
      -- 2-placeholder format and failed to compile with
      --   ERROR 42601: too many parameters specified for RAISE
      IF v_count > 5 THEN
        v_unsettled := v_unsettled || ' …';
      END IF;

      RAISE EXCEPTION
        'Cannot complete trip % — % order(s) still have an unpaid balance: %',
        NEW.trip_number,
        v_count,
        v_unsettled;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trips_guard_completion ON public.trips;
CREATE TRIGGER trips_guard_completion
  BEFORE UPDATE OF status ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_completion();


-- ============================================================
-- VERIFY (run manually):
--
--   -- Orders that would now be blocked from dispatch:
--   SELECT tracking_number, payer_type, remaining_balance, promised_payment_date
--   FROM orders
--   WHERE status = 'Arrived at Hub'
--     AND COALESCE(payer_type,'sender') <> 'receiver'
--     AND remaining_balance > 0
--     AND promised_payment_date IS NULL;
--
--   -- Trips that can no longer be completed:
--   SELECT t.trip_number, count(*) AS unsettled
--   FROM trips t JOIN orders o ON o.trip_id = t.id
--   WHERE t.status <> 'completed' AND o.status <> 'Cancelled'
--     AND COALESCE(o.remaining_balance,0) > 0
--   GROUP BY t.trip_number;
-- ============================================================
