-- ============================================================================
-- Date-only trip scheduling + calendar-day booking cutoff.
--
-- THE BUG
--
-- guard_customer_order_insert compared a trip's departure_date to now() as an
-- exact instant. Admins picked a departure TIME along with the date
-- (datetime-local input), so a trip scheduled for "Aug 29, 8:00 AM" silently
-- stopped accepting new bookings at 8:00 AM on the 29th even though it was
-- still sitting at the warehouse, still 'scheduled', and would not actually
-- leave until the admin clicked Start Trip. A customer could see the trip
-- listed (BookShipmentPage's own client-side filter had the same instant-
-- based bug), fill out the entire booking form, and only find out it was
-- rejected at the very last step -- the database error this migration fixes.
--
-- THE FIX
--
-- Trips are now scheduled by DATE, not time (UI change: the datetime-local
-- inputs in CreateTripPage/RescheduleTripModal become <input type="date">).
-- A trip stops accepting NEW bookings if and only if:
--   (a) its status is no longer 'scheduled' (Start Trip already fired, or an
--       admin cancelled/completed/arrived it), OR
--   (b) the current PH calendar day is strictly after its scheduled
--       departure_date's PH calendar day.
-- Same-day bookings stay open all day regardless of what time it currently
-- is -- exactly what "date-only scheduling" means.
--
-- The actual moment a trip leaves is now tracked separately: departure_at,
-- stamped by a trigger (never trusted from the client) the instant Start
-- Trip flips status to 'in_progress'.
--
-- departure_date keeps its column TYPE (TIMESTAMPTZ) rather than becoming a
-- bare DATE: that would ripple into idx_trips_departure_date, the
-- trips_unique_route_departure_day index, every ORDER BY, and every existing
-- row's stored value, for no functional gain -- ph_calendar_day() already
-- strips the time-of-day before comparing, so nothing about correctness
-- depends on departure_date literally being midnight. New/rescheduled trips
-- will store PH midnight going forward simply because the input no longer
-- collects a time; existing rows are left exactly as they are.
-- ============================================================================

-- 1. Actual departure instant, separate from the admin-scheduled date.
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS departure_at TIMESTAMPTZ;

COMMENT ON COLUMN public.trips.departure_date IS
  'Admin-scheduled departure DATE (Manila calendar day). Date-only as of this migration -- the UI collects no time-of-day. See guard_customer_order_insert() for the booking-cutoff rule, and departure_at for when the trip actually left.';
COMMENT ON COLUMN public.trips.departure_at IS
  'Actual departure instant, stamped by guard_trip_status_transition() the moment status moves to in_progress (Start Trip). NULL until then. Never accepted from the client -- the trigger is the only writer.';

-- 2. Same-day arrival is now valid: a trip scheduled Aug 29 that also arrives
--    Aug 29 is normal once departure is date-only. The old strict "greater
--    than" check was written back when both columns carried real times and
--    would otherwise make every same-day route impossible to schedule.
ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_arrival_after_departure;
ALTER TABLE public.trips ADD CONSTRAINT trips_arrival_after_departure
  CHECK (arrival_date IS NULL OR arrival_date >= departure_date);

-- 3. Rewrite the completion guard to ALSO stamp departure_at on Start Trip.
--    Renamed from guard_trip_completion since it now guards more than one
--    status transition. Still BEFORE UPDATE OF status, so an update that
--    only touches other columns (a claim, a capacity edit) never fires it.
DROP TRIGGER IF EXISTS trips_guard_completion ON public.trips;
DROP FUNCTION IF EXISTS public.guard_trip_completion();

CREATE OR REPLACE FUNCTION public.guard_trip_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count     INT;
  v_unsettled TEXT;
BEGIN
  -- Start Trip: stamp the real departure instant server-side. This is the
  -- ONLY writer of departure_at -- whatever the client sent in NEW is
  -- discarded and replaced with the server's own clock, exactly once, on
  -- the transition INTO 'in_progress'.
  IF NEW.status = 'in_progress' AND OLD.status IS DISTINCT FROM 'in_progress' THEN
    NEW.departure_at := now();
  END IF;

  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    SELECT COUNT(*)
      INTO v_count
      FROM public.orders
     WHERE trip_id = NEW.id
       AND status <> 'Cancelled'
       AND COALESCE(remaining_balance, 0) > 0;

    IF v_count > 0 THEN
      SELECT STRING_AGG(tracking_number, ', ')
        INTO v_unsettled
        FROM (
          SELECT tracking_number
            FROM public.orders
           WHERE trip_id = NEW.id
             AND status <> 'Cancelled'
             AND COALESCE(remaining_balance, 0) > 0
           ORDER BY tracking_number
           LIMIT 5
        ) t;

      -- '%%' in a RAISE format string is an escaped literal '%', not another
      -- placeholder — the truncation marker is appended to the string
      -- itself rather than passed as a 4th argument to a 3-placeholder
      -- RAISE (see guard_trip_completion's original note, 20260621140000).
      IF v_count > 5 THEN
        v_unsettled := v_unsettled || ' …';
      END IF;

      RAISE EXCEPTION
        'Cannot complete trip % — % order(s) still have an unpaid balance: %',
        NEW.trip_number,
        v_count,
        v_unsettled;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_trip_status_transition() IS
  'Fires BEFORE UPDATE OF status on trips. Stamps departure_at = now() on the transition into in_progress (Start Trip), and blocks completing a trip that still has unsettled orders. Formerly guard_trip_completion, renamed since it now guards more than one transition.';

CREATE TRIGGER trips_guard_status_transition
  BEFORE UPDATE OF status ON public.trips
  FOR EACH ROW EXECUTE FUNCTION guard_trip_status_transition();

-- 4. The actual booking-cutoff enforcement for CUSTOMERS. This deliberately
--    rewrites guard_customer_order_insert (BEFORE INSERT ON orders), not
--    guard_order_update: that one runs on EVERY order UPDATE regardless of
--    trip, and gating it on trip status/date would block ordinary admin
--    order management -- recording a payment, changing status, saving
--    feedback -- on any order whose trip has since departed, which is most
--    orders that were ever booked. Admins still bypass this check entirely
--    (auth.uid() IS NULL OR is_admin()), matching existing behaviour:
--    AdminCreateBookingPage can book onto any trip regardless of date.
CREATE OR REPLACE FUNCTION public.guard_customer_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip_status TEXT;
  v_departure_date TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  NEW.featured_on_website := false;
  NEW.featured_title := NULL;
  NEW.featured_caption := NULL;
  NEW.featured_image_type := NULL;
  NEW.featured_at := NULL;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT t.status, t.departure_date
      INTO v_trip_status, v_departure_date
      FROM public.trips AS t
     WHERE t.id = NEW.trip_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    -- Date-only cutoff: blocks once the PH calendar day has moved past the
    -- scheduled departure date, OR the moment status leaves 'scheduled'
    -- (Start Trip, or an admin cancelling/completing/arriving it) --
    -- whichever comes first. A same-day booking stays open all day no
    -- matter what time it currently is. ph_calendar_day() is the same
    -- PH-timezone helper the duplicate-route unique index already uses.
    IF v_trip_status <> 'scheduled'
       OR public.ph_calendar_day(now()) > public.ph_calendar_day(v_departure_date) THEN
      RAISE EXCEPTION 'This trip is no longer accepting bookings';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_customer_order_insert() IS
  'BEFORE INSERT ON orders, customers only (admins bypass). Blocks booking onto a trip whose status is no longer scheduled, or whose PH calendar departure day has passed -- same-day bookings stay open all day. Rewritten from an exact-instant now() comparison, which closed bookings mid-day even though the trip had not left yet.';
