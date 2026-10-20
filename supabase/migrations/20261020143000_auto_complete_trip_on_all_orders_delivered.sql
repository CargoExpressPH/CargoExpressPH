-- Migration: 20261020143000_auto_complete_trip_on_all_orders_delivered.sql
-- Function & Trigger to automatically transition an 'arrived' trip to 'completed'
-- once all assigned orders have been delivered (or cancelled) and settled.

CREATE OR REPLACE FUNCTION public.auto_complete_trip_on_all_orders_delivered()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_undelivered_or_unpaid INT;
  v_trip_status TEXT;
BEGIN
  IF NEW.trip_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Kumuha ng status ng biyahe
  SELECT status INTO v_trip_status
  FROM public.trips
  WHERE id = NEW.trip_id;

  -- Kung aktibo sa destination hub ('arrived'):
  IF v_trip_status = 'arrived' THEN
    -- Bilangin kung may natitira pang hindi Delivered/Cancelled o may unpaid balance
    SELECT COUNT(*) INTO v_undelivered_or_unpaid
    FROM public.orders
    WHERE trip_id = NEW.trip_id
      AND (
        status NOT IN ('Delivered', 'Cancelled')
        OR COALESCE(remaining_balance, 0) > 0
      );

    -- Kapag 0 ang natira, kusa nang magiging 'completed' ang biyahe!
    IF v_undelivered_or_unpaid = 0 THEN
      UPDATE public.trips
      SET status = 'completed'
      WHERE id = NEW.trip_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.auto_complete_trip_on_all_orders_delivered() IS
  'Automatically completes an arrived trip once all its assigned bookings are Delivered or Cancelled and fully paid.';

DROP TRIGGER IF EXISTS orders_auto_complete_trip ON public.orders;
CREATE TRIGGER orders_auto_complete_trip
AFTER UPDATE OF status, remaining_balance ON public.orders
FOR EACH ROW
WHEN (NEW.status = 'Delivered' OR (NEW.status IN ('Delivered', 'Cancelled') AND COALESCE(NEW.remaining_balance, 0) <= 0))
EXECUTE FUNCTION public.auto_complete_trip_on_all_orders_delivered();
