BEGIN;

-- When an order moves to 'Out for Delivery', reset verified_boxes to '{}' so
-- the driver/courier must scan every box again at the customer's doorstep
-- before marking the shipment as Delivered.
CREATE OR REPLACE FUNCTION public.reset_box_verification_on_out_for_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'Out for Delivery' AND OLD.status IS DISTINCT FROM 'Out for Delivery' THEN
    NEW.verified_boxes := '{}';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS orders_reset_box_verification_on_out_for_delivery ON public.orders;
CREATE TRIGGER orders_reset_box_verification_on_out_for_delivery
  BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (NEW.status = 'Out for Delivery' AND OLD.status IS DISTINCT FROM 'Out for Delivery')
  EXECUTE FUNCTION public.reset_box_verification_on_out_for_delivery();

-- Also reset any currently 'Out for Delivery' orders so they require doorstep verification scanning.
UPDATE public.orders
   SET verified_boxes = '{}'
 WHERE status = 'Out for Delivery';

COMMIT;
