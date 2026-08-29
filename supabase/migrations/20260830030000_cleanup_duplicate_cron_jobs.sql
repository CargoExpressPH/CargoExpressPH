DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-old-activity-logs') THEN
    PERFORM cron.unschedule('purge-old-activity-logs');
  END IF;
  
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-resolve-stale-conversations') THEN
    PERFORM cron.unschedule('auto-resolve-stale-conversations');
  END IF;
END;
$$;
