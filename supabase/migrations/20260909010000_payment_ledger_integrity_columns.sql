-- ============================================================
-- Payment ledger integrity columns (BUG-01 fix, part 1 of 3)
--
-- Adds the columns needed to:
--   1. Deduplicate manual (double-click / retried) admin payment
--      submissions by a stable, client-generated idempotency key instead of
--      by transaction_reference (which is often NULL for cash).
--   2. Distinguish a "GCash via PayMongo — automatically confirmed" ledger
--      row from a "Direct GCash transfer — manually verified" one. They are
--      recorded through completely different trust paths and must never be
--      compared as if they were the same kind of reference.
--   3. Detect the same direct GCash transfer being credited twice, including
--      against a DIFFERENT order, via a normalized reference (so "0912 345
--      6789", "0912-345-6789" and "09123456789" are recognized as the same
--      reference) without ever mutating the original, as-entered reference
--      kept in transaction_reference for the historical record.
--
-- All new columns are NULLable and NULL for every existing row, so this
-- migration cannot conflict with historical data — the new partial unique
-- indexes below only apply to rows that populate the new columns, which no
-- existing row does. See docs/bug01-gcash-double-credit-diagnostic.sql and
-- docs/manual-gcash-duplicate-precheck.sql for the read-only checks run
-- against existing data before this migration was written.
-- ============================================================

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS gcash_channel TEXT,
  ADD COLUMN IF NOT EXISTS transaction_reference_normalized TEXT;

ALTER TABLE public.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_gcash_channel_check;
ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_gcash_channel_check
  CHECK (gcash_channel IS NULL OR gcash_channel = ANY (ARRAY['paymongo'::text, 'manual'::text]));

COMMENT ON COLUMN public.payment_transactions.idempotency_key IS
  'Stable id generated once by the client for a single collection attempt and reused on retry (double-click, dropped response). NULL for historical rows and for system-reconciled PayMongo rows, which are already idempotent on transaction_reference.';
COMMENT ON COLUMN public.payment_transactions.gcash_channel IS
  $$Which trust path produced a gcash-method row: 'paymongo' = server-verified automatic capture; 'manual' = admin-recorded direct transfer the admin attests to having verified. NULL for cash rows and historical rows recorded before this distinction existed.$$;
COMMENT ON COLUMN public.payment_transactions.transaction_reference_normalized IS
  'Uppercased, whitespace/dash-stripped form of transaction_reference, populated only for gcash_channel=manual rows, used solely for duplicate-reference detection. transaction_reference itself is left exactly as entered.';

-- One idempotency key can only ever back one ledger row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transactions_idempotency_key
  ON public.payment_transactions USING btree (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The same manually-verified GCash reference can only be credited once,
-- system-wide — this business has one receiving GCash account, so scope is
-- global rather than per-order (a duplicate against a DIFFERENT order is the
-- exact case this is meant to catch).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transactions_manual_gcash_ref
  ON public.payment_transactions USING btree (transaction_reference_normalized)
  WHERE gcash_channel = 'manual' AND transaction_reference_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_gcash_channel
  ON public.payment_transactions USING btree (gcash_channel)
  WHERE gcash_channel IS NOT NULL;
