BEGIN;

-- Extend box verification to allow 'Assigned' orders during van loading.
--
-- Previously only 'Picked Up' was allowed for the loading phase. In practice
-- cargo may be loaded onto the van before the formal pickup step is completed,
-- so a scan for an 'Assigned' order is a valid loading-phase event.
--
-- 'Out for Delivery' remains the only doorstep-delivery phase. The
-- require_box_verification_before_trip_start trigger is unchanged: 'Assigned'
-- orders are still excluded from the mandatory scan gate, so a trip can start
-- even if some assigned-but-not-picked-up orders haven't been scanned.
CREATE OR REPLACE FUNCTION public.record_box_verification(
  p_order_id UUID,
  p_box      INTEGER,
  p_method   TEXT DEFAULT 'qr',
  p_reason   TEXT DEFAULT NULL
)
RETURNS INTEGER[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order  public.orders;
  v_boxes  INTEGER[];
  v_new    BOOLEAN;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required' USING ERRCODE = '42501';
  END IF;

  IF p_method NOT IN ('qr', 'manual_fallback') THEN
    RAISE EXCEPTION 'Unknown verification method.' USING ERRCODE = '22023';
  END IF;
  IF p_method = 'manual_fallback' AND p_reason IS NULL THEN
    RAISE EXCEPTION 'Choose why the QR could not be scanned.' USING ERRCODE = '22023';
  END IF;
  IF p_method = 'qr' THEN
    p_reason := NULL;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0002';
  END IF;

  -- Loading phase: 'Assigned' (cargo assigned to trip, pickup in progress) and
  -- 'Picked Up' (pickup confirmed) are both valid states for van loading.
  -- Delivery phase: 'Out for Delivery' only.
  IF v_order.status NOT IN ('Assigned', 'Picked Up', 'Out for Delivery') THEN
    RAISE EXCEPTION 'Boxes can only be verified while loading (Assigned or Picked Up) or during delivery (Out for Delivery).'
      USING ERRCODE = '22023';
  END IF;

  IF p_box IS NULL OR p_box < 1 OR p_box > v_order.package_quantity THEN
    RAISE EXCEPTION 'Box % does not belong to this booking (it has % box(es)).',
      p_box, v_order.package_quantity
      USING ERRCODE = '22023';
  END IF;

  v_new := NOT (p_box = ANY (COALESCE(v_order.verified_boxes, '{}')));

  UPDATE public.orders
     SET verified_boxes = ARRAY(
           SELECT DISTINCT b FROM unnest(verified_boxes || p_box) AS b ORDER BY b
         )
   WHERE id = p_order_id
  RETURNING verified_boxes INTO v_boxes;

  IF v_new THEN
    INSERT INTO public.box_scan_events (order_id, trip_id, box_number, phase, method, reason, actor_id)
    VALUES (
      p_order_id, v_order.trip_id, p_box,
      CASE WHEN v_order.status = 'Out for Delivery' THEN 'deliver' ELSE 'load' END,
      p_method, p_reason, auth.uid()
    );
  END IF;

  RETURN v_boxes;
END;
$function$;

COMMIT;
