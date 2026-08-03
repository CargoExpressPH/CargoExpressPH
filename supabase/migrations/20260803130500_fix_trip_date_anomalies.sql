-- ============================================================
-- 20260803130500_fix_trip_date_anomalies.sql
--
-- Reconcile the three trips that violate arrival_date > departure_date,
-- so 20260803131000_trips_date_constraint.sql can be applied.
--
-- Found 2026-08-04 by the diagnostic in 20260803131000's header. Each row is
-- addressed individually and by id; this migration is a one-time data repair,
-- not a general rule. Re-running it is harmless (each UPDATE is guarded).
--
-- Deliberately NOT done: relaxing the constraint to >=. Only one of the three
-- rows has delta = 0; the other two are genuinely negative, so a looser
-- constraint would not have fixed them. Keeping the strict > also keeps the
-- database in agreement with the client-side rule in CreateTripPage.jsx:45,
-- which rejects arrival_date <= departure_date.
-- ============================================================


-- ─── 1. TRIP-20260501-873 — year typo in departure_date ─────
-- Recorded departure: "200220-05-01 14:06:00+00"  (year 200220)
-- The trip_number encodes its creation date (2026-05-01) and arrival_date is
-- 2026-05-03, so the intended year is unambiguously 2026. Corrects the year
-- and leaves the month/day/time exactly as entered.
UPDATE public.trips
   SET departure_date = TIMESTAMPTZ '2026-05-01 14:06:00+00'
 WHERE id = '7c415947-c624-4248-b720-01b6c4183684'
   AND EXTRACT(YEAR FROM departure_date) > 9999;


-- ─── 2. TRIP-20260521-868 — cancelled, arrival = departure ──
-- The trip was cancelled, so it never arrived. The recorded arrival_date is
-- an artefact of the form defaulting it to the departure value. arrival_date
-- is nullable and only feeds `estimated_delivery` in track_order_public(),
-- which correctly returns nothing when it is NULL.
UPDATE public.trips
   SET arrival_date = NULL
 WHERE id = '28041df7-834a-4752-bcb9-e207f56be966'
   AND status = 'cancelled'
   AND arrival_date IS NOT NULL;


-- ─── 3. TRIP-20260501-578 — completed, arrival 1 day early ──
-- departure 2026-05-07 09:59, arrival 2026-05-06 09:59 — same time of day,
-- one day earlier. An off-by-one on the date picker.
--
-- This is a COMPLETED trip, i.e. real historical data, and the true arrival
-- date is not recoverable from the database: the recorded value is provably
-- wrong, and inventing a replacement would be fabricating a business record.
-- The honest repair is to clear it. The trip is complete, so nothing depends
-- on the estimate any more.
--
-- IF YOU KNOW THE ACTUAL ARRIVAL DATE, use this instead and delete the
-- statement below it:
--
--   UPDATE public.trips
--      SET arrival_date = TIMESTAMPTZ '2026-05-08 09:59:00+00'  -- <- real date
--    WHERE id = 'd3e7c537-b80c-447f-8cbc-02984b980d07';
--
UPDATE public.trips
   SET arrival_date = NULL
 WHERE id = 'd3e7c537-b80c-447f-8cbc-02984b980d07'
   AND arrival_date IS NOT NULL
   AND arrival_date <= departure_date;


-- ============================================================
-- VERIFY — must return zero rows before applying 20260803131000:
--
--   SELECT id, trip_number, status, departure_date, arrival_date
--   FROM trips
--   WHERE arrival_date IS NOT NULL AND arrival_date <= departure_date;
--
-- Sanity-check the repaired rows:
--
--   SELECT trip_number, status, departure_date, arrival_date FROM trips
--   WHERE id IN ('7c415947-c624-4248-b720-01b6c4183684',
--                '28041df7-834a-4752-bcb9-e207f56be966',
--                'd3e7c537-b80c-447f-8cbc-02984b980d07');
-- ============================================================


-- ─── Footnote: how the year 200220 got in ───────────────────
-- CreateTripPage uses <input type="datetime-local">, whose year field accepts
-- 6 digits in most browsers. The form validates that departure is in the
-- future and that arrival > departure, but nothing bounds the year, and the
-- database had no constraint at all. The arrival > departure constraint in
-- 20260803131000 would NOT have caught this row either (2026-05-03 is still
-- less than year 200220, so it fails, but a far-future arrival paired with a
-- far-future departure would pass).
--
-- If this recurs, consider bounding the column — not applied here, as it is
-- beyond the reviewed scope and needs a business decision on the window:
--
--   ALTER TABLE public.trips ADD CONSTRAINT trips_departure_date_sane
--     CHECK (departure_date > TIMESTAMPTZ '2020-01-01'
--        AND departure_date < NOW() + INTERVAL '10 years');
--
-- Note that form is not IMMUTABLE (NOW()), so Postgres will reject it in a
-- CHECK; it would need a fixed upper bound or a trigger instead.
-- ============================================================
