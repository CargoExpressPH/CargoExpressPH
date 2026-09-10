-- Admins are already notified the moment a customer *requests* a cancellation
-- (private.request_order_cancellation -> status 'Pending Cancellation', see
-- 20260904235517_server_notification_event_coverage.sql). This repo's
-- cancellation flow does not let a customer set status = 'Cancelled'
-- directly -- only public.review_order_cancellation (admin-only, see
-- 20260831070000_secure_cancellation_and_chat_updates.sql) or the trip-level
-- cascade (private.cascade_trip_status_and_notify, when a whole trip is
-- cancelled) can finalize that transition.
--
-- This trigger closes the remaining gap: a database-level guarantee that
-- *every* order that actually reaches 'Cancelled' -- regardless of which
-- code path got it there, today or in the future -- notifies every admin.
-- It complements (does not duplicate) the existing "Cancellation Requested"
-- and per-customer "Order Cancelled" notifications, which target different
-- events/recipients.

CREATE OR REPLACE FUNCTION private.notify_admins_of_order_cancelled()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_reason TEXT := NULLIF(btrim(COALESCE(NEW.cancellation_details->>'reason', '')), '');
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'Booking Cancelled',
    format(
      'Order %s has been cancelled.%s',
      NEW.tracking_number,
      CASE WHEN v_reason IS NULL THEN '' ELSE ' Reason: ' || v_reason END
    ),
    'order_update',
    NEW.id
  FROM public.profiles AS p
  WHERE p.role = 'admin'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_admins_of_order_cancelled() FROM PUBLIC, anon, authenticated;

-- De-dupe defense-in-depth, matching the pattern used for the other
-- once-per-order admin fan-outs in 20260904235517.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_order_cancelled_admin_key
  ON public.notifications (user_id, reference_id)
  WHERE type = 'order_update' AND title = 'Booking Cancelled';

DROP TRIGGER IF EXISTS orders_notify_admins_of_cancellation ON public.orders;
CREATE TRIGGER orders_notify_admins_of_cancellation
AFTER UPDATE OF status ON public.orders
FOR EACH ROW
WHEN (NEW.status = 'Cancelled' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION private.notify_admins_of_order_cancelled();
