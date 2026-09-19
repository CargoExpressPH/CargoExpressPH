BEGIN;

-- Trip creation is a customer-facing business event, independent of whether
-- the admin also chooses to email subscribers. Keeping this fan-out in the
-- database makes it atomic with the trip insert and lets the existing
-- notifications -> delivery-jobs trigger handle push delivery.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_new_trip_recipient_key
  ON public.notifications (user_id, reference_id)
  WHERE type = 'trip_update' AND title = 'New Trip Available';

CREATE OR REPLACE FUNCTION private.notify_new_trip_customers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'New Trip Available',
    format(
      '%s → %s is scheduled for %s. Tap to view the trip and book cargo space.',
      NEW.origin,
      NEW.destination,
      to_char(NEW.departure_date AT TIME ZONE 'Asia/Manila', 'FMMonth FMDD, YYYY')
    ),
    'trip_update',
    NEW.id
  FROM public.profiles AS p
  WHERE p.role = 'customer'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_new_trip_customers()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trips_notify_customers_on_create ON public.trips;
CREATE TRIGGER trips_notify_customers_on_create
AFTER INSERT ON public.trips
FOR EACH ROW EXECUTE FUNCTION private.notify_new_trip_customers();

-- The announcements table also backs the durable subscriber-email worker.
-- Email-only records stay visible to admins for delivery status/retry, but
-- are excluded from the public feed and from announcement notification fan-out.
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'public';

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_audience_check;
ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_audience_check
  CHECK (audience IN ('public', 'email_only'));

CREATE OR REPLACE FUNCTION private.notify_announcement_customers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.is_active AND NEW.audience = 'public' THEN
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    SELECT p.id, 'New Announcement', NEW.title, 'announcement', NEW.id
    FROM public.profiles AS p
    WHERE p.role = 'customer'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_announcement_customers()
  FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.announcements.audience IS
  'public: shown to customers and notified; email_only: durable subscriber-email record visible only in admin queries.';

COMMIT;
