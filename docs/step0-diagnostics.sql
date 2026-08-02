-- ============================================================================
-- CargoExpress PH — Step 0 Payment Diagnostics
-- READ-ONLY. No INSERT / UPDATE / DELETE / DDL. Safe to run on production.
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Paste the output back to continue the payment redesign.
-- ============================================================================


-- ─── Q1. Which reconcile version is actually deployed? ──────────────────────
-- 'v3-ledger'   → inserts into payment_transactions (has the ON CONFLICT bug)
-- 'v1v2-direct' → overwrites orders.amount_paid directly
-- no rows       → the function does not exist at all
SELECT
  proname,
  CASE
    WHEN prosrc LIKE '%INSERT INTO public.payment_transactions%' THEN 'v3-ledger'
    WHEN prosrc LIKE '%SET payment_method%'                      THEN 'v1v2-direct'
    ELSE 'unknown'
  END                                              AS version_deployed,
  prosrc LIKE '%ON CONFLICT (transaction_reference)%' AS has_onconflict_bug,
  prosrc LIKE '%status = ''Picked Up''%'             AS forces_picked_up,
  length(prosrc)                                     AS source_length
FROM pg_proc
WHERE proname = 'reconcile_paymongo_payment_attempt';


-- ─── Q2. How many payments are stuck? ───────────────────────────────────────
SELECT
  status,
  count(*)                                   AS attempts,
  count(payment_id)                          AS with_payment_id,
  min(created_at)::date                      AS oldest,
  max(created_at)::date                      AS newest,
  max(left(coalesce(last_error,''), 120))    AS sample_error
FROM payment_attempts
GROUP BY status
ORDER BY attempts DESC;


-- ─── Q3. How far has the projection drifted from the ledger? ────────────────
-- Every row here is an order whose displayed totals disagree with reality.
-- The COUNT sizes the Phase 2 backfill.
WITH ledger AS (
  SELECT order_id, COALESCE(SUM(amount), 0) AS ledger_sum
  FROM payment_transactions
  GROUP BY order_id
)
SELECT
  o.tracking_number,
  o.status,
  o.payment_status,
  o.shipping_cost,
  o.amount_paid,
  COALESCE(l.ledger_sum, 0)                       AS ledger_sum,
  o.amount_paid - COALESCE(l.ledger_sum, 0)       AS drift,
  o.remaining_balance,
  CASE
    WHEN o.payment_status = 'paid'   AND o.remaining_balance > 0 THEN 'paid-but-has-balance'
    WHEN o.payment_status = 'unpaid' AND o.amount_paid > 0       THEN 'unpaid-but-has-payment'
    WHEN o.amount_paid <> COALESCE(l.ledger_sum, 0)              THEN 'ledger-mismatch'
  END                                             AS problem
FROM orders o
LEFT JOIN ledger l ON l.order_id = o.id
WHERE (o.payment_status = 'paid'   AND o.remaining_balance > 0)
   OR (o.payment_status = 'unpaid' AND o.amount_paid > 0)
   OR  o.amount_paid <> COALESCE(l.ledger_sum, 0)
ORDER BY abs(o.amount_paid - COALESCE(l.ledger_sum, 0)) DESC
LIMIT 100;

-- Q3b. Just the totals (run this even if Q3 returns many rows)
WITH ledger AS (
  SELECT order_id, COALESCE(SUM(amount), 0) AS ledger_sum
  FROM payment_transactions GROUP BY order_id
)
SELECT
  count(*)                                                   AS orders_affected,
  round(sum(abs(o.amount_paid - COALESCE(l.ledger_sum,0))),2) AS total_peso_drift
FROM orders o
LEFT JOIN ledger l ON l.order_id = o.id
WHERE (o.payment_status = 'paid'   AND o.remaining_balance > 0)
   OR (o.payment_status = 'unpaid' AND o.amount_paid > 0)
   OR  o.amount_paid <> COALESCE(l.ledger_sum, 0);


-- ─── Q4. Was the PayMongo webhook EVER working? ─────────────────────────────
-- 'auto_%' references are produced ONLY by the self-heal path (webhook or poll
-- found a source already paid). Real webhook captures produce 'pay_%' ids.
-- If captured = 0, no payment has ever completed the capture path.
SELECT
  count(*)                                                  AS total_attempts,
  count(*) FILTER (WHERE payment_id LIKE 'pay_%')           AS real_captures,
  count(*) FILTER (WHERE payment_id LIKE 'auto_%')          AS self_healed,
  count(*) FILTER (WHERE payment_id IS NULL)                AS never_captured,
  count(*) FILTER (WHERE status = 'reconciled')             AS reconciled,
  count(*) FILTER (WHERE status = 'failed')                 AS failed
FROM payment_attempts;


-- ─── Q5. Are GCash payments reaching the ledger at all? ─────────────────────
-- If 'System Webhook' / gcash rows are absent, customer payments never landed.
SELECT
  payment_method,
  provider_guess,
  count(*) AS entries,
  round(sum(amount), 2) AS total
FROM (
  SELECT payment_method,
         CASE WHEN admin_name IN ('System Webhook','System') THEN 'automated'
              ELSE 'admin-manual' END AS provider_guess,
         amount
  FROM payment_transactions
) t
GROUP BY payment_method, provider_guess
ORDER BY entries DESC;


-- ─── Q6. Payment method / terms distribution ────────────────────────────────
-- Sizes the split of payment_method (cash|gcash) from payment_terms (full|deferred).
-- 'paylater' currently sits in payment_method, conflating the two dimensions.
SELECT
  COALESCE(payment_method, '(null)')            AS payment_method,
  payment_status,
  count(*)                                      AS orders,
  count(*) FILTER (WHERE promised_payment_date IS NOT NULL) AS has_promised_date,
  round(sum(shipping_cost), 2)                  AS total_billed,
  round(sum(amount_paid), 2)                    AS total_collected,
  round(sum(remaining_balance), 2)              AS total_outstanding
FROM orders
WHERE status <> 'Cancelled'
GROUP BY 1, 2
ORDER BY orders DESC;


-- ─── Q7. Can a customer currently pay before the weight is known? ───────────
-- Any row > 0 confirms the payability gate is needed (payments on estimates).
SELECT
  o.status,
  count(*)                                        AS orders_with_payments,
  count(*) FILTER (WHERE o.actual_weight IS NULL)  AS paid_without_weight
FROM orders o
WHERE o.amount_paid > 0
GROUP BY o.status
ORDER BY orders_with_payments DESC;


-- ─── Q8. Trigger inventory on payment tables ────────────────────────────────
SELECT
  c.relname   AS table_name,
  t.tgname    AS trigger_name,
  p.proname   AS function_name,
  CASE t.tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_proc  p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND c.relname IN ('orders', 'payment_transactions', 'payment_attempts')
ORDER BY c.relname, t.tgname;


-- ─── Q9. Does the partial unique index (the ON CONFLICT blocker) exist? ─────
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('payment_transactions', 'payment_attempts')
ORDER BY tablename, indexname;
