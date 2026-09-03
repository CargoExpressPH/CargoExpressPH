-- Email Activity Log: one row per individual email recipient, unlike
-- email_usage_logs (one row per Resend BATCH, aggregate sent_count/
-- failed_count only). This powers the admin "Recent Email Activity" table
-- — who was emailed, what subject, when, and whether it reached Resend —
-- which email_usage_logs cannot answer since it never records a recipient.
-- Written by the same edge functions that already write email_usage_logs
-- (process-daily-reminders, broadcast-announcement), using the service
-- role key, right after each Resend batch call resolves.
BEGIN;

CREATE TABLE public.email_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('daily_reminders', 'announcement')),
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_activity_log IS
  'One row per individual email recipient (contrast email_usage_logs, which '
  'is one row per batch). status/error_message reflect the outcome of the '
  'whole Resend batch call that recipient was part of — this codebase does '
  'not parse Resend''s per-message batch response, the same precision '
  'email_usage_logs'' sent/failed counts already use. Written by edge '
  'functions using the service role key, which bypasses RLS; read only '
  'through get_email_activity_log(), since recipient_email/recipient_name '
  'are customer PII.';

CREATE INDEX email_activity_log_created_at_idx ON public.email_activity_log (created_at DESC);

ALTER TABLE public.email_activity_log ENABLE ROW LEVEL SECURITY;

-- No policies: same fully-locked-table pattern as email_usage_logs — the
-- table is written only by edge functions (service role, bypasses RLS) and
-- read only through the SECURITY DEFINER function below, which enforces
-- admin access itself.
REVOKE ALL ON public.email_activity_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_email_activity_log(p_page INT DEFAULT 1, p_page_size INT DEFAULT 10)
RETURNS TABLE(
  id UUID,
  source TEXT,
  recipient_email TEXT,
  recipient_name TEXT,
  subject TEXT,
  status TEXT,
  order_id UUID,
  tracking_number TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_page INT := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size INT := LEAST(GREATEST(COALESCE(p_page_size, 10), 1), 100);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    l.id, l.source, l.recipient_email, l.recipient_name, l.subject, l.status,
    l.order_id, o.tracking_number, l.error_message, l.created_at,
    COUNT(*) OVER()::BIGINT AS total_count
  FROM public.email_activity_log l
  LEFT JOIN public.orders o ON o.id = l.order_id
  ORDER BY l.created_at DESC
  LIMIT v_page_size
  OFFSET (v_page - 1) * v_page_size;
END;
$$;

REVOKE ALL ON FUNCTION public.get_email_activity_log(INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_email_activity_log(INT, INT) TO authenticated;

COMMIT;
