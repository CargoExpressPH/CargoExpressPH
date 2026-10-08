BEGIN;

-- A completed trip no longer holds its route's slot for the day. Scheduled,
-- in-progress and arrived trips still do. Cancelled trips were already excluded.
DROP INDEX IF EXISTS public.trips_unique_route_departure_day;

CREATE UNIQUE INDEX trips_unique_route_departure_day
  ON public.trips (origin, destination, public.ph_calendar_day(departure_date))
  WHERE status NOT IN ('cancelled', 'completed');

COMMENT ON INDEX public.trips_unique_route_departure_day IS
  'One open (not cancelled or completed) trip per origin/destination per PH calendar day. Client mirror: findDuplicateTrip in src/lib/database.js.';

COMMIT;
