-- Notification-system objects layered on top of
-- payment-ledger-pgtest/harness-schema.sql (orders/payment_attempts/
-- payment_transactions/profiles + the payment RPCs). Every function body
-- below is copied VERBATIM from the live production database (fetched via
-- pg_get_functiondef against the linked Supabase project on 2026-09-09), not
-- reimplemented, so this harness exercises the exact SQL that ships. Only the
-- table shapes are hand-built (same approach as harness-schema.sql) to avoid
-- pulling in unrelated modules (chat, trips, announcements, cron/vault/net)
-- that the real migration files touch but this task does not.

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(30) DEFAULT 'general' CHECK (type IN (
    'order_update', 'trip_update', 'announcement', 'general', 'inquiry',
    'feedback', 'chat_message', 'system_alert', 'payment_update'
  )),
  reference_id UUID,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  device_id TEXT
);

-- Stub: only referenced by complete_notification_delivery_job's 'inquiry'
-- special case below, which every payment_update job in this suite skips
-- (n.type <> 'inquiry'). Present only so that function's body matches
-- production verbatim.
CREATE TABLE contact_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  push_dispatched_at TIMESTAMPTZ,
  push_dispatch_started_at TIMESTAMPTZ,
  push_dispatch_claim_id UUID
);

CREATE TABLE notification_delivery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL
    REFERENCES notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL
    REFERENCES profiles(id) ON DELETE CASCADE,
  device_token_id UUID
    REFERENCES user_device_tokens(id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'sent', 'skipped', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  claim_id UUID,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Verbatim copy of the live outbox trigger (post-20260908010000: no
-- notification_delivery_attempts audit insert — that table was dropped in
-- production and this is the function body as it stands today). ──
CREATE OR REPLACE FUNCTION private.enqueue_notification_delivery_jobs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  INSERT INTO public.notification_delivery_jobs (
    notification_id,
    user_id,
    device_token_id,
    dedupe_key
  )
  SELECT
    NEW.id,
    NEW.user_id,
    d.id,
    NEW.id::TEXT || ':' || d.id::TEXT
  FROM public.user_device_tokens AS d
  WHERE d.user_id = NEW.user_id
  ON CONFLICT (dedupe_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    INSERT INTO public.notification_delivery_jobs (
      notification_id,
      user_id,
      device_token_id,
      dedupe_key,
      status,
      completed_at,
      last_error
    ) VALUES (
      NEW.id,
      NEW.user_id,
      NULL,
      NEW.id::TEXT || ':none',
      'skipped',
      now(),
      'No device tokens for user'
    ) ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.enqueue_notification_delivery_jobs() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS notifications_enqueue_delivery_jobs ON public.notifications;
CREATE TRIGGER notifications_enqueue_delivery_jobs
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION private.enqueue_notification_delivery_jobs();

-- ── Verbatim copies of the live claim/complete RPCs. ──
CREATE OR REPLACE FUNCTION public.claim_notification_delivery_job(
  p_notification_id UUID,
  p_device_token_id UUID
)
RETURNS TABLE (
  job_id UUID,
  job_claim_id UUID,
  job_attempt_count INTEGER
)
LANGUAGE SQL
SET search_path TO ''
AS $function$
  WITH candidate AS (
    SELECT j.id
    FROM public.notification_delivery_jobs AS j
    WHERE j.notification_id = p_notification_id
      AND j.device_token_id = p_device_token_id
      AND (
        (j.status IN ('pending', 'retry') AND j.available_at <= now())
        OR (j.status = 'processing' AND j.claimed_at < now() - INTERVAL '5 minutes')
      )
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE public.notification_delivery_jobs AS j
       SET status = 'processing',
           attempt_count = j.attempt_count + 1,
           claimed_at = now(),
           claim_id = gen_random_uuid(),
           updated_at = now(),
           last_error = NULL
      FROM candidate AS c
     WHERE j.id = c.id
    RETURNING j.id, j.claim_id, j.attempt_count
  )
  SELECT c.id, c.claim_id, c.attempt_count FROM claimed AS c;
$function$;

CREATE OR REPLACE FUNCTION public.claim_notification_delivery_jobs(
  p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
  job_id UUID,
  notification_id UUID,
  user_id UUID,
  device_token_id UUID,
  job_claim_id UUID,
  job_attempt_count INTEGER
)
LANGUAGE SQL
SET search_path TO ''
AS $function$
  WITH candidate AS (
    SELECT j.id
    FROM public.notification_delivery_jobs AS j
    WHERE (
        (j.status IN ('pending', 'retry') AND j.available_at <= now())
        OR (j.status = 'processing' AND j.claimed_at < now() - INTERVAL '5 minutes')
      )
      AND j.device_token_id IS NOT NULL
    ORDER BY j.available_at, j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  ), claimed AS (
    UPDATE public.notification_delivery_jobs AS j
       SET status = 'processing',
           attempt_count = j.attempt_count + 1,
           claimed_at = now(),
           claim_id = gen_random_uuid(),
           updated_at = now(),
           last_error = NULL
      FROM candidate AS c
     WHERE j.id = c.id
    RETURNING
      j.id,
      j.notification_id,
      j.user_id,
      j.device_token_id,
      j.claim_id,
      j.attempt_count
  )
  SELECT
    c.id,
    c.notification_id,
    c.user_id,
    c.device_token_id,
    c.claim_id,
    c.attempt_count
  FROM claimed AS c;
$function$;

CREATE OR REPLACE FUNCTION public.complete_notification_delivery_job(
  p_job_id UUID,
  p_claim_id UUID,
  p_outcome TEXT,
  p_error TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_job public.notification_delivery_jobs%ROWTYPE;
  v_status TEXT;
BEGIN
  IF p_outcome NOT IN ('sent', 'skipped', 'retry', 'dead') THEN
    RAISE EXCEPTION 'Invalid delivery outcome';
  END IF;

  SELECT * INTO v_job
  FROM public.notification_delivery_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_job.status <> 'processing' OR v_job.claim_id IS DISTINCT FROM p_claim_id THEN
    RETURN NULL;
  END IF;

  v_status := CASE
    WHEN p_outcome IN ('sent', 'skipped', 'dead') THEN p_outcome
    WHEN v_job.attempt_count >= 5 THEN 'dead'
    ELSE 'retry'
  END;

  UPDATE public.notification_delivery_jobs
     SET status = v_status,
         available_at = CASE
           WHEN v_status = 'retry' THEN now() + make_interval(
             secs => LEAST(900, (15 * power(2, GREATEST(v_job.attempt_count - 1, 0)))::INTEGER)
           )
           ELSE available_at
         END,
         completed_at = CASE WHEN v_status IN ('sent', 'skipped', 'dead') THEN now() ELSE NULL END,
         claimed_at = NULL,
         claim_id = NULL,
         last_error = NULLIF(left(COALESCE(p_error, ''), 1000), ''),
         updated_at = now()
   WHERE id = p_job_id;

  IF v_status = 'sent' THEN
    UPDATE public.contact_inquiries AS i
       SET push_dispatched_at = COALESCE(i.push_dispatched_at, now()),
           push_dispatch_started_at = NULL,
           push_dispatch_claim_id = NULL
      FROM public.notifications AS n
     WHERE n.id = v_job.notification_id
       AND n.type = 'inquiry'
       AND n.reference_id = i.id;
  END IF;

  RETURN v_status;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_notification_delivery_job(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_notification_delivery_jobs(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_notification_delivery_job(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_delivery_job(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_notification_delivery_jobs(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_notification_delivery_job(UUID, UUID, TEXT, TEXT) TO service_role;

-- ── Minimal RLS, matching the live "Users view/insert/update/delete
-- authorized notifications" policies, so the authorization tests below are
-- real Postgres RLS decisions, not application-level assumptions. ──
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view authorized notifications" ON notifications
  FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "Users update own notifications" ON notifications
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Matches Supabase's own convention: RLS is what actually gates row access;
-- the authenticated role still needs the table-level grant to reach it at
-- all (the run.mjs test harness switches to this real Postgres role via
-- SET ROLE — not just the app.role stand-in GUC — specifically so the RLS
-- authorization test exercises Postgres's own RLS engine, not an assumption
-- about it).
GRANT SELECT, UPDATE ON TABLE notifications TO authenticated;
