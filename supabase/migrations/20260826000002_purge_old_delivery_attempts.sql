-- Create function to purge old delivery attempts
CREATE OR REPLACE FUNCTION public.purge_old_delivery_attempts()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Keep only the last 7 days of delivery attempts
  DELETE FROM public.notification_delivery_attempts
  WHERE attempted_at < now() - interval '7 days';
END;
$function$;

-- Schedule the cron job to run daily at 4:00 AM
SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_old_delivery_attempts') THEN cron.unschedule('purge_old_delivery_attempts') END;
SELECT cron.schedule('purge_old_delivery_attempts', '0 4 * * *', $cron$SELECT public.purge_old_delivery_attempts()$cron$);
