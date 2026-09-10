-- ============================================================
-- Email affected customers when a trip is rescheduled.
--
-- Fires the email-trip-reschedule Edge Function the instant a 'scheduled'
-- trip's departure_date or arrival_date changes (RescheduleTripModal is the
-- only caller of this path today). The function itself does the real
-- filtering — active bookings on that trip whose owner has
-- profiles.wants_announcements = true — this trigger only has to hand it
-- the trip id and the old/new dates.
--
-- Same Vault-secret pattern already used by trigger_daily_payment_reminders
-- (20260831060000) and trigger_push_delivery_worker (20260904235457): the
-- project URL and service role key live in Supabase Vault, never in this
-- file, and are read at call time by a SECURITY DEFINER function. No new
-- Vault setup is required if either of those migrations has already been
-- applied to this project — they share the same two secret names
-- ('project_url', 'service_role_key'). If neither has run yet:
--
--   select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
--   select vault.create_secret('<SERVICE_ROLE_KEY>',                'service_role_key');
--
-- This is a direct fire-and-forget pg_net call, not a durable outbox like
-- the push-notification delivery system (notification_delivery_jobs) —
-- appropriate here because a missed reschedule email is a courtesy notice,
-- not a delivery-critical alert, and the reschedule itself always succeeds
-- or fails independently of whether this email goes out. If guaranteed
-- delivery/retry is ever needed, route this through that same outbox
-- pattern instead of adding ad-hoc retry logic here.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION private.trigger_trip_reschedule_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_project_url TEXT;
  v_service_key TEXT;
BEGIN
  SELECT decrypted_secret INTO v_project_url
  FROM vault.decrypted_secrets
  WHERE name = 'project_url'
  LIMIT 1;

  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'trigger_trip_reschedule_email: project_url/service_role_key not found in Vault — skipping trip %.', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := rtrim(v_project_url, '/') || '/functions/v1/email-trip-reschedule',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object(
      'trip_id',             NEW.id,
      'old_departure_date',  OLD.departure_date,
      'old_arrival_date',    OLD.arrival_date,
      'new_departure_date',  NEW.departure_date,
      'new_arrival_date',    NEW.arrival_date
    )
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.trigger_trip_reschedule_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trips_notify_reschedule_email ON public.trips;
CREATE TRIGGER trips_notify_reschedule_email
AFTER UPDATE OF departure_date, arrival_date ON public.trips
FOR EACH ROW
WHEN (
  NEW.status = 'scheduled'
  AND (
    NEW.departure_date IS DISTINCT FROM OLD.departure_date
    OR NEW.arrival_date IS DISTINCT FROM OLD.arrival_date
  )
)
EXECUTE FUNCTION private.trigger_trip_reschedule_email();

-- ============================================================
-- VERIFY (after Vault setup and deploying the Edge Function):
--   -- Reschedule a trip through the app, then inspect the async pg_net
--   -- delivery a few seconds later:
--   SELECT * FROM net._http_response ORDER BY id DESC LIMIT 5;
-- ============================================================
