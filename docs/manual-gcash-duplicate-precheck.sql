-- ============================================================
-- Manual-GCash duplicate-reference pre-check (READ ONLY)
--
-- Run against the LIVE database BEFORE (or after — it is safe either way,
-- since the new unique index only applies to rows that populate the new
-- columns, and no existing row does) applying
-- 20260909010000_payment_ledger_integrity_columns.sql and
-- 20260909030000_manual_payment_hardening.sql.
--
-- Purpose: the new uq_payment_transactions_manual_gcash_ref index cannot
-- retroactively flag anything, because gcash_channel/transaction_reference_
-- normalized are NULL on every historical row (the migration does not
-- backfill them — this task's instructions are explicit that historical
-- financial records are not to be relabeled automatically). This script
-- looks at the EXISTING transaction_reference column directly to surface
-- any already-recorded GCash reference that was, in fact, used more than
-- once — the exact condition the new constraint will prevent going forward.
--
-- NOTHING HERE MODIFIES DATA. A row surfaced below is a CANDIDATE for
-- manual review, not a proven duplicate — a customer can legitimately send
-- two transfers whose reference numbers happen to collide only after
-- normalization is highly unlikely but not impossible with GCash's own
-- reference format; verify before treating a hit as confirmed fraud/error.
-- ============================================================

WITH normalized AS (
  SELECT
    id, order_id, amount, payment_method, created_at, transaction_reference,
    upper(regexp_replace(trim(transaction_reference), '[\s-]+', '', 'g')) AS ref_norm
  FROM public.payment_transactions
  WHERE payment_method = 'gcash'
    AND transaction_reference IS NOT NULL
    AND transaction_reference <> ''
    -- Real PayMongo payment ids (pay_...) are excluded — this check is only
    -- meaningful for admin-entered "direct transfer" references. A PayMongo
    -- id is already protected by unique_tx_ref (exact match) and, going
    -- forward, by reconcile_paymongo_payment_attempt's own idempotency fix.
    AND transaction_reference NOT LIKE 'pay\_%' ESCAPE '\'
    AND transaction_reference NOT LIKE 'src\_%' ESCAPE '\'
    AND transaction_reference NOT LIKE 'auto\_%' ESCAPE '\'
)
SELECT
  n.ref_norm,
  COUNT(*)                                            AS times_used,
  array_agg(DISTINCT n.order_id)                      AS order_ids,
  array_agg(o.tracking_number ORDER BY n.created_at)   AS tracking_numbers,
  array_agg(n.transaction_reference ORDER BY n.created_at) AS as_entered,
  array_agg(n.amount ORDER BY n.created_at)            AS amounts,
  array_agg(n.created_at ORDER BY n.created_at)        AS recorded_at
FROM normalized n
JOIN public.orders o ON o.id = n.order_id
GROUP BY n.ref_norm
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC;

-- If this returns zero rows, the new unique index is safe to rely on with no
-- outstanding cleanup: no pre-existing manual GCash reference was ever
-- reused across two ledger rows.
