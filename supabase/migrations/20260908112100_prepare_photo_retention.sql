-- Safe Photo Table Retention Policy Preparation
-- This migration creates the retention functions but does NOT schedule them yet.

CREATE OR REPLACE FUNCTION public.purge_old_photo_storage_events(retention_days INT DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  -- Retention Policy: 30 days is sufficient for operational health metrics.
  DELETE FROM public.photo_storage_events
  WHERE created_at < now() - (retention_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.purge_old_photo_cleanup_queue(retention_days INT DEFAULT 7)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  -- Purge ONLY successfully completed tasks past the retention period.
  -- Pending, running, failed, and retryable tasks are explicitly preserved.
  -- Base the period on completed_at.
  DELETE FROM public.photo_cleanup_queue
  WHERE completed_at IS NOT NULL
    AND completed_at < now() - (retention_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count;
END;
$function$;

-- To verify which rows would qualify without deleting them, run:
-- SELECT id, event_type, created_at FROM public.photo_storage_events WHERE created_at < now() - interval '30 days';
-- SELECT id, storage_path, completed_at FROM public.photo_cleanup_queue WHERE completed_at < now() - interval '7 days';

-- Note: These functions are intentionally NOT scheduled via pg_cron in this migration.
-- They can be invoked manually by an admin or scheduled later if storage growth warrants it.
