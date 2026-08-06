-- ============================================================
-- 20260806040000_outstanding_single_source.sql
--
-- Bugs #8 / #14 — two different "Outstanding" figures in one report.
--
-- Sales Overview showed  SUM(orders.remaining_balance)  over every
--   non-cancelled order.
-- Unsettled Deliveries showed  SUM(GREATEST(shipping_cost - amount_paid, 0))
--   over the five settlement-tracked statuses only.
--
-- Two formulas AND two populations, presented under one heading with one
-- label. They disagreed for two independent reasons:
--
--   1. FORMULA. `remaining_balance` is a stored derivation. It is correct
--      whenever guard_order_update last ran, but a ledger write that lands
--      without touching the order row leaves it behind — which is why
--      UnsettledDeliveriesPage already renders a "ledger says ₱X" annotation
--      when the two disagree. A report should not have to annotate its own
--      arithmetic.
--   2. POPULATION. All-orders includes Pending and Assigned bookings, which
--      have not been weighed and therefore have no price at all. Counting
--      their ₱0 as "outstanding" is harmless only because it is zero; the
--      moment the scope is stated it becomes obviously the wrong scope.
--
-- Resolution: ONE formula — derived, never the stored column — reported at
-- BOTH scopes with each scope named:
--
--   outstandingTotal      settlement-tracked statuses; the pipeline figure.
--                         Reconciles exactly with the Unsettled tab.
--   outstandingAllOrders  every non-cancelled order, for the all-time view.
--   outstandingStored     SUM(remaining_balance) at the same scope as
--                         outstandingTotal — kept ONLY so drift is visible
--                         rather than silent. Never display it as "the"
--                         outstanding figure.
--   unpaidCount           orders with a DERIVED balance owing, tracked scope.
--                         Matches the Unsettled row count.
--
-- `unpaidTotal` is retained as an alias of outstandingAllOrders so an older
-- bundle mid-deploy keeps rendering a sane number.
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
    SELECT
      o.*,
      -- THE definition of what an order owes. Derived, so it cannot lag the
      -- payment ledger the way the stored remaining_balance column can.
      GREATEST(COALESCE(o.shipping_cost, 0) - COALESCE(o.amount_paid, 0), 0) AS outstanding,
      -- Weighed = priced. An unweighed parcel owes nothing only because it has
      -- not been billed yet; that is not the same as settled.
      (COALESCE(o.actual_weight, 0) > 0) AS is_priced,
      (o.status IN ('Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered')) AS is_tracked
    FROM public.orders o
    WHERE o.status <> 'Cancelled'
  ),
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
      COALESCE(SUM(shipping_cost), 0) AS total_revenue,
      COALESCE(SUM(amount_paid), 0)   AS paid_total,
      COALESCE(SUM(outstanding) FILTER (WHERE is_tracked), 0) AS outstanding_tracked,
      COALESCE(SUM(outstanding), 0)                           AS outstanding_all,
      COALESCE(SUM(remaining_balance) FILTER (WHERE is_tracked), 0) AS outstanding_stored,
      COUNT(*) FILTER (WHERE is_tracked AND outstanding > 0.005)    AS unpaid_count,
      COUNT(*) FILTER (WHERE NOT is_priced)                         AS unpriced_count
    FROM active_orders
  ),
  summary AS (
    SELECT jsonb_build_object(
      'totalRevenue',         o.total_revenue,
      'cashTotal',            l.cash_total,
      'gcashTotal',           l.gcash_total,
      'paylaterTotal',        l.paylater_total,
      'methodTotals',         l.method_totals,
      'ledgerTotal',          l.ledger_total,
      'unattributedTotal',    GREATEST(o.paid_total - l.ledger_total, 0),
      'paidTotal',            o.paid_total,
      'outstandingTotal',     o.outstanding_tracked,
      'outstandingAllOrders', o.outstanding_all,
      'outstandingStored',    o.outstanding_stored,
      -- Legacy alias. Kept so a stale bundle mid-deploy still renders.
      'unpaidTotal',          o.outstanding_all,
      'unpaidCount',          o.unpaid_count,
      'unpricedCount',        o.unpriced_count
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
        COALESCE(SUM(outstanding), 0) AS outstanding
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
             outstanding AS remaining_balance, payment_status
      FROM active_orders
      WHERE is_tracked AND outstanding > 0.005
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
