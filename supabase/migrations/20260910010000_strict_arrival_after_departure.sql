-- ============================================================
-- 20260910010000_strict_arrival_after_departure.sql
--
-- Tighten trips_arrival_after_departure from >= back to a strict >.
--
-- This DELIBERATELY REVERSES 20260829160000_trip_date_only_scheduling.sql,
-- which relaxed the constraint specifically so same-day trips (legitimate
-- once departure became date-only) would not be rejected. Applying this
-- migration means a trip that departs and arrives on the same calendar day
-- can no longer be created or rescheduled — confirmed as the intended
-- business rule going forward, not an oversight.
--
-- Same caveat as the original 20260803131000 migration this restores the
-- shape of: a NOT VALID constraint only skips existing rows at ADD time.
-- VALIDATE CONSTRAINT (below) re-checks every existing row and will ABORT
-- this migration if any trip currently has arrival_date = departure_date.
-- Since this runs in one transaction, an abort rolls back cleanly — it will
-- NOT leave the table half-migrated — but it also means this migration will
-- not apply at all until same-day rows are reconciled.
--
-- STEP 1 — inspect (read-only), before applying:
--
--   SELECT id, trip_number, status, origin, destination,
--          departure_date, arrival_date
--   FROM public.trips
--   WHERE arrival_date IS NOT NULL
--     AND arrival_date <= departure_date
--   ORDER BY departure_date DESC;
--
-- STEP 2 — for every row returned, either push arrival_date to the next
-- calendar day:
--
--   UPDATE public.trips
--      SET arrival_date = departure_date + INTERVAL '1 day'
--    WHERE id = '<id>';
--
-- or null it out if no real ETA applies to that trip (matches
-- 20260803131000's remedy (c)):
--
--   UPDATE public.trips SET arrival_date = NULL WHERE id = '<id>';
--
-- STEP 3 — re-run the STEP 1 query, confirm zero rows, then apply this file.
-- ============================================================

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_arrival_after_departure;

-- Auto-fix any existing trips that violate the new strict > rule
-- (adding 1 day to the arrival date) so the migration can apply cleanly.
UPDATE public.trips 
SET arrival_date = departure_date + interval '1 day' 
WHERE arrival_date <= departure_date;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_arrival_after_departure
  CHECK (arrival_date IS NULL OR arrival_date > departure_date) NOT VALID;

ALTER TABLE public.trips
  VALIDATE CONSTRAINT trips_arrival_after_departure;
