-- ==============================================================================
-- CARGOEXPRESS PH - PREVIEW SCRIPT (DRY RUN / WALANG MABUBURA)
-- ==============================================================================
-- Patakbuhin ito sa Supabase Dashboard > SQL Editor kung gusto mo munang
-- makita kung ano-anong rows ang MATITIRA at MABUBURA bago ito gawin.
-- ==============================================================================

-- 1. Mga Trips na MABUBURA (Hindi Completed / Overdue)
SELECT 'TRIPS TO DELETE' AS category, id, trip_number, status, departure_date
FROM public.trips 
WHERE status <> 'completed'
ORDER BY departure_date DESC;

-- 2. Mga Bookings na MABUBURA (Cancelled o walang bayad sa mga lumang trip)
SELECT 'ORDERS TO DELETE' AS category, id, tracking_number, status, amount_paid, trip_id
FROM public.orders 
WHERE status = 'Cancelled'
   OR (
     trip_id NOT IN (SELECT id FROM public.trips WHERE status = 'completed')
     AND COALESCE(amount_paid, 0) = 0
   );

-- 3. Mga MATITIRA (Completed Trips at may Sales/Payments)
SELECT 'ORDERS TO KEEP (SALES)' AS category, id, tracking_number, status, amount_paid, trip_id
FROM public.orders 
WHERE status <> 'Cancelled'
  AND (
    trip_id IN (SELECT id FROM public.trips WHERE status = 'completed')
    OR COALESCE(amount_paid, 0) > 0
  );
