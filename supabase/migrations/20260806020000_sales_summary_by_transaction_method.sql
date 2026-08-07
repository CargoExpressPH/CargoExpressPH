-- ============================================================
-- 20260806020000_sales_summary_by_transaction_method.sql
--
-- Finding 17 — collections were attributed to the wrong payment method.
--
-- BEFORE: get_sales_summary() bucketed the CUMULATIVE orders.amount_paid by
--   orders.payment_method. That column records the method of the LAST payment
--   event on the order, not the method of each peso collected. An order picked
--   up on GCash and settled in cash at the door therefore reported its entire
--   balance under whichever label happened to be sitting on the order row —
--   every partial payment misfiled, and the "Payment Methods" donut on
--   /admin/sales was wrong by construction the moment an order paid twice.
--
-- AFTER: collections are aggregated from public.payment_transactions, grouped
--   by that table's OWN payment_method. The ledger is already the sole writer
--   of orders.amount_paid (20260803100000), so the same rows that produce the
--   total now produce the split, and the two cannot disagree.
--
-- Filter parity is deliberate: only ledger rows with payment_status IN
-- ('paid','partial') are summed — exactly the predicate
-- update_order_payment_totals uses to derive amount_paid. Any other predicate
-- would make the method breakdown fail to add up to paidTotal.
--
-- 'unattributedTotal' is new and is NOT cosmetic. Legacy orders that were
-- marked paid before the ledger became authoritative have amount_paid with no
-- backing transaction rows. Rather than silently folding that money into
-- "Cash" (which is what a plain grouping would imply), it is reported as its
-- own figure: money we know was collected but cannot attribute to a method.
-- Prefer an honest gap over a plausible bucket.
--
-- 'methodTotals' carries the full grouping so a method added later (a new
-- wallet, a bank transfer) shows up in reporting without another migration.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_sales_summary();

CREATE OR REPLACE FUNCTION public.get_sales_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  WITH active_orders AS (
    SELECT *
    FROM public.orders
    WHERE status <> 'Cancelled'
  ),
  -- One row per (method) across every collected peso on a non-cancelled order.
  ledger AS (
    SELECT
      LOWER(COALESCE(NULLIF(TRIM(pt.payment_method), ''), 'unspecified')) AS method,
      COALESCE(SUM(pt.amount), 0) AS total,
      COUNT(*) AS payment_count
    FROM public.payment_transactions pt
    JOIN active_orders o ON o.id = pt.order_id
    WHERE pt.payment_status IN ('paid', 'partial')
    GROUP BY 1
  ),
  ledger_rollup AS (
    SELECT
      COALESCE(SUM(total) FILTER (WHERE method = 'cash'), 0)     AS cash_total,
      COALESCE(SUM(total) FILTER (WHERE method = 'gcash'), 0)    AS gcash_total,
      COALESCE(SUM(total) FILTER (WHERE method = 'paylater'), 0) AS paylater_total,
      COALESCE(SUM(total), 0)                                    AS ledger_total,
      COALESCE(
        jsonb_agg(
          jsonb_build_object('method', method, 'total', total, 'count', payment_count)
          ORDER BY total DESC
        ),
        '[]'::jsonb
      ) AS method_totals
    FROM ledger
  ),
  order_rollup AS (
    SELECT
      COALESCE(SUM(shipping_cost), 0)     AS total_revenue,
      COALESCE(SUM(amount_paid), 0)       AS paid_total,
      COALESCE(SUM(remaining_balance), 0) AS unpaid_total,
      COUNT(*) FILTER (
        WHERE payment_status IS NULL OR payment_status IN ('unpaid', 'partial')
      ) AS unpaid_count
    FROM active_orders
  ),
  summary AS (
    SELECT jsonb_build_object(
      'totalRevenue',       o.total_revenue,
      'cashTotal',          l.cash_total,
      'gcashTotal',         l.gcash_total,
      'paylaterTotal',      l.paylater_total,
      'methodTotals',       l.method_totals,
      'ledgerTotal',        l.ledger_total,
      -- Collected money with no ledger row to attribute it to. Never negative.
      'unattributedTotal',  GREATEST(o.paid_total - l.ledger_total, 0),
      'paidTotal',          o.paid_total,
      'unpaidTotal',        o.unpaid_total,
      'unpaidCount',        o.unpaid_count
    ) AS value
    FROM order_rollup o, ledger_rollup l
  ),
  monthly AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.month DESC), '[]'::jsonb) AS value
    FROM (
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COALESCE(SUM(shipping_cost), 0) AS total_revenue,
        COALESCE(SUM(amount_paid), 0) AS collected,
        COALESCE(SUM(remaining_balance), 0) AS outstanding
      FROM active_orders
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
      LIMIT 24
    ) m
  ),
  unpaid AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.created_at DESC), '[]'::jsonb) AS value
    FROM (
      SELECT id, tracking_number, created_at, status, shipping_cost, amount_paid,
             remaining_balance, payment_status
      FROM active_orders
      WHERE payment_status IS NULL OR payment_status IN ('unpaid', 'partial')
      ORDER BY created_at DESC
      LIMIT 100
    ) u
  )
  SELECT jsonb_build_object(
    'summary', summary.value,
    'monthlySales', monthly.value,
    'unpaidOrders', unpaid.value
  )
  INTO payload
  FROM summary, monthly, unpaid;

  RETURN payload;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_summary() TO authenticated;

-- Backs the ledger JOIN above and every per-order payment history read.
CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_method
  ON public.payment_transactions (order_id, payment_method);
