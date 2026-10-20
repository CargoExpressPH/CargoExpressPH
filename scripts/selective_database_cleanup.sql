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

-- Hakbang 4: I-update ang mga natirang trips na may sales/kargamento bilang 'completed'
UPDATE public.trips
SET status = 'completed'
WHERE id IN (SELECT DISTINCT trip_id FROM public.orders WHERE trip_id IS NOT NULL);

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
