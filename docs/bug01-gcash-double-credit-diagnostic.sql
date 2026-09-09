-- ============================================================
-- BUG-01 — existing double-credit diagnostic (READ ONLY)
--
-- Run this against the LIVE database BEFORE relying on the fix in
-- 20260909020000_fix_paymongo_reconciliation_idempotency.sql to know whether
-- the bug it closes has already damaged real orders.
--
-- What it looks for: a payment_attempts row (one PayMongo checkout source)
-- that produced MORE THAN ONE payment_transactions row. Because one source
-- can only ever be captured once by PayMongo, more than one ledger row
-- funded by the same source is the exact shape BUG-01 produces — a real
-- payment reconciled once with the synthetic `auto_<sourceId>` reference and
-- again with the real PayMongo payment id.
--
-- NOTHING HERE MODIFIES DATA. A row surfaced below is a CANDIDATE, not a
-- proven duplicate — verify each one against the PayMongo dashboard
-- (Payments, filtered by the source id) before touching it. A legitimate
-- order can also show two GCash rows if the customer genuinely paid twice
-- (e.g. topped up a partial balance) with the SAME payment_method; that is
-- expected and NOT this bug. The `looks_like_bug01` flag below narrows to
-- the specific shape (a synthetic `auto_...` reference alongside a real one,
-- for the SAME order, close together in time) rather than flagging every
-- order with two GCash payments.
-- ============================================================

-- ── 1. Orders with more than one payment_transactions row referencing the
--       same payment_attempts.source_id lineage (via matching order_id +
--       gcash method + amount pattern), specifically where one reference
--       matches the synthetic shape.
SELECT
  o.id                    AS order_id,
  o.tracking_number,
  o.status,
  o.amount_paid,
  o.shipping_cost,
  array_agg(pt.id ORDER BY pt.created_at)                      AS payment_transaction_ids,
  array_agg(pt.transaction_reference ORDER BY pt.created_at)   AS references_in_order,
  array_agg(pt.amount ORDER BY pt.created_at)                  AS amounts_in_order,
  array_agg(pt.created_at ORDER BY pt.created_at)              AS recorded_at,
  bool_or(pt.transaction_reference LIKE 'auto\_%' ESCAPE '\')  AS has_synthetic_reference,
  COUNT(*)                                                     AS gcash_row_count
FROM public.orders o
JOIN public.payment_transactions pt
  ON pt.order_id = o.id
 AND pt.payment_method = 'gcash'
 AND pt.transaction_reference IS NOT NULL
GROUP BY o.id, o.tracking_number, o.status, o.amount_paid, o.shipping_cost
HAVING COUNT(*) > 1
ORDER BY bool_or(pt.transaction_reference LIKE 'auto\_%' ESCAPE '\') DESC, o.amount_paid DESC;

-- ── 2. Narrower view: only orders where a synthetic reference is present
--       AND a second row landed within 10 minutes of it — the timing
--       signature of the webhook/poll capture race BUG-01 describes.
WITH synthetic AS (
  SELECT order_id, id, created_at, amount
  FROM public.payment_transactions
  WHERE payment_method = 'gcash'
    AND transaction_reference LIKE 'auto\_%' ESCAPE '\'
)
SELECT
  s.order_id,
  o.tracking_number,
  s.id           AS synthetic_transaction_id,
  s.created_at   AS synthetic_recorded_at,
  s.amount       AS synthetic_amount,
  pt2.id         AS other_transaction_id,
  pt2.transaction_reference AS other_reference,
  pt2.created_at AS other_recorded_at,
  pt2.amount     AS other_amount,
  ABS(EXTRACT(EPOCH FROM (pt2.created_at - s.created_at))) AS seconds_apart
FROM synthetic s
JOIN public.orders o ON o.id = s.order_id
JOIN public.payment_transactions pt2
  ON pt2.order_id = s.order_id
 AND pt2.id <> s.id
 AND pt2.payment_method = 'gcash'
 AND ABS(EXTRACT(EPOCH FROM (pt2.created_at - s.created_at))) < 600
ORDER BY seconds_apart ASC;

-- ── 3. Aggregate impact: total ₱ potentially over-credited if every
--       synthetic-reference row in query 1 turns out to be a genuine
--       duplicate of another row on the same order (upper bound — verify
--       each order individually before treating this number as real).
SELECT
  COUNT(*)                          AS orders_with_synthetic_reference,
  COALESCE(SUM(s.amount), 0)        AS upper_bound_overcredit_php
FROM (
  SELECT DISTINCT ON (order_id) order_id, amount
  FROM public.payment_transactions
  WHERE payment_method = 'gcash'
    AND transaction_reference LIKE 'auto\_%' ESCAPE '\'
) s;
