-- ============================================================
-- 20260805120000_payment_status_on_weight_edit.sql
--
-- CRITICAL — a re-weighed order kept a stale "Paid" badge.
--
-- ── THE BUG ──────────────────────────────────────────────────────────────
--
-- Two triggers write the money columns, and only one of them wrote all three:
--
--   update_order_payment_totals  fires on payment_transactions.
--                                Sets amount_paid, remaining_balance AND
--                                payment_status.
--
--   guard_order_update           fires on orders.
--                                Recomputed shipping_cost and
--                                remaining_balance, but NOT payment_status.
--
-- So correcting a weight moved the money and left the label behind:
--
--   order settled in full        -> payment_status 'paid', balance ₱0.00
--   admin corrects +2 kg         -> shipping_cost rises, balance ₱160.00
--   badge still reads            -> "Paid"
--
-- Reproduced on the live database before this migration: status=paid,
-- balance=160.00. An admin reading that screen would dispatch cargo with
-- ₱160 uncollected, and the warehouse gate in this same function would let
-- it through, because the gate tests remaining_balance while the human
-- tests the badge.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
--
-- One helper both triggers call, so the two paths cannot drift again. The
-- rule is expressed once and derived from the only two facts that matter:
-- what is owed, and what has been paid.
--
-- It also corrects a second, quieter case in update_order_payment_totals:
-- `IF v_remaining <= 0 THEN 'paid'` marked an order with NOTHING BILLED and
-- nothing paid as 'paid', because 0 - 0 = 0. A booking that has not been
-- priced yet is unpaid, not settled. That matters more from here on, since
-- orders are no longer priced at booking time.
-- ============================================================


-- ============================================================
-- 1. The rule, in one place
-- ============================================================

CREATE OR REPLACE FUNCTION public.derive_payment_status(
  p_shipping_cost NUMERIC,
  p_amount_paid   NUMERIC
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    -- Nothing collected. Also covers an unpriced booking (cost 0, paid 0),
    -- which the old `remaining <= 0` test wrongly called 'paid'.
    WHEN COALESCE(p_amount_paid, 0) <= 0 THEN 'unpaid'
    -- Settled. The half-centavo tolerance absorbs DECIMAL(10,2) rounding so
    -- a fully paid order is never left one centavo short of 'paid'.
    WHEN COALESCE(p_amount_paid, 0) >= COALESCE(p_shipping_cost, 0) - 0.005 THEN 'paid'
    ELSE 'partial'
  END;
$$;

REVOKE ALL ON FUNCTION public.derive_payment_status(NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derive_payment_status(NUMERIC, NUMERIC) TO authenticated, service_role;


-- ============================================================
-- 2. guard_order_update — recompute the label with the money
--
-- Unchanged except for the single new line in the recompute block. It sits
-- with shipping_cost and remaining_balance deliberately: the three are one
-- fact about an order and must never be written apart.
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
    -- THE FIX: the badge follows the balance. Without this line a re-weighed
    -- order kept whatever label it had before the correction.
    NEW.payment_status := public.derive_payment_status(NEW.shipping_cost, NEW.amount_paid);
  END IF;

  -- ── Warehouse dispatch gate (20260804100000) ─────────────────────────────
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
-- 3. The ledger trigger uses the same rule
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_paid    DECIMAL(10,2);
  v_shipping_cost DECIMAL(10,2);
  v_remaining     DECIMAL(10,2);
  v_order_id      UUID;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.payment_transactions
  WHERE order_id = v_order_id AND payment_status IN ('paid', 'partial');

  SELECT shipping_cost INTO v_shipping_cost
  FROM public.orders
  WHERE id = v_order_id;

  v_remaining := GREATEST(0, COALESCE(v_shipping_cost, 0) - v_total_paid);

  UPDATE public.orders
  SET amount_paid       = v_total_paid,
      remaining_balance = v_remaining,
      payment_status    = public.derive_payment_status(v_shipping_cost, v_total_paid)
  WHERE id = v_order_id;

  RETURN NULL;
END;
$$;


-- ============================================================
-- 4. Repair any order already carrying a stale label
--
-- Scoped to rows that actually disagree, so untouched orders keep their
-- updated_at and nothing is rewritten for the sake of it. Measured before
-- applying: 0 rows on the live database — the bug was found by reading the
-- triggers, not by a customer being wrongly billed. The repair is kept
-- because the same drift can exist in any environment restored from an
-- older dump.
-- ============================================================

UPDATE public.orders o
   SET payment_status = public.derive_payment_status(o.shipping_cost, o.amount_paid)
 WHERE o.payment_status IS DISTINCT FROM
       public.derive_payment_status(o.shipping_cost, o.amount_paid);


-- ============================================================
-- VERIFY (must return 0):
--   SELECT COUNT(*) FROM orders
--    WHERE payment_status IS DISTINCT FROM
--          derive_payment_status(shipping_cost, amount_paid);
--
--   -- and the original scenario, which used to leave 'paid':
--   -- take a settled order, add 2 kg, expect 'partial' with a balance owing
-- ============================================================
