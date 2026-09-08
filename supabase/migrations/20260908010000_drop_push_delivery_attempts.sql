-- Remove the notification_delivery_attempts audit-log table. Push delivery
-- history now lives in Edge Function console logs (send-push and
-- process-push-deliveries), viewed via the Supabase Functions dashboard.
-- notification_delivery_jobs (the retry queue) is unaffected and keeps
-- working exactly as before.
BEGIN;

-- Stop enqueueing an audit row when a notification has no device tokens.
-- notification_delivery_jobs already records this outcome (status
-- 'skipped', with last_error set), so no observability is lost.
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
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.enqueue_notification_delivery_jobs() FROM PUBLIC, anon, authenticated;

-- Drop the failed-attempts signal from the health monitor. The job-queue
-- counters (dead/stuck/overdue) and the worker cron-failure count already
-- cover delivery health without the attempts table.
CREATE OR REPLACE FUNCTION private.monitor_push_delivery_health()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_dead INTEGER;
  v_stuck INTEGER;
  v_overdue INTEGER;
  v_cron_failures INTEGER;
  v_message TEXT;
BEGIN
  SELECT
    count(*) FILTER (
      WHERE status = 'dead' AND updated_at >= now() - INTERVAL '24 hours'
    ),
    count(*) FILTER (
      WHERE status = 'processing' AND claimed_at < now() - INTERVAL '5 minutes'
    ),
    count(*) FILTER (
      WHERE status IN ('pending', 'retry')
        AND available_at < now() - INTERVAL '10 minutes'
    )
  INTO v_dead, v_stuck, v_overdue
  FROM public.notification_delivery_jobs;

  SELECT count(*)
    INTO v_cron_failures
  FROM cron.job_run_details AS run
  JOIN cron.job AS job ON job.jobid = run.jobid
  WHERE job.jobname = 'process_push_deliveries'
    AND run.status = 'failed'
    AND run.start_time >= now() - INTERVAL '15 minutes';

  IF v_dead = 0
     AND v_stuck = 0
     AND v_overdue = 0
     AND v_cron_failures = 0 THEN
    RETURN;
  END IF;

  v_message := format(
    'Push delivery needs attention: %s dead, %s stuck, %s overdue, %s worker cron failures.',
    v_dead, v_stuck, v_overdue, v_cron_failures
  );

  RAISE WARNING '%', v_message;

  INSERT INTO public.notifications (user_id, title, message, type)
  SELECT p.id, 'Push Delivery Health Alert', v_message, 'system_alert'
  FROM public.profiles AS p
  WHERE p.role = 'admin'
    AND NOT EXISTS (
      SELECT 1
      FROM public.notifications AS n
      WHERE n.user_id = p.id
        AND n.type = 'system_alert'
        AND n.title = 'Push Delivery Health Alert'
        AND n.created_at >= now() - INTERVAL '30 minutes'
    );
END;
$function$;

REVOKE ALL ON FUNCTION private.monitor_push_delivery_health() FROM PUBLIC, anon, authenticated;

-- Retire the attempts-table purge job and its function.
SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_old_delivery_attempts')
  THEN cron.unschedule('purge_old_delivery_attempts') END;
DROP FUNCTION IF EXISTS public.purge_old_delivery_attempts();

DROP TABLE IF EXISTS public.notification_delivery_attempts;

COMMIT;
