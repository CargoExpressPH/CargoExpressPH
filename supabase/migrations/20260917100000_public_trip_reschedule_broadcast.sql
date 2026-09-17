-- ============================================================
-- Public trip-reschedule email option (POST_DEPLOYMENT_TARGETED_FIX_REPORT.md
-- item 2/N-2). Agreed rule: when an admin reschedules a trip and checks
-- "Email this schedule update to all subscribers", every enabled
-- email_subscriptions address should be eligible — including inquiry-only
-- subscribers with no account and registered customers with no booking on
-- this trip. The narrow, automatic, per-trip courtesy email added by
-- 20260910020000_trip_reschedule_email_trigger.sql (booked + opted-in
-- customers on THIS trip only) stays exactly as it is and keeps firing by
-- default — it is a genuinely distinct, more personal "your booking's trip
-- changed" notice, not something this migration removes.
--
-- Reuse, not a parallel system: the public option reuses the existing
-- durable announcement-email pipeline (announcements + send_email +
-- email_subscriptions + announcement_email_broadcasts/recipients +
-- broadcast-announcement Edge Function) exactly the way createTrip() already
-- does for a newly published trip (src/lib/database.js, "Trip-schedule email
-- blast. Reuses createAnnouncement exactly as the admin's own Announcements
-- page does"). No second subscription table, no second worker.
--
-- Coordinating the two paths so a booked, opted-in customer never gets two
-- equivalent reschedule emails: reschedule_trip() below is the only way the
-- client performs a reschedule that offers the public option. It sets a
-- transaction-local flag before updating trips; the courtesy-email trigger
-- checks that flag and skips its own send whenever the admin chose the
-- public option for this specific reschedule — the admin picks one channel
-- per reschedule (quiet private notice, or the wider public one), never
-- both. This is the "coordinate/replace the overlapping path" instruction,
-- not a removal of the private notice as a feature.
--
-- Stable per-event identity: reschedule_trip() locks the trip row, compares
-- old vs. new dates, and only reports schedule_changed = true when a genuine
-- change is persisted. The client (src/lib/database.js) only creates a new
-- announcements row when schedule_changed is true, so a same-event
-- double-submit (already locked out by the row lock + IS DISTINCT FROM
-- comparison) never creates a second broadcast, while a later, genuinely
-- different reschedule always does — each is its own announcements.id, its
-- own announcement_email_broadcasts job, with the existing F-03 lease/
-- idempotency machinery unchanged underneath it.
-- ============================================================

BEGIN;

-- Optional call-to-action rendered as a real button in the announcement
-- email (buildAnnouncementEmailHtml in broadcast-announcement/index.ts).
-- Nullable and additive: existing/regular admin-authored announcements keep
-- rendering the old fixed "Visit CargoExpress PH" CTA when these are NULL.
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS cta_label TEXT,
  ADD COLUMN IF NOT EXISTS cta_url TEXT;

ALTER TABLE public.announcement_email_broadcasts
  ADD COLUMN IF NOT EXISTS cta_label TEXT,
  ADD COLUMN IF NOT EXISTS cta_url TEXT;

COMMENT ON COLUMN public.announcements.cta_label IS
  'Optional email/CTA button label (e.g. "Book This Trip"). NULL keeps the default CTA.';
COMMENT ON COLUMN public.announcements.cta_url IS
  'Optional email/CTA button target. Must be an absolute https:// URL when set (see CHECK).';
ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_cta_url_scheme_chk
  CHECK (cta_url IS NULL OR cta_url ~ '^https://');

-- Snapshot the CTA onto the broadcast job at claim time, same as subject/
-- content/from_email already are, so a later edit to the source announcement
-- can never change an in-flight or already-partially-sent broadcast.
CREATE OR REPLACE FUNCTION public.claim_announcement_email_broadcast(
  p_announcement_id UUID,
  p_from_email TEXT,
  p_worker_token UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_announcement public.announcements%ROWTYPE;
  v_job public.announcement_email_broadcasts%ROWTYPE;
  v_created BOOLEAN := false;
BEGIN
  IF p_worker_token IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'Invalid broadcast lease';
  END IF;
  IF btrim(COALESCE(p_from_email, '')) = '' OR char_length(p_from_email) > 320 THEN
    RAISE EXCEPTION 'Invalid sender address';
  END IF;

  SELECT * INTO v_announcement
  FROM public.announcements
  WHERE id = p_announcement_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Announcement not found'; END IF;
  IF v_announcement.send_email IS NOT TRUE THEN
    RAISE EXCEPTION 'Announcement is not marked for email';
  END IF;

  SELECT * INTO v_job
  FROM public.announcement_email_broadcasts
  WHERE announcement_id = p_announcement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.announcement_email_broadcasts
      (announcement_id, subject, content, from_email, status, cta_label, cta_url)
    VALUES
      (p_announcement_id, v_announcement.title, v_announcement.content, p_from_email, 'pending',
       v_announcement.cta_label, v_announcement.cta_url)
    RETURNING * INTO v_job;
    v_created := true;

    INSERT INTO public.announcement_email_recipients (announcement_id, email)
    SELECT p_announcement_id, email
    FROM public.email_subscriptions
    WHERE subscribed IS TRUE
    ON CONFLICT (announcement_id, email) DO NOTHING;

    UPDATE public.announcement_email_broadcasts
    SET total_recipients = (
      SELECT count(*) FROM public.announcement_email_recipients
      WHERE announcement_id = p_announcement_id
    )
    WHERE announcement_id = p_announcement_id
    RETURNING * INTO v_job;
  END IF;

  IF v_announcement.emailed_at IS NOT NULL OR v_job.status = 'completed' THEN
    RETURN jsonb_build_object('state', 'completed', 'already_completed', true);
  END IF;

  IF v_job.claim_expires_at > now() AND v_job.claim_token IS DISTINCT FROM p_worker_token THEN
    RETURN jsonb_build_object('state', 'busy', 'retry_after', v_job.claim_expires_at);
  END IF;

  -- An expired send is uncertain. Reuse the same provider idempotency key only
  -- while Resend still retains it; older uncertain sends require review.
  UPDATE public.announcement_email_recipients
  SET status = CASE
        WHEN first_attempt_at <= now() - interval '23 hours' THEN 'needs_review'
        ELSE 'retryable'
      END,
      claim_token = NULL,
      claim_expires_at = NULL,
      next_attempt_at = now(),
      last_error = COALESCE(last_error, 'Recovered an expired sending claim'),
      updated_at = now()
  WHERE announcement_id = p_announcement_id
    AND status = 'sending'
    AND claim_expires_at <= now();

  UPDATE public.announcement_email_recipients
  SET status = 'needs_review',
      last_error = COALESCE(last_error, 'Provider idempotency retention window elapsed'),
      updated_at = now()
  WHERE announcement_id = p_announcement_id
    AND status = 'retryable'
    AND first_attempt_at <= now() - interval '23 hours';

  UPDATE public.announcement_email_broadcasts
  SET status = 'processing',
      claim_token = p_worker_token,
      claim_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  WHERE announcement_id = p_announcement_id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'state', 'claimed',
    'created', v_created,
    'subject', v_job.subject,
    'content', v_job.content,
    'from_email', v_job.from_email,
    'cta_label', v_job.cta_label,
    'cta_url', v_job.cta_url,
    'total', v_job.total_recipients
  );
END;
$function$;

-- ============================================================
-- reschedule_trip: the only write path RescheduleTripModal now uses. Admin-
-- gated (mirrors every other admin-only RPC in this project), locks the
-- trip row, applies the date change, and reports whether it was genuine.
-- p_notify_all_subscribers is read by the courtesy-email trigger below via a
-- transaction-local GUC so the two notification paths never both fire for
-- the same reschedule.
-- ============================================================
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
DECLARE
  v_before public.trips%ROWTYPE;
  v_after public.trips%ROWTYPE;
  v_changed BOOLEAN;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT * INTO v_before FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;

  -- Read by private.trigger_trip_reschedule_email() for the AFTER UPDATE
  -- fired by the statement below, in the same transaction/session.
  PERFORM set_config('cargoexpress.trip_reschedule_notify_all',
    CASE WHEN p_notify_all_subscribers THEN 'true' ELSE 'false' END, true);

  UPDATE public.trips
  SET departure_date = p_departure_date,
      arrival_date = p_arrival_date
  WHERE id = p_trip_id
  RETURNING * INTO v_after;

  v_changed := (v_before.departure_date IS DISTINCT FROM v_after.departure_date)
            OR (v_before.arrival_date IS DISTINCT FROM v_after.arrival_date);

  RETURN jsonb_build_object(
    'trip', to_jsonb(v_after),
    'schedule_changed', v_changed,
    'old_departure_date', v_before.departure_date,
    'old_arrival_date', v_before.arrival_date,
    'public_reason', NULLIF(btrim(COALESCE(p_public_reason, '')), '')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reschedule_trip(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_trip(UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT) TO authenticated;

-- ============================================================
-- Courtesy per-trip email trigger: unchanged targeting/content, only gains
-- the "the admin chose the public option instead" bail-out so a booked,
-- opted-in customer is never emailed twice for the same reschedule.
-- ============================================================
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
  IF current_setting('cargoexpress.trip_reschedule_notify_all', true) = 'true' THEN
    -- The admin chose "Email this schedule update to all subscribers" for
    -- this reschedule; that broader, public broadcast (created client-side
    -- via createAnnouncement, see src/lib/database.js) covers this trip's
    -- booked+opted-in customers too, via email_subscriptions. Sending the
    -- narrow per-trip courtesy email as well would duplicate it.
    RETURN NEW;
  END IF;

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

COMMIT;

-- ============================================================
-- VERIFY (after deploying, in staging):
--   -- Reschedule a trip WITHOUT the public option: confirm only the
--   -- per-trip courtesy email fires (net._http_response as before).
--   -- Reschedule a trip WITH the public option checked: confirm an
--   -- announcements row with send_email=true was created, its
--   -- announcement_email_broadcasts job includes cta_label/cta_url, and
--   -- that no net._http_response row for email-trip-reschedule appears for
--   -- that specific update.
-- ============================================================
