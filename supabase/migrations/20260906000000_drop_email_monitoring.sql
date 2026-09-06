-- Remove the custom email monitoring feature. The project now relies
-- entirely on the native Resend dashboard for email metrics, so the local
-- tracking tables/RPCs added in 20260903010000_email_usage_monitoring.sql
-- and 20260903030000_email_activity_log.sql (plus their later fixups) are
-- no longer written to or read from anywhere in the codebase.
BEGIN;

DROP FUNCTION IF EXISTS public.get_email_activity_log(INT, INT);
DROP FUNCTION IF EXISTS public.get_email_usage_summary();

DROP TABLE IF EXISTS public.email_activity_log;
DROP TABLE IF EXISTS public.email_usage_logs;

COMMIT;
