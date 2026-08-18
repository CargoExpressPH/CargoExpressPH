-- An order past 'Pending' must be on a trip.
--
-- 'Assigned' is a claim about a specific trip; assigned-to-nothing is a
-- contradiction the rest of the system then believes. The customer is told the
-- booking is scheduled, no trip's capacity counts the weight, and the pickup
-- screen offers to load cargo onto a vessel that was never chosen. The client
-- mirror (REQUIRES_TRIP in src/constants/status.js) has always covered part of
-- this; a direct PATCH did not go through it, so this is the enforcement.
--
-- The four statuses exempted are exactly the ones that legitimately have no
-- trip yet:
--   Pending Review        — awaiting a coverage decision, never routed
--   Pending               — booked, not yet assigned
--   Pending Cancellation  — a hold, reachable from Pending (which has no trip)
--   Cancelled             — terminal; a cancelled booking keeps no slot
--
-- NOTE on trips.trip_id ON DELETE SET NULL: deleting a trip that still carries
-- Assigned-or-later orders now RAISES instead of silently nulling their
-- trip_id. That silent nulling is the same defect from the other end — it left
-- in-transit cargo attached to nothing — so failing is the correct outcome.
-- deleteTrip() in src/lib/database.js translates the error into a sentence
-- naming the orders that must be moved first.

DO $$
DECLARE
  offenders TEXT;
BEGIN
  SELECT string_agg(format('%s (%s)', tracking_number, status), ', ' ORDER BY tracking_number)
    INTO offenders
  FROM public.orders
  WHERE trip_id IS NULL
    AND status NOT IN ('Pending Review', 'Pending', 'Pending Cancellation', 'Cancelled');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      E'These orders have no trip but a status that requires one:\n  %\nAssign them a trip (or cancel them), then re-run this migration.',
      offenders;
  END IF;
END
$$;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_trip_required_for_active_status
  CHECK (
    status IN ('Pending Review', 'Pending', 'Pending Cancellation', 'Cancelled')
    OR trip_id IS NOT NULL
  );

COMMENT ON CONSTRAINT orders_trip_required_for_active_status ON public.orders IS
  'An order at Assigned or beyond must reference a trip. Client mirror: REQUIRES_TRIP in src/constants/status.js.';
