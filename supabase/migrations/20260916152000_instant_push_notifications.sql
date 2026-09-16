-- Migration to make push notifications instant instead of waiting for the 1-minute cron
CREATE OR REPLACE FUNCTION private.kick_push_worker_on_new_jobs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Fire-and-forget pg_net call to process notifications immediately
  PERFORM private.trigger_push_delivery_worker();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS notification_jobs_kick_worker ON public.notification_delivery_jobs;
CREATE TRIGGER notification_jobs_kick_worker
AFTER INSERT ON public.notification_delivery_jobs
FOR EACH STATEMENT
EXECUTE FUNCTION private.kick_push_worker_on_new_jobs();