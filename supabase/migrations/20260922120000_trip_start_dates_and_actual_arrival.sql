BEGIN;

-- Keep the existing date-only schedule and the existing server-stamped
-- departure_at. arrival_date remains the planned schedule value consumed by
-- booking and shipment-delivery flows; these fields are separate trip facts.
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS estimated_arrival_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.trips.estimated_arrival_at IS
  'Optional forecast for arrival at the destination hub. Set only during Start Trip, must be later than the server-stamped departure_at, and is not evidence that the trip arrived.';
COMMENT ON COLUMN public.trips.arrived_at IS
  'Actual destination-hub arrival instant. Stamped from the database clock only when the trip status changes from in_progress to arrived (the existing Mark Arrived action). Never inferred from arrival_date or estimated_arrival_at.';

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_estimated_arrival_after_departure,
  ADD CONSTRAINT trips_estimated_arrival_after_departure
    CHECK (estimated_arrival_at IS NULL OR (departure_at IS NOT NULL AND estimated_arrival_at > departure_at)),
  DROP CONSTRAINT IF EXISTS trips_actual_arrival_after_departure,
  ADD CONSTRAINT trips_actual_arrival_after_departure
    CHECK (arrived_at IS NULL OR departure_at IS NULL OR arrived_at >= departure_at);

-- Backend-computed Manila calendar gate used by the admin UI. This is only a
-- display aid; the transition trigger below repeats the comparison at write
-- time using the trusted database clock.
CREATE OR REPLACE FUNCTION public.get_trip_start_date_gates(p_trip_ids UUID[] DEFAULT NULL)
RETURNS TABLE (trip_id UUID, scheduled_day DATE, ph_today DATE, gate_state TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_today DATE := (clock_timestamp() AT TIME ZONE 'Asia/Manila')::DATE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    (t.departure_date AT TIME ZONE 'Asia/Manila')::DATE,
    v_today,
    CASE
      WHEN t.status <> 'scheduled' THEN 'not_scheduled'
      WHEN t.departure_date IS NULL THEN 'missing_date'
      WHEN (t.departure_date AT TIME ZONE 'Asia/Manila')::DATE > v_today THEN 'before_date'
      WHEN (t.departure_date AT TIME ZONE 'Asia/Manila')::DATE < v_today THEN 'overdue'
      ELSE 'today'
    END
  FROM public.trips AS t
  WHERE p_trip_ids IS NULL OR t.id = ANY(p_trip_ids);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trip_start_date_gates(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trip_start_date_gates(UUID[]) TO authenticated;

-- Extend the existing guard rather than adding a second competing timestamp
-- writer. Existing pickup/cancellation/weight readiness and unsettled-balance
-- checks are retained verbatim below.
CREATE OR REPLACE FUNCTION public.guard_trip_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_count INT;
  v_unsettled TEXT;
  v_eligible_count INT;
  v_eligible_weight NUMERIC;
  v_pending_cancellation_count INT;
  v_not_picked_up_count INT;
  v_scheduled_day DATE;
  v_today DATE;
  v_departure_at TIMESTAMPTZ;
  v_starting BOOLEAN;
  v_arriving BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.departure_at IS NOT NULL
       OR NEW.estimated_arrival_at IS NOT NULL
       OR NEW.arrived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Trip timestamps are recorded by the server during trip status transitions.';
    END IF;
    RETURN NEW;
  END IF;

  v_starting := OLD.status = 'scheduled' AND NEW.status = 'in_progress';
  v_arriving := OLD.status = 'in_progress' AND NEW.status = 'arrived';

  IF NEW.status = 'in_progress' AND OLD.status IS DISTINCT FROM 'in_progress' AND NOT v_starting THEN
    RAISE EXCEPTION 'Only a scheduled trip can be started.';
  END IF;

  IF NOT v_starting AND NEW.departure_at IS DISTINCT FROM OLD.departure_at THEN
    RAISE EXCEPTION 'Actual departure is set only when a scheduled trip starts.';
  END IF;
  IF NOT v_starting AND NEW.estimated_arrival_at IS DISTINCT FROM OLD.estimated_arrival_at THEN
    RAISE EXCEPTION 'Estimated arrival can only be provided when the trip starts.';
  END IF;
  IF NOT v_arriving AND NEW.arrived_at IS DISTINCT FROM OLD.arrived_at THEN
    RAISE EXCEPTION 'Actual arrival is set only when the trip is confirmed at the destination hub.';
  END IF;

  IF v_starting THEN
    IF NEW.departure_date IS NULL THEN
      RAISE EXCEPTION 'A departure date is required before starting the trip.';
    END IF;

    v_scheduled_day := (NEW.departure_date AT TIME ZONE 'Asia/Manila')::DATE;
    v_today := (clock_timestamp() AT TIME ZONE 'Asia/Manila')::DATE;
    IF v_today < v_scheduled_day THEN
      RAISE EXCEPTION 'This trip is scheduled to depart on %. To depart earlier, reschedule it first.',
        to_char(v_scheduled_day, 'FMMonth FMDD, YYYY');
    ELSIF v_today > v_scheduled_day THEN
      RAISE EXCEPTION 'Overdue — Reschedule Required. Update the departure date before starting.';
    END IF;

    SELECT COUNT(*) INTO v_pending_cancellation_count
      FROM (SELECT 1 FROM public.orders WHERE trip_id = NEW.id AND status = 'Pending Cancellation' FOR SHARE) q;

    IF v_pending_cancellation_count > 0 THEN
      RAISE EXCEPTION 'Cannot start trip: % order(s) awaiting cancellation decision.', v_pending_cancellation_count;
    END IF;

    SELECT COUNT(*) INTO v_not_picked_up_count
      FROM (SELECT 1 FROM public.orders WHERE trip_id = NEW.id AND status IN ('Pending', 'Assigned') FOR SHARE) q;

    IF v_not_picked_up_count > 0 THEN
      RAISE EXCEPTION 'Cannot start trip: % order(s) not yet picked up.', v_not_picked_up_count;
    END IF;

    SELECT COUNT(*), COALESCE(SUM(actual_weight), 0)
      INTO v_eligible_count, v_eligible_weight
      FROM (
        SELECT actual_weight
          FROM public.orders
         WHERE trip_id = NEW.id
           AND status NOT IN ('Cancelled', 'Pending Cancellation', 'Pending', 'Assigned')
           FOR SHARE
      ) locked_orders;

    IF v_eligible_count = 0 THEN
      RAISE EXCEPTION 'Cannot start trip: no active shipments are ready for departure.';
    END IF;

    IF v_eligible_weight <= 0 THEN
      RAISE EXCEPTION 'Cannot start trip: record pickup and actual cargo weight first.';
    END IF;

    v_departure_at := clock_timestamp();
    IF NEW.estimated_arrival_at IS NOT NULL AND NEW.estimated_arrival_at <= v_departure_at THEN
      RAISE EXCEPTION 'Estimated arrival at the destination hub must be later than actual departure.';
    END IF;

    -- Never trust a timestamp supplied for actual departure by the caller.
    NEW.departure_at := v_departure_at;
  END IF;

  IF v_arriving THEN
    -- Do not invent a historical departure for legacy in-progress trips that
    -- have none. Mark Arrived still records the actual arrival at this moment.
    NEW.arrived_at := clock_timestamp();
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
  'Enforces the trusted Asia/Manila scheduled-date gate and existing shipment readiness on Start Trip; stamps actual departure server-side; stamps actual hub arrival only on in_progress -> arrived; preserves the unpaid-balance completion guard.';

DROP TRIGGER IF EXISTS trips_guard_status_transition ON public.trips;
CREATE TRIGGER trips_guard_status_transition
  BEFORE INSERT OR UPDATE OF status, departure_at, estimated_arrival_at, arrived_at
  ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_status_transition();

-- Prevent the generic table update path from acting as a reschedule endpoint.
-- All schedule changes must go through the existing locked reschedule RPC and
-- remain on a still-scheduled trip. Assigned orders are untouched.
CREATE OR REPLACE FUNCTION public.guard_trip_reschedule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_today DATE;
  v_new_day DATE;
BEGIN
  IF NEW.departure_date IS NOT DISTINCT FROM OLD.departure_date
     AND NEW.arrival_date IS NOT DISTINCT FROM OLD.arrival_date THEN
    RETURN NEW;
  END IF;

  IF current_setting('cargoexpress.trip_reschedule_authorized', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Use the authorized trip reschedule action so the reason and schedule history are recorded.';
  END IF;
  IF NEW.departure_date IS NULL THEN
    RAISE EXCEPTION 'A departure date is required when rescheduling a trip.';
  END IF;
  IF OLD.status <> 'scheduled' OR OLD.departure_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a trip that has not started can be rescheduled.';
  END IF;

  v_today := (clock_timestamp() AT TIME ZONE 'Asia/Manila')::DATE;
  v_new_day := (NEW.departure_date AT TIME ZONE 'Asia/Manila')::DATE;
  IF v_new_day < v_today THEN
    RAISE EXCEPTION 'A trip cannot be rescheduled to a past Manila date.';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_trip_reschedule() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trips_guard_reschedule ON public.trips;
CREATE TRIGGER trips_guard_reschedule
  BEFORE UPDATE OF departure_date, arrival_date ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_reschedule();

-- Activity log rows are written inside the same transaction as the schedule
-- update. Keep the existing five-argument RPC for cached clients; the current
-- UI uses the six-argument overload with a private audit reason.
CREATE OR REPLACE FUNCTION public.reschedule_trip(
  p_trip_id UUID,
  p_departure_date TIMESTAMPTZ,
  p_arrival_date TIMESTAMPTZ,
  p_notify_all_subscribers BOOLEAN DEFAULT false,
  p_public_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'A rescheduling reason is required. Refresh the app and try again.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.reschedule_trip(
  p_trip_id UUID,
  p_departure_date TIMESTAMPTZ,
  p_arrival_date TIMESTAMPTZ,
  p_notify_all_subscribers BOOLEAN,
  p_public_reason TEXT,
  p_change_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_before public.trips%ROWTYPE;
  v_after public.trips%ROWTYPE;
  v_changed BOOLEAN;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_change_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 5 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Enter a rescheduling reason between 5 and 500 characters.';
  END IF;

  SELECT * INTO v_before FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;

  PERFORM set_config('cargoexpress.trip_reschedule_notify_all',
    CASE WHEN p_notify_all_subscribers THEN 'true' ELSE 'false' END, true);
  PERFORM set_config('cargoexpress.trip_reschedule_authorized', 'true', true);

  UPDATE public.trips
  SET departure_date = p_departure_date,
      arrival_date = p_arrival_date
  WHERE id = p_trip_id
  RETURNING * INTO v_after;

  v_changed := (v_before.departure_date IS DISTINCT FROM v_after.departure_date)
            OR (v_before.arrival_date IS DISTINCT FROM v_after.arrival_date);

  IF v_changed THEN
    INSERT INTO public.activity_logs (
      module, action, record_type, record_id, record_ref,
      previous_value, new_value, details
    ) VALUES (
      'Trips', 'Trip Rescheduled', 'trip', v_after.id, v_after.trip_number,
      jsonb_build_object('departure_date', v_before.departure_date, 'arrival_date', v_before.arrival_date),
      jsonb_build_object('departure_date', v_after.departure_date, 'arrival_date', v_after.arrival_date),
      format(
        'Departure date: %s → %s; estimated shipment delivery date: %s → %s. Reason: %s',
        COALESCE(to_char(v_before.departure_date AT TIME ZONE 'Asia/Manila', 'Mon FMDD, YYYY'), 'Not set'),
        COALESCE(to_char(v_after.departure_date AT TIME ZONE 'Asia/Manila', 'Mon FMDD, YYYY'), 'Not set'),
        COALESCE(to_char(v_before.arrival_date AT TIME ZONE 'Asia/Manila', 'Mon FMDD, YYYY'), 'Not set'),
        COALESCE(to_char(v_after.arrival_date AT TIME ZONE 'Asia/Manila', 'Mon FMDD, YYYY'), 'Not set'),
        v_reason
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'trip', to_jsonb(v_after),
    'schedule_changed', v_changed,
    'old_departure_date', v_before.departure_date,
    'old_arrival_date', v_before.arrival_date,
    'public_reason', NULLIF(btrim(COALESCE(p_public_reason, '')), ''),
    'change_reason', v_reason
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reschedule_trip(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reschedule_trip(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_trip(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_trip(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT) TO authenticated;

-- Keep the public tracking RPC narrow: it returns existing shipment fields
-- plus only trip-level schedule/departure/arrival facts, never booking data.
DROP FUNCTION IF EXISTS public.track_order_public(TEXT);
CREATE FUNCTION public.track_order_public(p_tracking_number TEXT)
RETURNS TABLE (
  tracking_number VARCHAR,
  status VARCHAR,
  sender_name TEXT,
  receiver_name TEXT,
  origin VARCHAR,
  destination VARCHAR,
  package_description TEXT,
  actual_weight NUMERIC,
  shipping_cost NUMERIC,
  estimated_delivery TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  trip_departure_date TIMESTAMPTZ,
  trip_departure_at TIMESTAMPTZ,
  trip_estimated_arrival_at TIMESTAMPTZ,
  trip_arrived_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    o.tracking_number,
    o.status,
    public.mask_name(o.sender_name)   AS sender_name,
    public.mask_name(o.receiver_name) AS receiver_name,
    o.origin,
    o.destination,
    o.package_description,
    o.actual_weight,
    o.shipping_cost,
    t.arrival_date AS estimated_delivery,
    o.created_at,
    o.updated_at,
    t.departure_date AS trip_departure_date,
    t.departure_at AS trip_departure_at,
    t.estimated_arrival_at AS trip_estimated_arrival_at,
    t.arrived_at AS trip_arrived_at
  FROM public.orders AS o
  LEFT JOIN public.trips AS t ON t.id = o.trip_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.track_order_public(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_order_public(TEXT) TO anon, authenticated;

COMMIT;
