-- ============================================================
-- 20260805130000_remove_package_weight.sql
--
-- Remove the customer-declared "Estimated Weight" (orders.package_weight).
--
-- Customers now describe what they are sending in package_description only.
-- Weight enters the system once, from the scale at pickup, as actual_weight.
--
--
-- ── CONSEQUENCE, STATED PLAINLY ──────────────────────────────────────────
--
-- package_weight was not merely displayed — it was the ONLY price input a
-- booking had. prepare_order_insert multiplied it by the per-kilo rate to
-- produce shipping_cost, and refused any booking with a weight of zero.
--
-- With it gone, **a new booking has no price**: shipping_cost is 0 and
-- remaining_balance is 0 until an admin weighs the parcel at pickup. That is
-- unavoidable — weight was the only quantity in the pricing formula — and it
-- is arguably the point, since an estimate the customer supplied was exactly
-- what created the disputes this change removes. But it does mean the
-- booking confirmation can no longer quote a figure.
--
-- Two knock-on effects worth knowing:
--
--   * Trip capacity (current_trip_weight) now counts only parcels that have
--     been weighed. Orders booked but not yet picked up contribute 0 kg, so
--     the capacity readout understates a trip until pickup day. The capacity
--     CHECK was already removed in 20260526010000, so this is a display
--     figure, not a guard.
--
--   * An unpriced order is 'unpaid', not 'paid'. derive_payment_status
--     (20260805120000) already handles this: it keys on amount_paid rather
--     than on remaining_balance reaching zero, which the previous rule would
--     have read as settled for every ₱0 booking.
-- ============================================================


-- ============================================================
-- 1. Booking no longer prices itself
-- ============================================================

CREATE OR REPLACE FUNCTION public.prepare_order_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  trip_row public.trips%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Cannot create orders for another user';
  END IF;

  NEW.tracking_number := public.generate_order_tracking_number();
  NEW.actual_weight := NULL;
  NEW.payment_method := NULL;
  NEW.payment_status := 'unpaid';
  NEW.amount_paid := 0;
  NEW.promised_payment_date := NULL;
  NEW.payment_reference := NULL;
  NEW.pickup_photos := '[]'::jsonb;
  NEW.delivery_photos := '[]'::jsonb;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;
    NEW.status := 'Assigned';
    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
  ELSE
    NEW.status := 'Pending';
  END IF;

  -- No weight, no price. Both are set by guard_order_update the moment an
  -- admin records actual_weight at pickup. The old
  -- "Package weight must be greater than zero" guard is gone with the field
  -- it protected — keeping it would reject every booking.
  NEW.shipping_cost := 0;
  NEW.remaining_balance := 0;

  RETURN NEW;
END;
$$;


-- ============================================================
-- 2. Weight comes from the scale only
-- ============================================================

-- Parameter name matches the LIVE function (p_exclude_order_id, not
-- p_exclude_order as schema.sql had it): CREATE OR REPLACE cannot rename an
-- input parameter, it can only replace the body.
CREATE OR REPLACE FUNCTION public.current_trip_weight(p_trip_id UUID, p_exclude_order_id UUID DEFAULT NULL)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- actual_weight only: a booking that has not been weighed contributes
  -- nothing, because nothing is known about it.
  SELECT COALESCE(SUM(COALESCE(actual_weight, 0)), 0)
    FROM public.orders
   WHERE trip_id = p_trip_id
     AND status <> 'Cancelled'
     AND (p_exclude_order_id IS NULL OR id <> p_exclude_order_id);
$$;


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
BEGIN
  IF NEW.trip_id IS NOT NULL AND NEW.status <> 'Cancelled' THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;

    IF OLD.trip_id IS DISTINCT FROM NEW.trip_id AND NEW.status = 'Pending' THEN
      NEW.status := 'Assigned';
    END IF;
  END IF;

  IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN
    weight := COALESCE(NEW.actual_weight, 0);
    price := CASE
      WHEN NEW.trip_id IS NOT NULL THEN public.effective_trip_price(NEW.trip_id)
      ELSE public.global_price_per_kilo()
    END;
    NEW.shipping_cost := ROUND(weight * price, 2);
    NEW.remaining_balance := GREATEST(0, NEW.shipping_cost - COALESCE(NEW.amount_paid, 0));
    NEW.payment_status := public.derive_payment_status(NEW.shipping_cost, NEW.amount_paid);
  END IF;

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
-- 3. Public tracking stops reporting a weight nobody declared
--
-- The return type changes, so the function must be dropped and recreated
-- rather than replaced. It stays in place — smoke-check.mjs treats
-- track_order_public as a required invariant of schema.sql.
-- ============================================================

DROP FUNCTION IF EXISTS public.track_order_public(TEXT);

CREATE OR REPLACE FUNCTION public.track_order_public(p_tracking_number TEXT)
RETURNS TABLE (
  tracking_number VARCHAR,
  status VARCHAR,
  sender_name TEXT,
  receiver_name TEXT,
  origin VARCHAR,
  destination VARCHAR,
  package_description TEXT,
  actual_weight NUMERIC,
  shipping_cost NUMERIC,
  estimated_delivery TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.tracking_number,
    o.status,
    public.mask_name(o.sender_name)   AS sender_name,
    public.mask_name(o.receiver_name) AS receiver_name,
    o.origin,
    o.destination,
    o.package_description,
    o.actual_weight,
    o.shipping_cost,
    t.arrival_date AS estimated_delivery,
    o.created_at,
    o.updated_at
  FROM public.orders o
  LEFT JOIN public.trips t ON t.id = o.trip_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.track_order_public(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_order_public(TEXT) TO anon, authenticated;


-- ============================================================
-- 4. Drop the column
--
-- Last, so nothing still reads it. plpgsql bodies are not dependency-tracked
-- by Postgres, so a function left referencing the column would fail at call
-- time rather than at drop time — hence the ordering above.
-- ============================================================

ALTER TABLE public.orders DROP COLUMN IF EXISTS package_weight;


-- ============================================================
-- VERIFY:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'orders' AND column_name LIKE '%weight%';
--   -- expect actual_weight only
--
--   SELECT * FROM track_order_public('CE-...');   -- no package_weight column
--
-- ROLLBACK:
--   ALTER TABLE orders ADD COLUMN package_weight DECIMAL(10,2) DEFAULT 0;
--   -- then re-apply the previous bodies of prepare_order_insert,
--   -- guard_order_update, current_trip_weight and track_order_public.
--   -- Declared weights themselves are NOT recoverable after the drop.
-- ============================================================
