-- ============================================================================
-- Step 0b — Stuck PayMongo attempts requiring manual verification
-- READ-ONLY. Cross-check each source_id in the PayMongo dashboard
-- (Payments → search by source id) to find money captured but never recorded.
-- ============================================================================

SELECT
  pa.source_id,
  pa.status                              AS attempt_status,
  pa.amount                              AS intended_amount,
  pa.created_at::date                    AS attempted_on,
  o.tracking_number,
  o.status                               AS order_status,
  o.shipping_cost,
  o.amount_paid                          AS recorded_paid,
  o.remaining_balance,
  o.payment_status,
  p.name                                 AS customer_name,
  p.phone                                AS customer_phone,
  -- has ANY ledger row been written for this order?
  COALESCE((SELECT count(*) FROM payment_transactions t WHERE t.order_id = o.id), 0)
                                         AS ledger_rows
FROM payment_attempts pa
JOIN orders   o ON o.id = pa.order_id
LEFT JOIN profiles p ON p.id = o.user_id
WHERE pa.status IN ('chargeable', 'pending')
ORDER BY
  CASE pa.status WHEN 'chargeable' THEN 0 ELSE 1 END,  -- chargeable = highest risk
  pa.created_at DESC;


-- ─── The single drifted order (Q3: 1 order, ₱10,000) ────────────────────────
WITH ledger AS (
  SELECT order_id, COALESCE(SUM(amount), 0) AS ledger_sum
  FROM payment_transactions GROUP BY order_id
)
SELECT
  o.tracking_number, o.status, o.payment_status,
  o.shipping_cost, o.amount_paid, COALESCE(l.ledger_sum, 0) AS ledger_sum,
  o.amount_paid - COALESCE(l.ledger_sum, 0)                 AS drift,
  o.remaining_balance
FROM orders o LEFT JOIN ledger l ON l.order_id = o.id
WHERE o.amount_paid <> COALESCE(l.ledger_sum, 0);


-- ─── Money collected on CANCELLED orders (refund obligations) ───────────────
SELECT
  o.tracking_number, o.status, o.amount_paid, o.shipping_cost,
  o.updated_at::date AS cancelled_around,
  (SELECT count(*) FROM payment_transactions t WHERE t.order_id = o.id) AS ledger_rows
FROM orders o
WHERE o.status = 'Cancelled' AND o.amount_paid > 0
ORDER BY o.amount_paid DESC;
