-- ==============================================================================
-- CARGOEXPRESS PH - SELECTIVE OPERATIONAL DATA CLEANUP SCRIPT
-- ==============================================================================
-- MGA PANUNTUNAN NG PAGLILINIS:
--   1. ITITIRA (PRESERVE):
--      - Lahat ng trips na 'completed' (kasama ang bookings at payments sa loob nito para buo ang sales computation).
--      - Lahat ng bookings na may bayad (amount_paid > 0).
--      - Lahat ng user accounts (profiles, auth.users), company information, at settings.
--   2. BUBURAHIN (DELETE):
--      - Lahat ng Cancelled bookings (orders kung saan status = 'Cancelled').
--      - Lahat ng Overdue / Cancelled / hindi completed na mga trips.
--      - Lahat ng mga test bookings na walang bayad at nakakabit sa mga lumang trips.
--
-- PAANO PATAKBUHIN:
--   1. Buksan ang Supabase Dashboard sa browser:
--      https://supabase.com/dashboard/project/duigaivxgxlnjmfienhg
--   2. Pindutin ang "SQL Editor" sa kaliwang menu.
--   3. Pindutin ang "New query", i-paste ang buong script na ito, at i-click ang "Run".
-- ==============================================================================

BEGIN;

-- Hakbang 1: Alamin ang mga Completed Trips na kailangang itira
CREATE TEMP TABLE temp_kept_trips ON COMMIT DROP AS
SELECT id, trip_number, status, departure_date
FROM public.trips 
WHERE status = 'completed';

-- Hakbang 2: Alamin ang mga Bookings na kailangang itira (May bayad at nasa completed trip, HINDI Cancelled)
CREATE TEMP TABLE temp_kept_orders ON COMMIT DROP AS
SELECT id, tracking_number, status, amount_paid, trip_id
FROM public.orders 
WHERE status <> 'Cancelled'
  AND (
    trip_id IN (SELECT id FROM temp_kept_trips)
    OR COALESCE(amount_paid, 0) > 0
  );

-- Hakbang 3: Burahin ang lahat ng Cancelled at Unused Bookings
-- Dahil naka-ON DELETE CASCADE ang mga child tables (order_status_events, 
-- payment_transactions, cancellation_settlements, customer_feedback),
-- kusa ring mabubura ang mga kaugnay na logs nito.
DELETE FROM public.orders
WHERE id NOT IN (SELECT id FROM temp_kept_orders);

-- Hakbang 4: Burahin ang mga Trips na HINDI Completed (Overdue, Scheduled, Cancelled, Arrived)
DELETE FROM public.trips
WHERE id NOT IN (SELECT id FROM temp_kept_trips);

-- Hakbang 5: Linisin ang mga notifications na patungkol sa mga binurang orders/trips
DELETE FROM public.notifications
WHERE reference_id IS NOT NULL
  AND reference_id NOT IN (SELECT id FROM temp_kept_orders)
  AND reference_id NOT IN (SELECT id FROM temp_kept_trips);

-- Hakbang 6: Buod ng Natirang Data (Para makita ang resulta)
SELECT 
  (SELECT count(*) FROM public.trips WHERE status = 'completed') AS natirang_completed_trips,
  (SELECT count(*) FROM public.orders) AS natirang_active_orders,
  (SELECT COALESCE(SUM(amount_paid), 0) FROM public.orders) AS kabuuang_sales_preserved_php,
  (SELECT count(*) FROM public.payment_transactions) AS natirang_payment_transactions,
  (SELECT count(*) FROM public.orders WHERE status = 'Cancelled') AS natirang_cancelled_orders_dapat_zero;

COMMIT;
