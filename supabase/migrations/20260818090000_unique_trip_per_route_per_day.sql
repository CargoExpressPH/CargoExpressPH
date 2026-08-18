-- One departure per route per Philippine calendar day.
--
-- Two admins creating "Manila → Bohol, Aug 24" produced two trips on the same
-- sailing, and neither the booking flow nor capacity accounting can tell which
-- one is real: bookings auto-assign to whichever row matched first, so the
-- cargo splits across two manifests for one vessel. The client check in
-- database.js (findDuplicateTrip) loses that race by construction — this index
-- is the enforcement.
--
-- The day is the *Philippine* day, not the UTC one. departure_date is
-- TIMESTAMPTZ, so a 6:00 AM Manila departure is stored as 22:00 UTC the day
-- before; indexing DATE(departure_date) would file it under the 23rd and let a
-- second early-morning trip through. Postgres cannot index that expression
-- directly either — `AT TIME ZONE <name>` is STABLE, not IMMUTABLE, because
-- the zone database can change under it. PHT is UTC+8 year round with no DST,
-- so the fixed-offset form below genuinely is immutable and is safe to declare
-- as such.

CREATE OR REPLACE FUNCTION public.ph_calendar_day(ts TIMESTAMPTZ)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT ((ts + INTERVAL '8 hours') AT TIME ZONE 'UTC')::date;
$$;

COMMENT ON FUNCTION public.ph_calendar_day(TIMESTAMPTZ) IS
  'Philippine (UTC+8, no DST) calendar day of an instant. IMMUTABLE so it can be indexed; do not generalise it to a named zone.';

-- Fail loudly with the offending rows rather than with a bare "could not create
-- unique index" if the data already violates this.
DO $$
DECLARE
  conflicts TEXT;
BEGIN
  SELECT string_agg(format('%s → %s on %s (%s trips)', origin, destination, day, n), E'\n  ')
    INTO conflicts
  FROM (
    SELECT origin, destination, public.ph_calendar_day(departure_date) AS day, count(*) AS n
    FROM public.trips
    WHERE status <> 'cancelled'
    GROUP BY 1, 2, 3
    HAVING count(*) > 1
  ) dupes;

  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION E'Existing duplicate trips block this constraint:\n  %\nCancel or re-date the extra trips, then re-run this migration.', conflicts;
  END IF;
END
$$;

-- Cancelled trips are excluded on purpose: a cancelled sailing is a historical
-- record, not a slot, and the whole point of cancelling is to free the day for
-- a replacement. Completed and in-progress trips are still covered — a route
-- that already ran today cannot be booked twice for today.
CREATE UNIQUE INDEX IF NOT EXISTS trips_unique_route_departure_day
  ON public.trips (origin, destination, public.ph_calendar_day(departure_date))
  WHERE status <> 'cancelled';

COMMENT ON INDEX public.trips_unique_route_departure_day IS
  'One non-cancelled trip per origin/destination per PH calendar day. Client mirror: findDuplicateTrip in src/lib/database.js.';
