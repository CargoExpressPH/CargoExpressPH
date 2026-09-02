-- Email Usage Monitoring: tracks how many emails our automated functions
-- (process-daily-reminders, broadcast-announcement) hand off to Resend, so
-- admins can see how close the account is to Resend's Free Plan limits
-- (100 emails / day, 3,000 emails / month) before a send is silently
-- rejected. This never talks to Resend's own API — it is a local counter,
-- one row per successful dispatch batch, written by the edge functions
-- themselves right after Resend accepts a batch.
BEGIN;

CREATE TABLE public.email_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('daily_reminders', 'announcement')),
  sent_count INTEGER NOT NULL CHECK (sent_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_usage_logs IS
  'One row per successful Resend batch dispatch. sent_count is how many '
  'emails that batch actually handed off to Resend — used to estimate daily '
  '/ monthly usage against the Resend Free Plan limits (100/day, 3,000/month). '
  'Written by edge functions using the service role key, which bypasses RLS; '
  'read only through get_email_usage_summary().';

CREATE INDEX email_usage_logs_created_at_idx ON public.email_usage_logs (created_at DESC);

-- Day/month boundaries are computed in Asia/Manila local time so "today" and
-- "this month" here line up with the same calendar day the daily reminders
-- cron (8:00 AM PHT) and admins in Manila think of as "today" — the same
-- convention already used elsewhere in this project (see e.g.
-- 20260818090000_unique_trip_per_route_per_day.sql).
CREATE OR REPLACE FUNCTION public.get_email_usage_summary()
RETURNS TABLE(
  emails_sent_today BIGINT,
  emails_sent_this_month BIGINT,
  daily_limit INTEGER,
  monthly_limit INTEGER,
  usage_date DATE,
  measured_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE((
      SELECT SUM(l.sent_count) FROM public.email_usage_logs l
      WHERE (l.created_at AT TIME ZONE 'Asia/Manila')::date = (now() AT TIME ZONE 'Asia/Manila')::date
    ), 0)::BIGINT,
    COALESCE((
      SELECT SUM(l.sent_count) FROM public.email_usage_logs l
      WHERE date_trunc('month', l.created_at AT TIME ZONE 'Asia/Manila')
          = date_trunc('month', now() AT TIME ZONE 'Asia/Manila')
    ), 0)::BIGINT,
    100,   -- Resend Free Plan: emails per day
    3000,  -- Resend Free Plan: emails per month
    (now() AT TIME ZONE 'Asia/Manila')::date,
    now();
END;
$$;

ALTER TABLE public.email_usage_logs ENABLE ROW LEVEL SECURITY;

-- No policies: the table is written only by edge functions using the
-- service role key (which bypasses RLS entirely) and read only through the
-- SECURITY DEFINER function above, which enforces admin access itself. This
-- mirrors photo_storage_settings' fully-locked-table pattern.
REVOKE ALL ON public.email_usage_logs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_email_usage_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_email_usage_summary() TO authenticated;

COMMIT;
