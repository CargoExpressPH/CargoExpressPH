-- ==============================================================================
-- CARGOEXPRESS PH - SELECTIVE OPERATIONAL DATA CLEANUP SCRIPT (V3 - BULLETPROOF)
-- ==============================================================================
-- MGA GAGAWIN:
--   1. Buburahin ang lahat ng CANCELLED bookings.
--   2. Buburahin ang mga test bookings na walang bayad (0 payment).
--   3. Pananatilihin ang lahat ng bookings na may sales/payments at Delivered.
--   4. Ise-set bilang 'completed' ang status ng mga biyahe (trips) ng mga natirang sales.
--   5. Buburahin ang lahat ng mga bakante/walang lamang trips (overdue, cancelled, atbp.).
--   6. Mananatili ang lahat ng user accounts (profiles, auth.users) at settings.
-- ==============================================================================

BEGIN;

-- Hakbang 1: Burahin ang lahat ng CANCELLED bookings
DELETE FROM public.orders
WHERE status = 'Cancelled';

-- Hakbang 2: Burahin ang mga test bookings na WALANG bayad (amount_paid = 0 o NULL) at hindi Delivered
DELETE FROM public.orders
WHERE COALESCE(amount_paid, 0) = 0
  AND status NOT IN ('Delivered');

-- Hakbang 3: Pansamantalang i-disable ang triggers sa trips para hindi mag-error ang status transition
ALTER TABLE public.trips DISABLE TRIGGER USER;

-- Hakbang 4: I-update nang wasto ang status ng mga biyahe ayon sa tunay na estado ng mga kargamento
-- 4a. Kung DELIVERED o CANCELLED na ang LAHAT ng kargamento sa biyahe: 'completed'
UPDATE public.trips t
SET status = 'completed'
WHERE t.id IN (SELECT DISTINCT trip_id FROM public.orders WHERE trip_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- 4b. Kung may mga kargamento pang hindi pa Delivered (Out for Delivery / Arrived at Hub) at nakarating na sa hub: 'arrived' (aktibo sa hub!)
UPDATE public.trips t
SET status = 'arrived'
WHERE t.id IN (SELECT DISTINCT trip_id FROM public.orders WHERE trip_id IS NOT NULL)
  AND t.arrived_at IS NOT NULL
  AND EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- 4c. Kung nasa biyahe pa (In Transit) at may departure timestamp pero wala pang arrived timestamp: 'in_progress'
UPDATE public.trips t
SET status = 'in_progress'
WHERE t.id IN (SELECT DISTINCT trip_id FROM public.orders WHERE trip_id IS NOT NULL)
  AND t.departure_at IS NOT NULL
  AND t.arrived_at IS NULL
  AND EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- Hakbang 5: Ibalik agad ang triggers sa trips
ALTER TABLE public.trips ENABLE TRIGGER USER;

-- Hakbang 6: Burahin ang mga Trips na WALA nang laman o kargamento (ang mga tunay na bakanteng biyahe)
DELETE FROM public.trips
WHERE id NOT IN (SELECT DISTINCT trip_id FROM public.orders WHERE trip_id IS NOT NULL);

-- Hakbang 7: Linisin ang mga lumang notifications na patungkol sa mga binurang orders/trips
DELETE FROM public.notifications
WHERE reference_id IS NOT NULL
  AND reference_id NOT IN (SELECT id FROM public.orders)
  AND reference_id NOT IN (SELECT id FROM public.trips);

-- Hakbang 8: Ipakita ang Buod ng Natira (Sales at Completed Trips)
SELECT 
  (SELECT count(*) FROM public.trips WHERE status = 'completed') AS natirang_completed_trips,
  (SELECT count(*) FROM public.orders) AS natirang_paid_orders,
  (SELECT COALESCE(SUM(amount_paid), 0) FROM public.orders) AS kabuuang_sales_preserved_php,
  (SELECT count(*) FROM public.payment_transactions) AS natirang_payment_transactions,
  (SELECT count(*) FROM public.orders WHERE status = 'Cancelled') AS natirang_cancelled_orders_dapat_zero;

COMMIT;
