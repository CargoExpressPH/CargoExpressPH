-- ============================================================
-- Daily payment/overdue reminder emails
--
-- Every day at 8:00 AM Philippine Time (00:00 UTC — PHT is UTC+8 year-round,
-- no DST), invoke the process-daily-reminders Edge Function. It emails every
-- order that still owes money past (or on) its promised_payment_date, once
-- per calendar day per order, and stamps last_reminder_sent_at so the same
-- order is never re-emailed later the same day.
-- ============================================================

-- ── Column: last time a reminder was sent for this order. NULL means never
--    sent. Compared against CURRENT_DATE by the Edge Function's query so a
--    given order is only emailed once per day no matter how often this job
--    runs (retries, manual re-invocation, etc.). ──
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz;

COMMENT ON COLUMN public.orders.last_reminder_sent_at IS
  'Last time an overdue-payment reminder email was sent for this order. Set by the process-daily-reminders Edge Function; prevents re-emailing the same order twice in one day.';

-- ── Extensions (idempotent — no-ops if already enabled on this project) ──
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- ── One-time manual step — DO NOT put real secret values in this file ──────
--
-- This migration is committed to git. A service_role key or project URL
-- pasted directly into a `net.http_post` call here would sit in version
-- control forever, readable by anyone with repo access, even after being
-- rotated in Supabase — rotation doesn't retroactively scrub git history.
--
-- Store both values in Supabase Vault instead (encrypted at rest, readable
-- only by a SECURITY DEFINER function running as a superuser-equivalent
-- role). Run this ONCE, by hand, in the Supabase Studio SQL editor — never
-- as a migration file:
--
--   select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
--   select vault.create_secret('<SERVICE_ROLE_KEY>',                'service_role_key');
--
-- (Studio → Project Settings → API for both values. If you ever rotate the
-- service role key, update the secret with `select vault.update_secret(...)`
-- — see Supabase's Vault docs for the exact call — rather than re-running
-- create_secret, which will fail on the duplicate name.)
-- ============================================================

-- ── The function pg_cron actually calls. Reads the two secrets out of
--    Vault at call time and fires the Edge Function via pg_net. Runs as
--    SECURITY DEFINER specifically so it — and only it — can read
--    vault.decrypted_secrets; no other role is granted access to that view. ──
CREATE OR REPLACE FUNCTION public.trigger_daily_payment_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_project_url  text;
  v_service_key  text;
BEGIN
  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'trigger_daily_payment_reminders: project_url / service_role_key not found in Vault — skipping. See the migration comment for the one-time setup step.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_project_url || '/functions/v1/process-daily-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trigger_daily_payment_reminders() FROM PUBLIC, anon, authenticated;

-- ── Schedule it. Same unschedule-then-reschedule guard used elsewhere in
--    this project (see purge_old_delivery_attempts) so re-running this
--    migration is idempotent instead of erroring on a duplicate jobname. ──
SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily_payment_reminders')
  THEN cron.unschedule('daily_payment_reminders') END;

SELECT cron.schedule(
  'daily_payment_reminders',
  '0 0 * * *',  -- 00:00 UTC = 08:00 Philippine Time (UTC+8, no DST)
  $cron$SELECT public.trigger_daily_payment_reminders()$cron$
);

-- ============================================================
-- VERIFY (after completing the Vault setup step above and deploying the
-- Edge Function):
--   -- Fire it immediately instead of waiting for 8 AM:
--   SELECT public.trigger_daily_payment_reminders();
--
--   -- Confirm the schedule:
--   SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'daily_payment_reminders';
--
--   -- Inspect recent runs (pg_net delivers async — check a few seconds later):
--   SELECT * FROM net._http_response ORDER BY id DESC LIMIT 5;
-- ============================================================
