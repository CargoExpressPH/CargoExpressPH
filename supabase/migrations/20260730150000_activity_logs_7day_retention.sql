-- ======================================================================
-- 20260730150000_activity_logs_7day_retention.sql
--
-- Retention policy: keep only the last 7 days of admin activity logs.
-- A pg_cron job runs daily at 03:00 UTC and deletes older rows.
-- ======================================================================

-- 1. Enable pg_cron (available on all Supabase plans)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Purge function (SECURITY DEFINER so the cron job can bypass RLS)
CREATE OR REPLACE FUNCTION public.purge_old_activity_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.activity_logs
  WHERE created_at < now() - interval '7 days';
END;
$$;

-- Cron runs as postgres; no client role should call this directly
REVOKE EXECUTE ON FUNCTION public.purge_old_activity_logs() FROM PUBLIC, anon, authenticated;

-- 3. Schedule daily purge (idempotent: unschedule an existing job first)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-old-activity-logs') THEN
    PERFORM cron.unschedule('purge-old-activity-logs');
  END IF;
END;
$$;

SELECT cron.schedule(
  'purge-old-activity-logs',
  '0 3 * * *',
  $$SELECT public.purge_old_activity_logs()$$
);

-- 4. Apply the retention policy immediately
SELECT public.purge_old_activity_logs();
