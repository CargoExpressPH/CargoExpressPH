-- ============================================================================
-- Production integrity guards
-- ============================================================================
-- These checks belong in the database because the browser is not a trust
-- boundary. They close three customer-write paths that were previously
-- protected only by UI conventions.

-- A customer may review only an order they own, and only after delivery.
DROP POLICY IF EXISTS "Customers can insert own feedback" ON public.customer_feedback;
-- Guard added 2026-08-24: this migration's effects reached the live database
-- before it was recorded in the migration ledger, so a replay hit SQLSTATE
-- 42710 on the CREATE below. Dropping the new name first makes the migration
-- convergent (drop-then-create inside the migration transaction, so there is
-- no window where the table sits without an INSERT policy).
DROP POLICY IF EXISTS "Customers can insert own delivered-order feedback" ON public.customer_feedback;
CREATE POLICY "Customers can insert own delivered-order feedback"
  ON public.customer_feedback
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = customer_id
    AND EXISTS (
      SELECT 1
      FROM public.orders AS o
      WHERE o.id = customer_feedback.order_id
        AND o.user_id = auth.uid()
        AND o.status = 'Delivered'
    )
  );

-- Customer-created orders cannot self-publish website content, and cannot
-- book a trip that has already departed or has been closed. Admin/service-role
-- writes remain available for the staff publishing and dispatch workflows.
CREATE OR REPLACE FUNCTION public.guard_customer_order_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip_status TEXT;
  v_departure_at TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  NEW.featured_on_website := false;
  NEW.featured_title := NULL;
  NEW.featured_caption := NULL;
  NEW.featured_image_type := NULL;
  NEW.featured_at := NULL;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT t.status, t.departure_date
      INTO v_trip_status, v_departure_at
      FROM public.trips AS t
     WHERE t.id = NEW.trip_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    IF v_trip_status IN ('cancelled', 'completed')
       OR v_departure_at <= now() THEN
      RAISE EXCEPTION 'This trip is no longer accepting bookings';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_guard_customer_insert ON public.orders;
CREATE TRIGGER orders_guard_customer_insert
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_customer_order_insert();
