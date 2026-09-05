-- Complete server-owned notification coverage for order mutations. These
-- events used to be emitted by OrderDetailPage after the order write returned,
-- leaving a loss window if the browser closed or lost connectivity between the
-- two requests. The notification insert (and therefore its outbox jobs) now
-- commits or rolls back with the order change itself.
--
-- Ship the frontend first. Unlike 20260904235517, these events repeat over an
-- order's life ('Order Updated' once per status, 'Trip Reassigned' once per
-- move), so they cannot be de-duplicated with a unique index the way the
-- once-per-order events were — an admin tab still running the old bundle would
-- add its own copy on top of this trigger's. Deploying the build that removed
-- those createNotification() calls before applying this migration keeps the
-- overlap window empty.

CREATE OR REPLACE FUNCTION private.notify_customer_of_order_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_title TEXT;
  v_message TEXT;
  v_reason TEXT;
BEGIN
  -- A trip-status trigger updates its orders and emits the more useful
  -- trip-specific message itself. Suppress a second generic order message for
  -- those nested writes.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Walk-in orders are initially owned by the creating admin. Only registered
  -- customer profiles should receive customer lifecycle notifications.
  IF NEW.user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = NEW.user_id
      AND p.role = 'customer'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    v_title := 'Booking Added to Your Account';
    v_message := format(
      'Booking %s has been added to your account history.',
      NEW.tracking_number
    );

  ELSIF NEW.service_area_status IS DISTINCT FROM OLD.service_area_status
        AND NEW.service_area_status = 'approved' THEN
    v_title := 'Pickup Request Approved';
    v_message := format(
      'Your special pickup request for Order %s has been approved.',
      NEW.tracking_number
    );

  ELSIF NEW.service_area_status IS DISTINCT FROM OLD.service_area_status
        AND NEW.service_area_status = 'rejected' THEN
    v_title := 'Pickup Request Rejected';
    v_message := format(
      'Your special pickup request for Order %s could not be accommodated. Reason: %s',
      NEW.tracking_number,
      COALESCE(NULLIF(btrim(NEW.service_area_remarks), ''), 'Not specified')
    );

  ELSIF NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN
    IF NEW.trip_id IS NULL THEN
      v_title := 'Trip Assignment Removed';
      v_message := format(
        'Order %s is no longer assigned to its previous trip.',
        NEW.tracking_number
      );
    ELSIF OLD.trip_id IS NULL THEN
      v_title := 'Order Assigned';
      v_message := format('Order %s assigned to a trip', NEW.tracking_number);
    ELSE
      v_title := 'Trip Reassigned';
      v_message := format(
        'Order %s has been moved to a new trip',
        NEW.tracking_number
      );
    END IF;

  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    -- These transitions already create purpose-built notifications in their
    -- owning RPCs. Avoid duplicating those messages.
    IF NEW.status = 'Pending Cancellation'
       OR OLD.status = 'Pending Cancellation' THEN
      RETURN NEW;
    END IF;

    CASE NEW.status
      WHEN 'Picked Up' THEN
        v_title := 'Pickup Complete';
        v_message := format(
          'Order %s has been picked up',
          NEW.tracking_number
        );
      WHEN 'Delivered' THEN
        v_title := 'Delivery Complete';
        v_message := format(
          'Order %s has been delivered',
          NEW.tracking_number
        );
      WHEN 'Cancelled' THEN
        v_reason := NULLIF(btrim(NEW.cancellation_details->>'reason'), '');
        v_title := 'Order Cancelled';
        v_message := format(
          'Order %s has been cancelled.%s',
          NEW.tracking_number,
          CASE WHEN v_reason IS NULL THEN '' ELSE ' Reason: ' || v_reason END
        );
      ELSE
        v_title := 'Order Updated';
        v_message := format(
          'Order %s: %s',
          NEW.tracking_number,
          NEW.status
        );
    END CASE;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (
    user_id, title, message, type, reference_id
  ) VALUES (
    NEW.user_id, v_title, v_message, 'order_update', NEW.id
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_customer_of_order_change()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_notify_customer_of_change ON public.orders;
CREATE TRIGGER orders_notify_customer_of_change
AFTER UPDATE OF user_id, service_area_status, trip_id, status
ON public.orders
FOR EACH ROW
EXECUTE FUNCTION private.notify_customer_of_order_change();
