-- ==============================================================================
-- CARGOEXPRESS PH: FIX TRIP STATUSES & AUTO-COMPLETE TRIGGER
-- ==============================================================================
-- 1. Itinutuwid ang mga biyahe (tulad ng TRIP-20261019-678) na naging 'completed'
--    kahit may mga kargamento pang 'Out for Delivery' o 'Arrived at Hub'.
--    Ibabalik ang mga ito sa 'arrived' (aktibo sa hub).
-- 2. Lumilikha ng awtomatikong trigger sa database upang kapag nai-deliver
--    na ang HULING order sa isang biyahe, kusa itong magiging 'completed'.
-- ==============================================================================

BEGIN;

-- Hakbang 1: Pansamantalang i-disable ang triggers upang payagan ang pag-rollback ng maling 'completed' trips
ALTER TABLE public.trips DISABLE TRIGGER USER;

-- Hakbang 2: Ayusin ang status ng mga biyahe batay sa totoong estado ng kanilang mga orders

-- 2a. Kung nakarating na sa hub (may arrived_at) pero may orders pang hindi Delivered/Cancelled:
--     DAPAT 'arrived' ito at aktibo! (Kabilang dito ang TRIP-20261019-678)
UPDATE public.trips t
SET status = 'arrived'
WHERE t.arrived_at IS NOT NULL
  AND EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- 2b. Kung nakaalis na pero wala pang arrived_at at may orders pang hindi Delivered:
--     DAPAT 'in_progress' ito!
UPDATE public.trips t
SET status = 'in_progress'
WHERE t.departure_at IS NOT NULL
  AND t.arrived_at IS NULL
  AND EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- 2c. Kung DELIVERED o CANCELLED na ang LAHAT ng kargamento sa biyahe:
--     DAPAT 'completed' ito!
UPDATE public.trips t
SET status = 'completed'
WHERE t.id IN (SELECT DISTINCT trip_id FROM public.orders WHERE trip_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- Hakbang 3: Ibalik agad ang triggers sa trips
ALTER TABLE public.trips ENABLE TRIGGER USER;

-- Hakbang 4: Function at Trigger para sa Automatic Trip Completion
-- Kapag naging 'Delivered' ang isang order, titingnan kung tapos na ang lahat sa biyahe.
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

  -- Kung aktibo sa hub ('arrived'):
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

DROP TRIGGER IF EXISTS orders_auto_complete_trip ON public.orders;
CREATE TRIGGER orders_auto_complete_trip
AFTER UPDATE OF status, remaining_balance ON public.orders
FOR EACH ROW
WHEN (NEW.status = 'Delivered' OR (NEW.status IN ('Delivered', 'Cancelled') AND COALESCE(NEW.remaining_balance, 0) <= 0))
EXECUTE FUNCTION public.auto_complete_trip_on_all_orders_delivered();

-- Hakbang 5: Ipakita ang bagong status ng mga biyahe
SELECT 
  id, 
  trip_number, 
  status AS updated_status, 
  arrived_at,
  (SELECT count(*) FROM public.orders WHERE trip_id = trips.id) AS total_orders,
  (SELECT count(*) FROM public.orders WHERE trip_id = trips.id AND status = 'Delivered') AS delivered_orders,
  (SELECT count(*) FROM public.orders WHERE trip_id = trips.id AND status = 'Out for Delivery') AS out_for_delivery_orders
FROM public.trips
ORDER BY created_at DESC;

COMMIT;
