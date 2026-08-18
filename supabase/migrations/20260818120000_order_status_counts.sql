-- Counts per order status, for the admin Bookings filter badges.
--
-- The list is paginated server-side, so the 15 rows on screen can say nothing
-- about how many orders are waiting overall — which is exactly what the badges
-- have to answer ("is anything waiting on me right now?").
--
-- Returns raw per-status counts rather than the four group totals the UI shows.
-- The grouping is a presentation decision that has already changed once; a
-- function that returned {actionNeeded, pending, active} would have to be
-- migrated every time the tabs are regrouped, and would answer only this one
-- screen's question. Per-status is the fact, the grouping is the opinion.
--
-- One grouped aggregate over idx_orders_status, one round trip, no per-tab
-- COUNT queries.

CREATE OR REPLACE FUNCTION public.get_order_status_counts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT COALESCE(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
    INTO payload
  FROM (
    SELECT status, COUNT(*) AS n
      FROM public.orders
     GROUP BY status
  ) s;

  -- A status with no orders is simply absent; the client reads a missing key
  -- as 0. Padding every known status with a zero here would invent rows the
  -- table does not have.
  RETURN payload;
END;
$function$;

COMMENT ON FUNCTION public.get_order_status_counts() IS
  'Admin-only. {status: count} across all orders, for the Bookings filter badges. Absent key = 0.';

REVOKE ALL ON FUNCTION public.get_order_status_counts()
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_order_status_counts()
  TO authenticated;
