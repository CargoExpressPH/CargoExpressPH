BEGIN;

-- Boxes are now verified while the booking is Picked Up (loading), not only
-- once it is Out for Delivery. The same verified_boxes set satisfies both the
-- Start Trip gate and the Delivered gate.
CREATE OR REPLACE FUNCTION public.record_box_verification(p_order_id UUID, p_box INTEGER)
RETURNS INTEGER[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order  public.orders;
  v_boxes  INTEGER[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status NOT IN ('Picked Up', 'Out for Delivery') THEN
    RAISE EXCEPTION 'Boxes can only be verified after pickup and before delivery.'
      USING ERRCODE = '22023';
  END IF;

  IF p_box IS NULL OR p_box < 1 OR p_box > v_order.package_quantity THEN
    RAISE EXCEPTION 'Box % does not belong to this booking (it has % box(es)).',
      p_box, v_order.package_quantity
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.orders
     SET verified_boxes = ARRAY(
           SELECT DISTINCT b FROM unnest(verified_boxes || p_box) AS b ORDER BY b
         )
   WHERE id = p_order_id
  RETURNING verified_boxes INTO v_boxes;

  RETURN v_boxes;
END;
$function$;

-- Every order that will actually travel must have all of its boxes verified
-- before the trip leaves. Same eligibility as the Start Trip button: orders
-- that are cancelled, awaiting a cancellation decision, or not yet picked up
-- are excluded here because the existing trip guard already handles them.
CREATE OR REPLACE FUNCTION public.require_box_verification_before_trip_start()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_unverified_count INT;
  v_example          TEXT;
BEGIN
  SELECT COUNT(*), MIN(o.tracking_number)
    INTO v_unverified_count, v_example
    FROM public.orders AS o
   WHERE o.trip_id = NEW.id
     AND o.status NOT IN ('Cancelled', 'Pending Cancellation', 'Pending', 'Assigned')
     AND NOT (COALESCE(o.verified_boxes, '{}') @> ARRAY(SELECT generate_series(1, o.package_quantity)));

  IF v_unverified_count > 0 THEN
    RAISE EXCEPTION 'Cannot start trip: % booking(s) have boxes whose package QR code has not been scanned (e.g. %). Scan every box before departure.',
      v_unverified_count, v_example
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trips_require_box_verification_before_start ON public.trips;
CREATE TRIGGER trips_require_box_verification_before_start
  BEFORE UPDATE OF status ON public.trips
  FOR EACH ROW
  WHEN (OLD.status = 'scheduled' AND NEW.status = 'in_progress')
  EXECUTE FUNCTION public.require_box_verification_before_trip_start();

COMMIT;
