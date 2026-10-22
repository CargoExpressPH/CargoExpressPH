BEGIN;

-- Allow 'Arrived at Hub' orders during the van loading/dispatch phase.
--
-- When inter-island cargo arrives at the destination hub, it sits at 'Arrived at Hub'.
-- Staff scan each box onto the local delivery van via "Scan to Load for Delivery"
-- before dispatching it to 'Out for Delivery'.
--
-- Valid states for box verification are therefore:
--   - Loading phase (origin van / vessel): 'Assigned', 'Picked Up'
--   - Loading phase (destination van dispatch): 'Arrived at Hub'
--   - Delivery phase (customer doorstep drop-off): 'Out for Delivery'
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

  IF v_order.status NOT IN ('Assigned', 'Picked Up', 'Arrived at Hub', 'Out for Delivery') THEN
    RAISE EXCEPTION 'Boxes can only be verified while loading (Assigned, Picked Up, or Arrived at Hub) or during delivery (Out for Delivery).'
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
