-- Durable, per-device push delivery outbox.
--
-- Existing notification producers keep inserting public.notifications. This
-- migration adds a server-only delivery job for every device in the SAME
-- transaction, so closing a browser cannot lose the push side effect.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE public.notification_delivery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL
    REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_token_id UUID
    REFERENCES public.user_device_tokens(id) ON DELETE SET NULL,
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

COMMENT ON TABLE public.notification_delivery_jobs IS
  'Server-only per-device push outbox. A notification insert and its delivery jobs commit atomically.';
COMMENT ON COLUMN public.notification_delivery_jobs.dedupe_key IS
  'Stable notification:device key. It remains stable if an expired device row is later deleted.';

CREATE INDEX notification_delivery_jobs_ready_idx
  ON public.notification_delivery_jobs (available_at, created_at)
  WHERE status IN ('pending', 'retry');
CREATE INDEX notification_delivery_jobs_processing_idx
  ON public.notification_delivery_jobs (claimed_at)
  WHERE status = 'processing';
CREATE INDEX notification_delivery_jobs_notification_idx
  ON public.notification_delivery_jobs (notification_id);
CREATE INDEX notification_delivery_jobs_user_idx
  ON public.notification_delivery_jobs (user_id);
CREATE INDEX notification_delivery_jobs_device_idx
  ON public.notification_delivery_jobs (device_token_id)
  WHERE device_token_id IS NOT NULL;

ALTER TABLE public.notification_delivery_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_delivery_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_delivery_jobs TO service_role;

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

  -- A terminal placeholder makes "not delivered because the account has no
  -- registered device" observable without keeping a pointless retry alive.
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

    INSERT INTO public.notification_delivery_attempts (
      notification_id,
      user_id,
      device_token_id,
      status,
      error_message
    ) VALUES (
      NEW.id,
      NEW.user_id,
      NULL,
      'skipped',
      'No device tokens for user'
    );
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

-- Atomically claim one exact device job. send-push uses this for calls from
-- old cached clients while the durable worker uses the batched claim below.
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
SECURITY INVOKER
SET search_path = ''
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
SECURITY INVOKER
SET search_path = ''
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
SECURITY INVOKER
SET search_path = ''
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

  -- Contact inquiries use "at least one admin device accepted" semantics.
  -- Mark the inquiry complete when the first correlated delivery succeeds.
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

-- Existing Vault values are already used by the payment-reminder and photo
-- workers. Reuse them rather than putting a service key in source control.
CREATE OR REPLACE FUNCTION private.trigger_push_delivery_worker()
RETURNS VOID
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
    RAISE WARNING 'Push delivery worker skipped because project_url/service_role_key are not configured in Vault.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/process-push-deliveries',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object('limit', 25)
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.trigger_push_delivery_worker() FROM PUBLIC, anon, authenticated;

SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process_push_deliveries')
  THEN cron.unschedule('process_push_deliveries') END;
SELECT cron.schedule(
  'process_push_deliveries',
  '* * * * *',
  $cron$SELECT private.trigger_push_delivery_worker()$cron$
);

CREATE OR REPLACE FUNCTION private.purge_old_notification_delivery_jobs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.notification_delivery_jobs
  WHERE status IN ('sent', 'skipped', 'dead')
    AND completed_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION private.purge_old_notification_delivery_jobs() FROM PUBLIC, anon, authenticated;

SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_old_notification_delivery_jobs')
  THEN cron.unschedule('purge_old_notification_delivery_jobs') END;
SELECT cron.schedule(
  'purge_old_notification_delivery_jobs',
  '20 3 * * *',
  $cron$SELECT private.purge_old_notification_delivery_jobs()$cron$
);

-- Recover recent contact-inquiry notifications that were created before this
-- outbox existed but never achieved a provider-accepted delivery. Do not
-- backfill arbitrary historical notifications: that would surprise users with
-- old shipment alerts.
INSERT INTO public.notification_delivery_jobs (
  notification_id,
  user_id,
  device_token_id,
  dedupe_key
)
SELECT
  n.id,
  n.user_id,
  d.id,
  n.id::TEXT || ':' || d.id::TEXT
FROM public.notifications AS n
JOIN public.contact_inquiries AS i
  ON i.id = n.reference_id
 AND i.push_dispatched_at IS NULL
JOIN public.user_device_tokens AS d
  ON d.user_id = n.user_id
WHERE n.type = 'inquiry'
  AND n.created_at >= now() - INTERVAL '30 days'
ON CONFLICT (dedupe_key) DO NOTHING;
