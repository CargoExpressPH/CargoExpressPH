-- =============================================================================
-- 20260824100000_drop_deprecated_columns.sql
--
-- Retires the three columns tombstoned by 20260803150000_deprecate_dead_columns.sql.
-- Each was left in place with a COMMENT reading "Drop after one clean release";
-- three weeks and ~40 migrations have passed, so this is that drop.
--
--   orders._deprecated_payment_date    → superseded by payment_transactions.payment_date
--   orders._deprecated_receipt_url     → superseded by payment_transactions.receipt_url
--   trips._deprecated_available_slots  → write-only duplicate of capacity, never maintained
--
-- Verified unreferenced before dropping: no read or write in src/ (128 code
-- files), no Edge Function, no trigger, RPC, RLS policy, index, constraint,
-- view or generated column in schema.sql. The payment columns were superseded
-- by the payment_transactions ledger, which has been the sole writer of order
-- payment totals since 20260803100000.
--
-- IRREVERSIBLE: this discards whatever historical values the columns still
-- hold. The payment data was copied into payment_transactions by the
-- 20260803 ledger migration; available_slots was never maintained and holds
-- its DEFAULT 0 for every row. Nothing reads any of the three, but a restore
-- would need a backup, not a down-migration.
-- =============================================================================

ALTER TABLE public.orders DROP COLUMN IF EXISTS _deprecated_payment_date;
ALTER TABLE public.orders DROP COLUMN IF EXISTS _deprecated_receipt_url;
ALTER TABLE public.trips  DROP COLUMN IF EXISTS _deprecated_available_slots;
