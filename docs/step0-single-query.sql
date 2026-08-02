-- ============================================================================
-- CargoExpress PH — Step 0 Diagnostics (SINGLE STATEMENT)
-- READ-ONLY. Returns ONE result set so the SQL Editor shows everything.
-- Run in: Supabase Dashboard → SQL Editor → Run → copy the whole table back.
-- ============================================================================

WITH
q1_version AS (
  SELECT jsonb_agg(jsonb_build_object(
    'version_deployed', CASE
      WHEN prosrc LIKE '%INSERT INTO public.payment_transactions%' THEN 'v3-ledger'
      WHEN prosrc LIKE '%amount_paid = paid_amount%'               THEN 'v1v2-direct-overwrite'
      ELSE 'unknown'
    END,
    'has_onconflict_bug',  prosrc LIKE '%ON CONFLICT (transaction_reference)%',
    'forces_picked_up',    prosrc LIKE '%Picked Up%',
    'overwrites_amount_paid', prosrc LIKE '%amount_paid = paid_amount%',
    'source_length',       length(prosrc)
  )) AS j
  FROM pg_proc WHERE proname = 'reconcile_paymongo_payment_attempt'
),

q2_attempts AS (
  SELECT jsonb_agg(x) AS j FROM (
    SELECT status,
           count(*)                                AS attempts,
           count(payment_id)                       AS with_payment_id,
           min(created_at)::date                   AS oldest,
           max(created_at)::date                   AS newest,
           max(left(coalesce(last_error, ''), 100)) AS sample_error
    FROM payment_attempts GROUP BY status ORDER BY 2 DESC
  ) x
),

ledger AS (
  SELECT order_id, COALESCE(SUM(amount), 0) AS ledger_sum
  FROM payment_transactions GROUP BY order_id
),

q3_drift AS (
  SELECT jsonb_build_object(
    'orders_affected', count(*),
    'total_peso_drift', round(COALESCE(sum(abs(o.amount_paid - COALESCE(l.ledger_sum, 0))), 0), 2),
    'paid_but_has_balance',   count(*) FILTER (WHERE o.payment_status = 'paid'   AND o.remaining_balance > 0),
    'unpaid_but_has_payment', count(*) FILTER (WHERE o.payment_status = 'unpaid' AND o.amount_paid > 0),
    'ledger_mismatch',        count(*) FILTER (WHERE o.amount_paid <> COALESCE(l.ledger_sum, 0))
  ) AS j
  FROM orders o LEFT JOIN ledger l ON l.order_id = o.id
  WHERE (o.payment_status = 'paid'   AND o.remaining_balance > 0)
     OR (o.payment_status = 'unpaid' AND o.amount_paid > 0)
     OR  o.amount_paid <> COALESCE(l.ledger_sum, 0)
),

q4_webhook AS (
  SELECT jsonb_build_object(
    'total_attempts',  count(*),
    'real_captures',   count(*) FILTER (WHERE payment_id LIKE 'pay_%'),
    'self_healed',     count(*) FILTER (WHERE payment_id LIKE 'auto_%'),
    'never_captured',  count(*) FILTER (WHERE payment_id IS NULL),
    'reconciled',      count(*) FILTER (WHERE status = 'reconciled'),
    'failed',          count(*) FILTER (WHERE status = 'failed')
  ) AS j
  FROM payment_attempts
),

q5_ledger_mix AS (
  SELECT jsonb_agg(x) AS j FROM (
    SELECT COALESCE(payment_method, '(null)') AS payment_method,
           CASE WHEN admin_name IN ('System Webhook', 'System') THEN 'automated'
                ELSE 'admin-manual' END       AS origin,
           count(*)                           AS entries,
           count(*) FILTER (WHERE transaction_reference IS NULL) AS null_reference,
           round(sum(amount), 2)              AS total
    FROM payment_transactions
    GROUP BY 1, 2 ORDER BY 3 DESC
  ) x
),

q6_methods AS (
  SELECT jsonb_agg(x) AS j FROM (
    SELECT COALESCE(payment_method, '(null)') AS payment_method,
           payment_status,
           count(*)                           AS orders,
           count(*) FILTER (WHERE promised_payment_date IS NOT NULL) AS has_promised_date,
           round(sum(shipping_cost), 2)       AS billed,
           round(sum(amount_paid), 2)         AS collected,
           round(sum(remaining_balance), 2)   AS outstanding
    FROM orders WHERE status <> 'Cancelled'
    GROUP BY 1, 2 ORDER BY 3 DESC
  ) x
),

q7_early_pay AS (
  SELECT jsonb_agg(x) AS j FROM (
    SELECT status,
           count(*)                                       AS orders_with_payments,
           count(*) FILTER (WHERE actual_weight IS NULL)   AS paid_without_weight,
           round(sum(amount_paid), 2)                      AS amount
    FROM orders WHERE amount_paid > 0
    GROUP BY status ORDER BY 2 DESC
  ) x
),

q8_triggers AS (
  SELECT jsonb_agg(x) AS j FROM (
    SELECT c.relname AS tbl, t.tgname AS trigger_name, p.proname AS fn,
           CASE t.tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc  p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND c.relname IN ('orders', 'payment_transactions', 'payment_attempts')
    ORDER BY 1, 2
  ) x
),

q10_dupes AS (
  -- Possible duplicate cash entries: same order, amount, method, NULL reference
  SELECT jsonb_agg(x) AS j FROM (
    SELECT order_id, amount, payment_method, count(*) AS copies
    FROM payment_transactions
    WHERE transaction_reference IS NULL
    GROUP BY 1, 2, 3 HAVING count(*) > 1
    ORDER BY 4 DESC LIMIT 20
  ) x
)

SELECT * FROM (
  SELECT 1 AS n, 'Q1_reconcile_version_deployed' AS check_name, COALESCE(j, '[]'::jsonb) AS findings FROM q1_version
  UNION ALL SELECT 2,  'Q2_payment_attempts_by_status', COALESCE(j, '[]'::jsonb) FROM q2_attempts
  UNION ALL SELECT 3,  'Q3_projection_drift_totals',    COALESCE(j, '{}'::jsonb) FROM q3_drift
  UNION ALL SELECT 4,  'Q4_webhook_ever_worked',        COALESCE(j, '{}'::jsonb) FROM q4_webhook
  UNION ALL SELECT 5,  'Q5_ledger_by_method_origin',    COALESCE(j, '[]'::jsonb) FROM q5_ledger_mix
  UNION ALL SELECT 6,  'Q6_order_method_distribution',  COALESCE(j, '[]'::jsonb) FROM q6_methods
  UNION ALL SELECT 7,  'Q7_paid_before_weighing',       COALESCE(j, '[]'::jsonb) FROM q7_early_pay
  UNION ALL SELECT 8,  'Q8_triggers_on_payment_tables', COALESCE(j, '[]'::jsonb) FROM q8_triggers
  UNION ALL SELECT 10, 'Q10_suspected_duplicate_cash',  COALESCE(j, '[]'::jsonb) FROM q10_dupes
) r
ORDER BY n;
