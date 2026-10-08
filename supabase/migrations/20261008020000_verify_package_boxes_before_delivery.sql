BEGIN;

-- Box numbers (1..package_quantity) the admin has scanned from the package QR
-- labels while the order is Out for Delivery.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS verified_boxes INTEGER[] NOT NULL DEFAULT '{}';

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

  IF v_order.status <> 'Out for Delivery' THEN
    RAISE EXCEPTION 'Boxes can only be verified while the order is Out for Delivery.'
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

REVOKE ALL ON FUNCTION public.record_box_verification(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_box_verification(UUID, INTEGER) TO authenticated;

-- Runs on every path into 'Delivered' (record_delivery_payment included).
-- Because it raises inside the same transaction, a failed check also rolls
-- back the payment insert, so the payment logic itself is not modified.
CREATE OR REPLACE FUNCTION public.require_all_boxes_verified_before_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (COALESCE(NEW.verified_boxes, '{}') @> ARRAY(SELECT generate_series(1, NEW.package_quantity))) THEN
    RAISE EXCEPTION 'Scan the QR code on every box (1 to %) before marking % as delivered.',
      NEW.package_quantity, NEW.tracking_number
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS orders_require_box_verification ON public.orders;
CREATE TRIGGER orders_require_box_verification
  BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (NEW.status = 'Delivered' AND OLD.status IS DISTINCT FROM 'Delivered')
  EXECUTE FUNCTION public.require_all_boxes_verified_before_delivery();

COMMIT;
