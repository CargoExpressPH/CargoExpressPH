-- Server-owned notification coverage for business events that must not depend
-- on a browser staying open. Every insert below automatically enters the
-- durable per-device outbox created by the preceding migration.

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'order_update', 'trip_update', 'announcement', 'general', 'inquiry',
    'feedback', 'chat_message', 'system_alert', 'payment_update'
  ));

-- One announcement and one booking event should create one notification per
-- recipient even when an old cached client also runs its former fan-out code.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_announcement_recipient_key
  ON public.notifications (user_id, reference_id)
  WHERE type = 'announcement';
CREATE UNIQUE INDEX IF NOT EXISTS notifications_new_booking_admin_key
  ON public.notifications (user_id, reference_id)
  WHERE type = 'order_update' AND title = 'New Booking';
CREATE UNIQUE INDEX IF NOT EXISTS notifications_booking_received_key
  ON public.notifications (user_id, reference_id)
  WHERE type = 'general' AND title = 'Booking Received';
CREATE UNIQUE INDEX IF NOT EXISTS notifications_feedback_recipient_key
  ON public.notifications (user_id, reference_id)
  WHERE type = 'feedback' AND title = 'New Customer Feedback';

CREATE OR REPLACE FUNCTION private.notify_new_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'Booking Received',
    format('Your booking %s was received. We will keep you updated as it moves.', NEW.tracking_number),
    'general',
    NEW.id
  FROM public.profiles AS p
  WHERE p.id = NEW.user_id
    AND p.role = 'customer'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'New Booking',
    format(
      'New order %s from %s',
      NEW.tracking_number,
      COALESCE(NULLIF(btrim(NEW.sender_name), ''), 'Customer')
    ),
    'order_update',
    NEW.id
  FROM public.profiles AS p
  WHERE p.role = 'admin'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_new_order() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_notify_new_booking ON public.orders;
CREATE TRIGGER orders_notify_new_booking
AFTER INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION private.notify_new_order();

CREATE OR REPLACE FUNCTION private.notify_announcement_customers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    SELECT p.id, 'New Announcement', NEW.title, 'announcement', NEW.id
    FROM public.profiles AS p
    WHERE p.role = 'customer'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_announcement_customers() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS announcements_notify_customers ON public.announcements;
CREATE TRIGGER announcements_notify_customers
AFTER INSERT ON public.announcements
FOR EACH ROW EXECUTE FUNCTION private.notify_announcement_customers();

CREATE OR REPLACE FUNCTION private.notify_admins_of_feedback()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'New Customer Feedback',
    format(
      '%s-star rating%s',
      NEW.rating,
      CASE
        WHEN NULLIF(btrim(COALESCE(NEW.message, '')), '') IS NULL THEN ''
        ELSE ': ' || left(btrim(NEW.message), 60)
      END
    ),
    'feedback',
    NEW.order_id
  FROM public.profiles AS p
  WHERE p.role = 'admin'
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_admins_of_feedback() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS customer_feedback_notify_admins ON public.customer_feedback;
CREATE TRIGGER customer_feedback_notify_admins
AFTER INSERT ON public.customer_feedback
FOR EACH ROW EXECUTE FUNCTION private.notify_admins_of_feedback();

-- Notify only human-owned chat turns: bot-active customer traffic stays out of
-- the admin queue, while an admin reply always tells the owning customer.
CREATE OR REPLACE FUNCTION private.notify_human_chat_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_customer_id UUID;
  v_status TEXT;
BEGIN
  SELECT c.customer_id, c.status
    INTO v_customer_id, v_status
  FROM public.conversations AS c
  WHERE c.id = NEW.conversation_id;

  IF NEW.sender_role = 'admin' AND v_customer_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    VALUES (
      v_customer_id,
      'New Support Reply',
      'CargoExpress support replied to your conversation.',
      'chat_message',
      NEW.conversation_id
    );
  ELSIF NEW.sender_role = 'customer' AND v_status = 'waiting' THEN
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    SELECT
      p.id,
      'Customer Waiting for Support',
      'A customer sent a message that needs a human response.',
      'chat_message',
      NEW.conversation_id
    FROM public.profiles AS p
    WHERE p.role = 'admin';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_human_chat_message() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_chat_messages_notify_humans ON public.chat_messages;
CREATE TRIGGER zz_chat_messages_notify_humans
AFTER INSERT ON public.chat_messages
FOR EACH ROW EXECUTE FUNCTION private.notify_human_chat_message();

CREATE OR REPLACE FUNCTION private.notify_payment_recorded()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF NEW.payment_status NOT IN ('paid', 'partial') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = NEW.order_id;

  IF NOT FOUND OR v_order.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  VALUES (
    v_order.user_id,
    CASE WHEN COALESCE(v_order.remaining_balance, 0) <= 0
      THEN 'Payment Completed' ELSE 'Payment Recorded' END,
    format(
      'A payment was recorded for order %s. Open the app for the updated balance.',
      v_order.tracking_number
    ),
    'payment_update',
    v_order.id
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_payment_recorded() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_payment_transactions_notify_customer ON public.payment_transactions;
CREATE TRIGGER zz_payment_transactions_notify_customer
AFTER INSERT ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION private.notify_payment_recorded();

CREATE OR REPLACE FUNCTION private.notify_payment_failed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF NEW.status <> 'failed' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  VALUES (
    v_order.user_id,
    'Payment Not Completed',
    format('The payment for order %s was not completed. You may safely try again.', v_order.tracking_number),
    'payment_update',
    v_order.id
  );
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_payment_failed() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS payment_attempts_notify_failure ON public.payment_attempts;
CREATE TRIGGER payment_attempts_notify_failure
AFTER UPDATE OF status ON public.payment_attempts
FOR EACH ROW EXECUTE FUNCTION private.notify_payment_failed();

-- Restore the cancellation-request notification removed by a later JSONB
-- refactor. Ownership, validation, status change, activity log, notification,
-- and delivery-job creation all remain in one transaction.
CREATE OR REPLACE FUNCTION public.request_order_cancellation(
  p_order_id UUID,
  p_reason TEXT
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF char_length(v_reason) < 5 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Cancellation reason must be between 5 and 500 characters.';
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
    AND user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only your own bookings can be cancelled';
  END IF;
  IF v_order.status = 'Pending Cancellation' THEN
    RAISE EXCEPTION 'A cancellation request for this booking is already awaiting review.';
  END IF;
  IF v_order.status = 'Cancelled' THEN
    RAISE EXCEPTION 'This booking is already cancelled.';
  END IF;
  IF v_order.status IN ('Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered') THEN
    RAISE EXCEPTION 'This shipment is already in the delivery network. Please contact support instead.';
  END IF;

  UPDATE public.orders
     SET status = 'Pending Cancellation',
         cancellation_details = jsonb_build_object(
           'reason', v_reason,
           'requested_at', now(),
           'previous_status', v_order.status
         )
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'Cancellation Requested',
    format('Order %s: the customer asked to cancel. Reason: %s', v_order.tracking_number, v_reason),
    'order_update',
    v_order.id
  FROM public.profiles AS p
  WHERE p.role = 'admin';

  INSERT INTO public.activity_logs (
    module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  ) VALUES (
    'Orders',
    'Cancellation Requested',
    'order',
    v_order.id,
    v_order.tracking_number,
    jsonb_build_object('status', v_order.cancellation_details->>'previous_status'),
    jsonb_build_object('status', 'Pending Cancellation'),
    'Customer requested to cancel the booking. Reason: ' || v_reason
  );

  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_order_cancellation(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_order_cancellation(UUID, TEXT) TO authenticated, service_role;

-- Enforce the same trip transition rules shown by the UI. This trigger is
-- compatible with old cached clients that still UPDATE trips directly.
CREATE OR REPLACE FUNCTION private.validate_trip_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT public.is_admin() AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  IF NOT (
    (OLD.status = 'scheduled' AND NEW.status IN ('in_progress', 'cancelled'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('arrived', 'cancelled'))
    OR (OLD.status = 'arrived' AND NEW.status IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'Invalid trip status transition from % to %', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'in_progress' THEN
    SELECT count(*) INTO v_count
    FROM public.orders
    WHERE trip_id = NEW.id
      AND status NOT IN ('Picked Up', 'Cancelled');
    IF v_count > 0 THEN
      RAISE EXCEPTION 'All assigned orders must be picked up before the trip can start.';
    END IF;
  ELSIF NEW.status = 'completed' THEN
    SELECT count(*) INTO v_count
    FROM public.orders
    WHERE trip_id = NEW.id
      AND status NOT IN ('Delivered', 'Cancelled');
    IF v_count > 0 THEN
      RAISE EXCEPTION 'All assigned orders must be delivered or cancelled before completing the trip.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.validate_trip_status_transition() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trips_validate_status_transition ON public.trips;
CREATE TRIGGER trips_validate_status_transition
BEFORE UPDATE OF status ON public.trips
FOR EACH ROW EXECUTE FUNCTION private.validate_trip_status_transition();

CREATE OR REPLACE FUNCTION private.cascade_trip_status_and_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order RECORD;
  v_target_status TEXT;
  v_title TEXT;
  v_message TEXT;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  v_target_status := CASE NEW.status
    WHEN 'in_progress' THEN 'In Transit'
    WHEN 'arrived' THEN 'Arrived at Hub'
    WHEN 'cancelled' THEN 'Cancelled'
    ELSE NULL
  END;
  v_title := CASE NEW.status
    WHEN 'in_progress' THEN 'Trip Started'
    WHEN 'arrived' THEN 'Trip Arrived'
    WHEN 'completed' THEN 'Trip Completed'
    WHEN 'cancelled' THEN 'Trip Cancelled'
  END;

  FOR v_order IN
    SELECT o.id, o.user_id, o.tracking_number, o.status
    FROM public.orders AS o
    WHERE o.trip_id = NEW.id
      AND o.user_id IS NOT NULL
      AND o.status <> 'Cancelled'
      AND (
        (NEW.status = 'in_progress' AND o.status = 'Picked Up')
        OR (NEW.status = 'arrived' AND o.status = 'In Transit')
        OR (NEW.status = 'cancelled' AND o.status IN (
          'Pending', 'Assigned', 'Picked Up', 'Pending Cancellation',
          'In Transit', 'Arrived at Hub', 'Out for Delivery'
        ))
        OR (NEW.status = 'completed' AND o.status = 'Delivered')
      )
    FOR UPDATE
  LOOP
    IF v_target_status IS NOT NULL AND v_order.status IS DISTINCT FROM v_target_status THEN
      UPDATE public.orders SET status = v_target_status WHERE id = v_order.id;
    END IF;

    v_message := CASE NEW.status
      WHEN 'in_progress' THEN format('Order %s is now in transit.', v_order.tracking_number)
      WHEN 'arrived' THEN format('Order %s has arrived at the destination hub.', v_order.tracking_number)
      WHEN 'completed' THEN format('The trip carrying order %s has been completed.', v_order.tracking_number)
      WHEN 'cancelled' THEN format('The trip assigned to order %s was cancelled.', v_order.tracking_number)
    END;

    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    VALUES (v_order.user_id, v_title, v_message, 'trip_update', v_order.id);

    IF v_target_status IS NOT NULL AND v_order.status IS DISTINCT FROM v_target_status THEN
      INSERT INTO public.activity_logs (
        module, action, record_type, record_id, record_ref,
        previous_value, new_value, details
      ) VALUES (
        'Orders',
        'Status Changed to ' || v_target_status,
        'order',
        v_order.id,
        v_order.tracking_number,
        jsonb_build_object('status', v_order.status),
        jsonb_build_object('status', v_target_status),
        'Triggered atomically by trip ' || NEW.trip_number || ' status change'
      );
    END IF;
  END LOOP;

  INSERT INTO public.activity_logs (
    module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  ) VALUES (
    'Trips',
    v_title,
    'trip',
    NEW.id,
    NEW.trip_number,
    jsonb_build_object('status', OLD.status),
    jsonb_build_object('status', NEW.status),
    'Trip status updated atomically to ' || NEW.status
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.cascade_trip_status_and_notify() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trips_cascade_status_and_notify ON public.trips;
CREATE TRIGGER trips_cascade_status_and_notify
AFTER UPDATE OF status ON public.trips
FOR EACH ROW EXECUTE FUNCTION private.cascade_trip_status_and_notify();

CREATE OR REPLACE FUNCTION private.notify_trip_rescheduled()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status = 'scheduled'
     AND (
       NEW.departure_date IS DISTINCT FROM OLD.departure_date
       OR NEW.arrival_date IS DISTINCT FROM OLD.arrival_date
     ) THEN
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    SELECT
      o.user_id,
      'Trip Rescheduled',
      format(
        'The trip for order %s is now scheduled to depart on %s.',
        o.tracking_number,
        to_char(NEW.departure_date AT TIME ZONE 'Asia/Manila', 'Mon DD, YYYY')
      ),
      'trip_update',
      o.id
    FROM public.orders AS o
    WHERE o.trip_id = NEW.id
      AND o.user_id IS NOT NULL
      AND o.status <> 'Cancelled';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_trip_rescheduled() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trips_notify_reschedule ON public.trips;
CREATE TRIGGER trips_notify_reschedule
AFTER UPDATE OF departure_date, arrival_date ON public.trips
FOR EACH ROW EXECUTE FUNCTION private.notify_trip_rescheduled();
