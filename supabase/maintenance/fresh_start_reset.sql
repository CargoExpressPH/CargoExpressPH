-- ============================================================================
-- supabase/maintenance/fresh_start_reset.sql
--
-- FRESH-START DATA RESET — NOT A MIGRATION. NOT EXECUTED.
-- Deliberately outside supabase/migrations/ so `supabase db push` can never
-- apply it. Run it ONLY as part of the approved sequence in
-- DATABASE_SIMPLIFICATION_AND_RESET_REVIEW.md §Reset, after:
--   * a verified backup (pg_dump of public + private + auth + storage schemas),
--   * the affected pg_cron workers are paused (see that document),
--   * the owner has approved the table manifest below.
--
-- What it does (one transaction, all-or-nothing):
--   1. refuses to run without an explicit confirmation setting;
--   2. refuses to run while any external obligation is still open (a live
--      or uncertain refund, an unreconciled payment, queued push/email work,
--      an open storage-cleanup item) — unless that check is explicitly
--      acknowledged by the owner;
--   3. TRUNCATEs only the CLEAR tables, in one statement, WITHOUT CASCADE
--      (so a KEEP table can never be emptied by accident: if any KEEP table
--      referenced a cleared table, the statement would fail instead);
--   4. prints a before/after row-count report.
--
-- It never touches: auth.*, storage.*, supabase_migrations.*, cron.*,
-- vault.*, profiles, company_information, legal_documents, legal_consents,
-- photo_storage_settings, user_device_tokens. Customer ACCOUNTS are not
-- deleted here (that is done, only if approved per account, through the
-- if approved per account, through the Supabase Auth Admin API — see the
-- review document). Storage OBJECTS are not deleted here (Storage API only —
-- scripts/reset/cleanup-shipment-photos.mjs).
--
-- Usage (psql, as the database owner):
--   BEGIN;
--   SET LOCAL cargoexpress.reset_confirm = 'I-HAVE-A-VERIFIED-BACKUP';
--   -- only if the owner accepted the listed open items:
--   -- SET LOCAL cargoexpress.reset_ack_open_items = 'yes';
--   \i supabase/maintenance/fresh_start_reset.sql
--   -- inspect the NOTICE report, then:
--   COMMIT;   -- or ROLLBACK;
-- ============================================================================

DO $reset$
DECLARE
  v_blockers text[] := ARRAY[]::text[];
  v_n bigint;
  v_t text;
  v_clear text[] := ARRAY[
    'public.order_status_events', 'public.customer_feedback',
    'public.cancellation_settlement_history', 'public.cancellation_settlements',
    'private.paymongo_refund_recovery_jobs', 'public.payment_refunds',
    'public.payment_transactions', 'public.payment_attempts',
    'public.photo_storage_events', 'public.photo_cleanup_queue',
    'public.notification_delivery_jobs', 'public.notifications',
    'public.chat_messages', 'public.conversations',
    'public.contact_inquiries',
    'public.announcement_email_recipients', 'public.announcement_email_broadcasts',
    'public.activity_logs', 'private.manual_refund_reauth_attempts',
    'public.orders', 'public.trips', 'public.email_subscriptions',
    'public.announcements'
  ];
  v_keep text[] := ARRAY[
    'public.profiles', 'public.company_information', 'public.legal_documents',
    'public.legal_consents', 'public.photo_storage_settings',
    'public.user_device_tokens'
  ];
BEGIN
  -- ── 1. Explicit confirmation ─────────────────────────────────────────────
  IF COALESCE(current_setting('cargoexpress.reset_confirm', true), '') <> 'I-HAVE-A-VERIFIED-BACKUP' THEN
    RAISE EXCEPTION 'Reset refused: SET LOCAL cargoexpress.reset_confirm = ''I-HAVE-A-VERIFIED-BACKUP'' first.';
  END IF;

  -- ── 2. External obligations still open ───────────────────────────────────
  SELECT count(*) INTO v_n FROM public.payment_refunds
   WHERE livemode IS TRUE OR outcome_uncertain
      OR status NOT IN ('succeeded', 'failed');
  IF v_n > 0 THEN v_blockers := v_blockers || format('%s refund(s) live-mode, uncertain or not final', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.payment_attempts
   WHERE status = 'chargeable' OR (status = 'pending' AND payment_id IS NOT NULL);
  IF v_n > 0 THEN v_blockers := v_blockers || format('%s payment attempt(s) captured/chargeable but not reconciled', v_n); END IF;

  SELECT count(*) INTO v_n FROM private.paymongo_refund_recovery_jobs WHERE livemode IS TRUE;
  IF v_n > 0 THEN v_blockers := v_blockers || format('%s LIVE-mode refund recovery job(s)', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.notification_delivery_jobs
   WHERE status NOT IN ('sent', 'skipped', 'dead');
  IF v_n > 0 THEN v_blockers := v_blockers || format('%s push delivery job(s) still queued', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.announcement_email_recipients
   WHERE status NOT IN ('accepted', 'skipped', 'permanent_failed', 'needs_review');
  IF v_n > 0 THEN v_blockers := v_blockers || format('%s announcement email(s) still queued', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.photo_cleanup_queue WHERE completed_at IS NULL;
  IF v_n > 0 THEN v_blockers := v_blockers || format('%s storage cleanup item(s) still open', v_n); END IF;

  IF cardinality(v_blockers) > 0 THEN
    IF COALESCE(current_setting('cargoexpress.reset_ack_open_items', true), '') = 'yes' THEN
      RAISE WARNING 'Reset proceeding with owner-acknowledged open items: %', array_to_string(v_blockers, '; ');
    ELSE
      RAISE EXCEPTION 'Reset refused, open external items: %', array_to_string(v_blockers, '; ');
    END IF;
  END IF;

  -- ── 3. Report BEFORE ─────────────────────────────────────────────────────
  FOREACH v_t IN ARRAY v_clear || v_keep LOOP
    EXECUTE format('SELECT count(*) FROM %s', v_t) INTO v_n;
    RAISE NOTICE 'before  %  %', rpad(v_t, 45), v_n;
  END LOOP;

  -- ── 4. Clear (one statement, no CASCADE, no row triggers fire) ───────────
  -- TRUNCATE does not fire the per-row notification/audit triggers, so no
  -- push, email or activity-log row is produced about removed records.
  EXECUTE 'TRUNCATE TABLE ' || array_to_string(v_clear, ', ') || ' RESTART IDENTITY';

  -- ── 5. Report AFTER ──────────────────────────────────────────────────────
  FOREACH v_t IN ARRAY v_clear || v_keep LOOP
    EXECUTE format('SELECT count(*) FROM %s', v_t) INTO v_n;
    RAISE NOTICE 'after   %  %', rpad(v_t, 45), v_n;
  END LOOP;
END
$reset$;
