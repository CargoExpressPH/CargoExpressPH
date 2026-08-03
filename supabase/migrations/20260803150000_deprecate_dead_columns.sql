-- ============================================================
-- 20260803150000_deprecate_dead_columns.sql
--
-- P1 — Option A: rename-deprecate the verified write-only columns.
-- Nothing is dropped. Renaming makes any surviving reader fail loudly and
-- immediately instead of silently reading a column that is never maintained,
-- and it is reversible with a one-line ALTER.
--
-- Drop these in a follow-up migration once a release has passed with no
-- errors referencing the _deprecated_ names.
--
-- ─────────────────────────────────────────────────────────────
-- WHY EACH ONE IS SAFE (traced across src/**, supabase/functions/**,
-- schema.sql triggers, RPCs and RLS policies):
--
-- trips.available_slots
--   Written exactly once — database.js createTrip, `available_slots:
--   tripData.capacity || 1000` — and never read, never updated, never
--   decremented. A stale copy of `capacity` that was never wired up.
--   The write is removed in this same change.
--
-- orders.payment_date
--   Written by PickupModal; zero readers. Every UI that shows a payment date
--   reads payment_transactions.payment_date (OrderDetailPage.jsx:778,
--   PaymentMethodsPage.jsx:240). The modals stopped writing it in P0-1.
--
-- orders.receipt_url
--   Written by PickupModal and DeliveryModal; zero readers. Worse, the
--   evidence-cleanup routine (OrderDetailPage.jsx) deletes the storage object
--   and nulls only payment_transactions.receipt_url, leaving this column
--   pointing at a deleted blob. The modals stopped writing it in P0-1.
--
-- Not referenced by prepare_order_insert, guard_order_update,
-- reconcile_paymongo_payment_attempt, the orders RLS policies, or any
-- Edge Function.
--
-- ─────────────────────────────────────────────────────────────
-- DELIBERATELY EXCLUDED — payment_attempts.description
--
-- The review lists it as write-only, and it is. But it is written by the
-- paymongo-create-payment EDGE FUNCTION (ensureAttempt payload), which
-- deploys independently of migrations. Renaming the column before that
-- function is redeployed would make every GCash payment-attempt registration
-- fail with "column description does not exist" — i.e. it would break
-- payments for the length of the deploy gap.
--
-- Correct sequence for that one, as a separate follow-up:
--   1. Remove `description` from the ensureAttempt payload and from the two
--      .select() lists in supabase/functions/paymongo-create-payment/index.ts
--   2. supabase functions deploy paymongo-create-payment
--   3. Verify a live GCash payment end to end
--   4. THEN rename the column
--
-- ─────────────────────────────────────────────────────────────
-- ALSO DELIBERATELY EXCLUDED — these are unfinished features, not dead
-- weight. Deleting them destroys work already done; they should be wired up:
--   trips.notes                  — captured in CreateTripPage, never rendered
--   orders.service_area_remarks  — the rejection reason never reaches the
--                                  customer whose booking was rejected
--   orders.payment_preference    — collected at booking, never surfaced
--   activity_logs.previous_value — an audit log with only the new value is
--                                  half an audit log
--   activity_logs.record_type    — the discriminator for the polymorphic
--                                  record_id
-- ============================================================


-- ─── Pre-flight: archive before renaming ────────────────────
-- orders.receipt_url predates payment_transactions.receipt_url (added
-- 20260622000000). Any non-NULL value older than that migration may be the
-- ONLY record of that receipt. Run this BEFORE applying:
--
--   SELECT count(*) FROM orders
--   WHERE receipt_url IS NOT NULL AND created_at < '2026-06-22';
--
-- If it returns > 0, export those rows before continuing:
--
--   SELECT id, tracking_number, created_at, receipt_url, payment_date
--   FROM orders
--   WHERE receipt_url IS NOT NULL AND created_at < '2026-06-22'
--   ORDER BY created_at;


DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trips'
      AND column_name = 'available_slots'
  ) THEN
    ALTER TABLE public.trips RENAME COLUMN available_slots TO _deprecated_available_slots;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
      AND column_name = 'payment_date'
  ) THEN
    ALTER TABLE public.orders RENAME COLUMN payment_date TO _deprecated_payment_date;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
      AND column_name = 'receipt_url'
  ) THEN
    ALTER TABLE public.orders RENAME COLUMN receipt_url TO _deprecated_receipt_url;
  END IF;
END;
$$;


COMMENT ON COLUMN public.trips._deprecated_available_slots IS
  'DEPRECATED 2026-08-03 (P1). Write-only duplicate of capacity, never maintained. Drop after one clean release.';
COMMENT ON COLUMN public.orders._deprecated_payment_date IS
  'DEPRECATED 2026-08-03 (P1). Superseded by payment_transactions.payment_date. Drop after one clean release.';
COMMENT ON COLUMN public.orders._deprecated_receipt_url IS
  'DEPRECATED 2026-08-03 (P1). Superseded by payment_transactions.receipt_url. Drop after one clean release.';


-- ============================================================
-- ROLLBACK (if anything breaks):
--   ALTER TABLE public.trips  RENAME COLUMN _deprecated_available_slots TO available_slots;
--   ALTER TABLE public.orders RENAME COLUMN _deprecated_payment_date    TO payment_date;
--   ALTER TABLE public.orders RENAME COLUMN _deprecated_receipt_url     TO receipt_url;
--
-- FOLLOW-UP (after one clean release):
--   ALTER TABLE public.trips  DROP COLUMN _deprecated_available_slots;
--   ALTER TABLE public.orders DROP COLUMN _deprecated_payment_date;
--   ALTER TABLE public.orders DROP COLUMN _deprecated_receipt_url;
-- ============================================================
