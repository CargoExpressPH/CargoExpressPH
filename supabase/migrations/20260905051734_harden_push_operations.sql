-- Close the legacy public RPC surface around push-attempt retention.
REVOKE ALL ON FUNCTION public.purge_old_delivery_attempts()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_delivery_attempts() TO service_role;

-- Create an in-app operational alarm for delivery failures. It remains useful
-- if push itself is degraded because administrators see it when opening the app.
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
  v_failed_attempts INTEGER;
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
    INTO v_failed_attempts
  FROM public.notification_delivery_attempts
  WHERE status = 'failed'
    AND attempted_at >= now() - INTERVAL '15 minutes';

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
     AND v_failed_attempts < 3
     AND v_cron_failures = 0 THEN
    RETURN;
  END IF;

  v_message := format(
    'Push delivery needs attention: %s dead, %s stuck, %s overdue, %s recent provider failures, %s worker cron failures.',
    v_dead, v_stuck, v_overdue, v_failed_attempts, v_cron_failures
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

REVOKE ALL ON FUNCTION private.monitor_push_delivery_health()
  FROM PUBLIC, anon, authenticated;

SELECT CASE
  WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'monitor_push_delivery_health')
  THEN cron.unschedule('monitor_push_delivery_health')
END;

SELECT cron.schedule(
  'monitor_push_delivery_health',
  '*/5 * * * *',
  $cron$SELECT private.monitor_push_delivery_health()$cron$
);
