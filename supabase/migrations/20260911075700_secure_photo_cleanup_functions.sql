-- Fix HIGH severity security issue: Anonymous callers can delete photo operational history
-- The purge functions were missing REVOKE statements, allowing anyone to execute them
-- with custom retention_days (e.g., 0) and wipe out operational logs.

REVOKE ALL ON FUNCTION public.purge_old_photo_storage_events(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_photo_storage_events(INT) TO service_role;

REVOKE ALL ON FUNCTION public.purge_old_photo_cleanup_queue(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_photo_cleanup_queue(INT) TO service_role;
