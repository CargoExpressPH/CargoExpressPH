-- ============================================================
-- Photo storage: orphan cleanup, auto-archiving, and low-storage alerts.
--
-- Adds the database side of three Storage Monitoring features:
--   1. Built-in cleanup tool — admin-triggered scan for evidence photos
--      whose tracking-number folder no longer matches an order.
--   2. Automated archiving — a daily pg_cron job that deletes shipment
--      evidence for orders Delivered/Cancelled more than 6 months ago.
--   3. Low storage warning — photo-storage-health notifies every admin
--      once Supabase usage crosses 85% of the plan allowance.
--
-- Physical file deletion never happens in SQL (see the existing contract
-- test's `DELETE FROM storage.objects` guard) — these functions only ever
-- LIST what qualifies. The Edge Functions call the Storage API to actually
-- remove bytes, using paths sourced exclusively from these admin/server-only
-- functions rather than anything a client could supply.
--
-- No BEGIN/COMMIT wrapper: this file mixes plain DDL with pg_cron/Vault
-- calls (cron.schedule, vault.decrypted_secrets), matching the un-wrapped
-- style 20260831060000_daily_payment_reminders.sql already uses successfully
-- for the same combination, rather than the transaction-wrapped style used
-- by migrations that only touch ordinary tables/functions.
-- ============================================================

-- ── event_type: add 'cleanup' for both orphan-scan and auto-archive runs.
-- Distinguished via metadata->>'cleanup_kind' ('orphan_scan' | 'auto_archive').
ALTER TABLE public.photo_storage_events
  DROP CONSTRAINT IF EXISTS photo_storage_events_event_type_check;
ALTER TABLE public.photo_storage_events
  ADD CONSTRAINT photo_storage_events_event_type_check
  CHECK (event_type IN ('upload', 'mode_change', 'health_check', 'cleanup'));

-- ── notifications: add 'system_alert' for operational warnings (e.g. low
-- storage) that are not tied to a specific order/trip/inquiry.
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('order_update', 'trip_update', 'announcement', 'general', 'inquiry', 'feedback', 'chat_message', 'system_alert'));

-- ============================================================
-- 1. Orphan scan — admin-callable, read-only.
--
-- An evidence object is orphaned when its tracking-number folder
-- (pickup-proofs/<tracking>/…, delivery-proofs/<tracking>/…,
-- receipts/<tracking>/…) does not match any row in public.orders. This
-- covers cancelled bookings that were deleted outright, test data, and
-- any storage write that outlived its order for other reasons.
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_orphaned_evidence_photos()
RETURNS TABLE (
  name TEXT,
  folder TEXT,
  tracking_number TEXT,
  size_bytes BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.name,
    (storage.foldername(o.name))[1],
    (storage.foldername(o.name))[2],
    CASE WHEN o.metadata ->> 'size' ~ '^[0-9]+$' THEN (o.metadata ->> 'size')::BIGINT ELSE 0 END
  FROM storage.objects o
  WHERE o.bucket_id = 'cargo-photos'
    AND (storage.foldername(o.name))[1] IN ('pickup-proofs', 'delivery-proofs', 'receipts')
    AND (storage.foldername(o.name))[2] IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.orders ord
      WHERE ord.tracking_number = (storage.foldername(o.name))[2]
    );
END;
$$;

REVOKE ALL ON FUNCTION public.list_orphaned_evidence_photos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_orphaned_evidence_photos() TO authenticated;

-- ============================================================
-- 2. Expired evidence lookup — server-only (cron / edge function).
--
-- Not is_admin()-gated: it is invoked with the service-role key from the
-- archive-expired-evidence-photos Edge Function, which has no end-user JWT
-- and so no auth.uid() to check. Locked down instead by revoking from every
-- client-facing role and granting only to service_role — the same shape as
-- reconcile_paymongo_payment_attempt (see 20260804190000_function_privileges.sql).
--
-- "Terminal status age" is read from order_status_events rather than
-- orders.updated_at: updated_at moves on any column edit (e.g. an admin note),
-- not just status, and would understate how long an order has actually been
-- Delivered/Cancelled. MAX(changed_at) for the order's *current* status is
-- the most recent time it entered that status — correct even if the order
-- bounced through the same status twice.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_expired_evidence_orders(p_cutoff TIMESTAMPTZ)
RETURNS TABLE (
  order_id UUID,
  tracking_number TEXT,
  status TEXT,
  terminal_status_at TIMESTAMPTZ,
  pickup_photos JSONB,
  delivery_photos JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.tracking_number, o.status, s.terminal_status_at, o.pickup_photos, o.delivery_photos
  FROM public.orders o
  JOIN LATERAL (
    SELECT max(e.changed_at) AS terminal_status_at
    FROM public.order_status_events e
    WHERE e.order_id = o.id AND e.status = o.status
  ) s ON TRUE
  WHERE o.status IN ('Delivered', 'Cancelled')
    AND s.terminal_status_at IS NOT NULL
    AND s.terminal_status_at < p_cutoff
    AND (
      COALESCE(o.pickup_photos, '[]'::jsonb) <> '[]'::jsonb
      OR COALESCE(o.delivery_photos, '[]'::jsonb) <> '[]'::jsonb
    );
$$;

REVOKE ALL ON FUNCTION public.get_expired_evidence_orders(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_expired_evidence_orders(TIMESTAMPTZ) TO service_role;

-- ============================================================
-- 3. Daily auto-archive schedule.
--
-- Reuses the SAME Vault secrets ('project_url', 'service_role_key') the
-- 20260831060000_daily_payment_reminders.sql migration already required a
-- one-time manual setup for — no additional Vault step needed here. Staggered
-- 90 minutes after the 00:00 UTC payment-reminder job purely to avoid two
-- unrelated jobs firing at the exact same instant; pg_cron would run them
-- concurrently just fine either way.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.trigger_evidence_photo_archive()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_project_url text;
  v_service_key text;
BEGIN
  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'trigger_evidence_photo_archive: project_url / service_role_key not found in Vault — skipping. See 20260831060000_daily_payment_reminders.sql for the one-time setup step.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_project_url || '/functions/v1/archive-expired-evidence-photos',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trigger_evidence_photo_archive() FROM PUBLIC, anon, authenticated;

SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'evidence_photo_archive')
  THEN cron.unschedule('evidence_photo_archive') END;

SELECT cron.schedule(
  'evidence_photo_archive',
  '30 1 * * *',  -- 01:30 UTC = 09:30 Philippine Time (UTC+8, no DST), daily
  $cron$SELECT public.trigger_evidence_photo_archive()$cron$
);

-- ============================================================
-- VERIFY:
--   -- Preview what the cleanup tool would remove right now (run as an admin):
--   SELECT * FROM public.list_orphaned_evidence_photos();
--
--   -- Preview what tonight's archive run would pick up:
--   SELECT * FROM public.get_expired_evidence_orders(now() - interval '6 months');
--
--   -- Fire the archive job immediately instead of waiting for 09:30 PHT:
--   SELECT public.trigger_evidence_photo_archive();
--
--   -- Confirm the schedule:
--   SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'evidence_photo_archive';
-- ============================================================
