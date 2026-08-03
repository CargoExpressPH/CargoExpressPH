-- ============================================================
-- 20260803131000_trips_date_constraint.sql
--
-- A trip cannot arrive before it departs.
--
-- Split out of 20260803130000 because applying it there failed:
--   ERROR 23514: check constraint "trips_arrival_after_departure"
--   of relation "trips" is violated by some row
--
-- The Supabase SQL editor runs a script in a transaction, so that failure
-- rolled back the entire migration — indexes included.
--
-- ─────────────────────────────────────────────────────────────
-- DO NOT APPLY THIS UNTIL THE VIOLATING ROWS ARE RECONCILED.
--
-- A NOT VALID constraint skips existing rows only at ADD time. Every
-- subsequent UPDATE to a row re-checks it. So adding this while bad rows
-- exist would make those trips permanently uneditable — and because
-- updateTrip() cascades trip status to its orders
-- (in_progress → In Transit, arrived → Arrived at Hub), an admin would be
-- unable to start, complete or cancel the affected trip, and its orders
-- would be stuck with it. That is a worse outcome than the unconstrained
-- column. Fix the data first.
-- ─────────────────────────────────────────────────────────────
--
-- STEP 1 — inspect (read-only):
--
--   SELECT id, trip_number, status, departure_date, arrival_date,
--          arrival_date - departure_date AS delta
--   FROM trips
--   WHERE arrival_date IS NOT NULL
--     AND arrival_date <= departure_date
--   ORDER BY departure_date DESC;
--
-- STEP 2 — choose a remedy per row. Which one is right depends entirely on
-- what the data turns out to be, so nothing below is applied automatically:
--
--   (a) delta = 0 (arrival exactly equals departure) — likely same-day trips
--       where only a date, not a time, was entered. Either relax the
--       constraint to >= (see the ALTERNATIVE at the bottom of this file), or
--       set a real arrival time.
--
--   (b) delta < 0 by a plausible amount — a genuine data-entry error
--       (dates swapped, or wrong day picked). Correct the value:
--         UPDATE trips SET arrival_date = <correct> WHERE id = '<id>';
--       Swapped pairs can be fixed wholesale, but ONLY after eyeballing them:
--         UPDATE trips SET departure_date = arrival_date,
--                          arrival_date   = departure_date
--          WHERE id IN ('<id>', ...);
--
--   (c) the arrival date is meaningless for that trip (e.g. an old cancelled
--       or test trip) — null it out; the column is nullable and
--       track_order_public() simply returns no estimated_delivery:
--         UPDATE trips SET arrival_date = NULL WHERE id IN ('<id>', ...);
--
-- STEP 3 — confirm the inspect query from STEP 1 returns zero rows, then run
-- the ALTER statements below.
-- ============================================================


ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_arrival_after_departure;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_arrival_after_departure
  CHECK (arrival_date IS NULL OR arrival_date > departure_date) NOT VALID;

ALTER TABLE public.trips
  VALIDATE CONSTRAINT trips_arrival_after_departure;


-- ============================================================
-- ALTERNATIVE — if the violations are all delta = 0 and same-day trips are
-- legitimate for this business, replace the two statements above with the
-- non-strict form. This matches the column's real meaning ("arrival is not
-- before departure") rather than bending the data to fit the rule.
--
-- Note this would be LOOSER than the client-side rule in
-- CreateTripPage.jsx:45, which rejects arrival_date <= departure_date. Keep
-- the two in sync — relax the JSX check to < as well, or new trips will be
-- rejected by the UI for a shape the database accepts.
--
--   ALTER TABLE public.trips
--     ADD CONSTRAINT trips_arrival_after_departure
--     CHECK (arrival_date IS NULL OR arrival_date >= departure_date) NOT VALID;
--   ALTER TABLE public.trips
--     VALIDATE CONSTRAINT trips_arrival_after_departure;
-- ============================================================
