CREATE OR REPLACE FUNCTION public.guard_trip_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count     INT;
  v_unsettled TEXT;
  v_eligible_count INT;
  v_eligible_weight NUMERIC;
  v_pending_cancellation_count INT;
  v_not_picked_up_count INT;
BEGIN
  -- Start Trip: stamp the real departure instant server-side. This is the
  -- ONLY writer of departure_at -- whatever the client sent in NEW is
  -- discarded and replaced with the server's own clock, exactly once, on
  -- the transition INTO 'in_progress'.
  IF NEW.status = 'in_progress' AND OLD.status IS DISTINCT FROM 'in_progress' THEN
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

      IF v_count > 5 THEN
        v_unsettled := v_unsettled || ', and ' || (v_count - 5) || ' more';
      END IF;

      RAISE EXCEPTION 'Cannot mark trip completed: % order(s) have unsettled balances (%).', v_count, v_unsettled;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_trips_load(trip_ids uuid[])
 RETURNS TABLE(trip_id uuid, current_weight numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    o.trip_id,
    COALESCE(SUM(o.actual_weight), 0) AS current_weight
  FROM public.orders o
  WHERE o.trip_id = ANY(trip_ids)
    AND o.status NOT IN ('Cancelled', 'Pending Cancellation', 'Pending', 'Assigned')
  GROUP BY o.trip_id;
$function$;
