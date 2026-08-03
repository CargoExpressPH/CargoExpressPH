-- ============================================================
-- P0-1 — Payment drift diagnostic (READ ONLY)
--
-- Run this in the Supabase SQL editor BEFORE deploying
-- 20260803100000_atomic_order_payment.sql.
--
-- It finds orders whose cached payment totals disagree with the
-- payment_transactions ledger — the damage caused by the old two-round-trip
-- pickup/delivery flow, where the orders UPDATE could succeed and the ledger
-- INSERT then fail (unique_tx_ref 23505 on a retried or webhook-raced
-- reference), leaving an order marked paid with no backing ledger row.
--
-- NOTHING HERE MODIFIES DATA. Financial records should not be auto-corrected;
-- review the output and decide per row.
-- ============================================================


-- ── 1. Orders whose amount_paid disagrees with the ledger ───────────────────
-- ledger_total is the authority. drift > 0 means the order claims more money
-- was collected than the ledger can account for.
SELECT
  o.id,
  o.tracking_number,
  o.status,
  o.created_at,
  o.shipping_cost,
  o.amount_paid                       AS order_amount_paid,
  COALESCE(l.ledger_total, 0)         AS ledger_total,
  o.amount_paid - COALESCE(l.ledger_total, 0) AS drift,
  o.payment_status                    AS order_payment_status,
  o.remaining_balance                 AS order_remaining_balance,
  GREATEST(0, o.shipping_cost - COALESCE(l.ledger_total, 0)) AS expected_remaining_balance,
  COALESCE(l.tx_count, 0)             AS ledger_rows
FROM public.orders o
LEFT JOIN (
  SELECT order_id,
         SUM(amount) AS ledger_total,
         COUNT(*)    AS tx_count
  FROM public.payment_transactions
  WHERE payment_status IN ('paid', 'partial')
  GROUP BY order_id
) l ON l.order_id = o.id
WHERE ABS(o.amount_paid - COALESCE(l.ledger_total, 0)) > 0.01
ORDER BY ABS(o.amount_paid - COALESCE(l.ledger_total, 0)) DESC;


-- ── 2. The worst case: marked paid/partial with ZERO ledger rows ────────────
-- These are almost certainly the failed-second-step orders.
SELECT
  o.id,
  o.tracking_number,
  o.status,
  o.created_at,
  o.shipping_cost,
  o.amount_paid,
  o.payment_status,
  o.payment_reference
FROM public.orders o
WHERE o.amount_paid > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.payment_transactions t WHERE t.order_id = o.id
  )
ORDER BY o.amount_paid DESC;


-- ── 3. Revenue impact ───────────────────────────────────────────────────────
-- get_sales_summary() sums orders.amount_paid, so this is the amount by which
-- reported collections currently differ from the ledger.
SELECT
  COUNT(*)                                              AS drifted_orders,
  ROUND(SUM(o.amount_paid), 2)                          AS reported_collected,
  ROUND(SUM(COALESCE(l.ledger_total, 0)), 2)            AS ledger_collected,
  ROUND(SUM(o.amount_paid - COALESCE(l.ledger_total, 0)), 2) AS net_overstatement
FROM public.orders o
LEFT JOIN (
  SELECT order_id, SUM(amount) AS ledger_total
  FROM public.payment_transactions
  WHERE payment_status IN ('paid', 'partial')
  GROUP BY order_id
) l ON l.order_id = o.id
WHERE o.status <> 'Cancelled'
  AND ABS(o.amount_paid - COALESCE(l.ledger_total, 0)) > 0.01;


-- ── 4. Reverse check: ledger rows the orders row never absorbed ─────────────
-- drift < 0. Usually means a webhook inserted a payment that a later client
-- write then overwrote.
SELECT
  o.tracking_number,
  o.amount_paid AS order_amount_paid,
  SUM(t.amount) AS ledger_total,
  ARRAY_AGG(t.transaction_reference ORDER BY t.created_at) AS refs
FROM public.orders o
JOIN public.payment_transactions t ON t.order_id = o.id
WHERE t.payment_status IN ('paid', 'partial')
GROUP BY o.id, o.tracking_number, o.amount_paid
HAVING SUM(t.amount) - o.amount_paid > 0.01
ORDER BY SUM(t.amount) - o.amount_paid DESC;


-- ============================================================
-- If (1) and (2) return zero rows, no historical repair is needed and the
-- migration can be applied directly.
--
-- If they return rows, the safe repair is to force the ledger trigger to
-- recompute each affected order, WITHOUT inventing any money:
--
--   UPDATE public.payment_transactions
--      SET payment_status = payment_status
--    WHERE order_id = '<id>';
--
-- That is a no-op write whose only effect is firing
-- update_order_payment_totals, which recomputes amount_paid /
-- remaining_balance / payment_status from the ledger.
--
-- Orders in query (2) — paid with no ledger rows at all — CANNOT be repaired
-- this way. Recomputing sets them to unpaid, which may or may not be correct:
-- the money may genuinely have been collected and simply never recorded.
-- Reconcile those against GCash/PayMongo records by hand before touching them.
-- ============================================================
