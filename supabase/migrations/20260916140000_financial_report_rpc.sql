CREATE OR REPLACE FUNCTION public.get_financial_report_data(p_start_date TIMESTAMPTZ, p_end_date TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  WITH payments AS (
    SELECT id, order_id, amount, LOWER(TRIM(payment_method)) as method, created_at as event_date, payment_status, transaction_reference
    FROM payment_transactions
    WHERE payment_status IN ('paid', 'partial')
      AND created_at >= p_start_date AND created_at < p_end_date
  ),
  refunds AS (
    SELECT pr.id, pr.order_id, pr.amount, LOWER(TRIM(pt.payment_method)) as method, pr.updated_at as event_date, pr.payment_id, pr.refund_id
    FROM payment_refunds pr
    JOIN payment_transactions pt ON pr.payment_transaction_id = pt.id
    WHERE pr.status = 'succeeded'
      AND pr.updated_at >= p_start_date AND pr.updated_at < p_end_date
  ),
  delivered_orders AS (
    SELECT o.id, o.tracking_number, o.sender_name, o.receiver_name, o.origin, o.destination,
           o.shipping_cost, o.discount_amount, o.amount_paid, o.payment_status,
           GREATEST(o.shipping_cost - COALESCE(o.discount_amount, 0), 0) AS final_fee,
           GREATEST(GREATEST(o.shipping_cost - COALESCE(o.discount_amount, 0), 0) - COALESCE(o.amount_paid, 0), 0) AS balance,
           (SELECT MAX(changed_at) FROM order_status_events ose WHERE ose.order_id = o.id AND ose.status = 'Delivered') as delivered_at
    FROM orders o
    WHERE o.status = 'Delivered'
      AND EXISTS (
        SELECT 1 FROM order_status_events ose 
        WHERE ose.order_id = o.id 
          AND ose.status = 'Delivered' 
          AND ose.changed_at >= p_start_date 
          AND ose.changed_at < p_end_date
      )
  ),
  gross_collected AS (
    SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE method != 'paylater'
  ),
  successful_refunds AS (
    SELECT COALESCE(SUM(amount), 0) as total FROM refunds
  ),
  delivered_value AS (
    SELECT COALESCE(SUM(final_fee), 0) as total FROM delivered_orders
  ),
  method_agg AS (
    SELECT 
      COALESCE(p.method, r.method) as method,
      COALESCE(SUM(p.amount), 0) as gross,
      COALESCE(COUNT(p.id), 0) as payment_count,
      COALESCE(SUM(r.amount), 0) as refunds,
      COALESCE(COUNT(r.id), 0) as refund_count,
      COALESCE(SUM(p.amount), 0) - COALESCE(SUM(r.amount), 0) as net
    FROM payments p
    FULL OUTER JOIN refunds r ON 1=0 -- We don't join rows, we just group by method. Actually, better to union and group.
    -- Wait, full outer join on 1=0 doesn't work for group by.
    -- Let's just do a union all approach.
  ),
  method_union AS (
    SELECT method, amount as gross, 1 as p_count, 0 as ref_amt, 0 as r_count FROM payments WHERE method != 'paylater'
    UNION ALL
    SELECT method, 0 as gross, 0 as p_count, amount as ref_amt, 1 as r_count FROM refunds
  ),
  method_totals AS (
    SELECT method, 
           SUM(gross) as gross, 
           SUM(p_count) as payment_count, 
           SUM(ref_amt) as refunds, 
           SUM(r_count) as refund_count,
           SUM(gross) - SUM(ref_amt) as net
    FROM method_union
    GROUP BY method
  ),
  daily_union AS (
    SELECT (created_at AT TIME ZONE 'Asia/Manila')::date as day, amount as gross, 0 as ref_amt 
    FROM payment_transactions 
    WHERE payment_status IN ('paid', 'partial') AND LOWER(TRIM(payment_method)) != 'paylater'
      AND created_at >= p_start_date AND created_at < p_end_date
    UNION ALL
    SELECT (updated_at AT TIME ZONE 'Asia/Manila')::date as day, 0 as gross, amount as ref_amt 
    FROM payment_refunds 
    WHERE status = 'succeeded'
      AND updated_at >= p_start_date AND updated_at < p_end_date
  ),
  daily_chart AS (
    SELECT day, SUM(gross) - SUM(ref_amt) as net
    FROM daily_union
    GROUP BY day
    ORDER BY day
  ),
  combined_details AS (
    SELECT 'payment' as type, id, order_id, amount, method, event_date, transaction_reference as ref_id
    FROM payments
    UNION ALL
    SELECT 'refund' as type, id, order_id, amount, method, event_date, refund_id as ref_id
    FROM refunds
    ORDER BY event_date DESC
  )
  SELECT jsonb_build_object(
    'grossCollected', (SELECT total FROM gross_collected),
    'successfulRefunds', (SELECT total FROM successful_refunds),
    'netCollected', (SELECT total FROM gross_collected) - (SELECT total FROM successful_refunds),
    'deliveredShipmentValue', (SELECT total FROM delivered_value),
    'methodTotals', COALESCE((SELECT jsonb_agg(to_jsonb(mt)) FROM method_totals mt), '[]'::jsonb),
    'dailyChart', COALESCE((SELECT jsonb_agg(to_jsonb(dc)) FROM daily_chart dc), '[]'::jsonb),
    'completedDeliveries', COALESCE((SELECT jsonb_agg(to_jsonb(do_rows)) FROM delivered_orders do_rows), '[]'::jsonb),
    'paymentRefundDetail', COALESCE((SELECT jsonb_agg(to_jsonb(cd)) FROM combined_details cd), '[]'::jsonb)
  ) INTO payload;

  RETURN payload;
END;
$func;
CREATE OR REPLACE FUNCTION public.get_sales_overview_data(p_year INT DEFAULT EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Manila'))
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func
DECLARE
  payload JSONB;
  v_today_start TIMESTAMPTZ;
  v_today_end TIMESTAMPTZ;
  v_month_start TIMESTAMPTZ;
  v_month_end TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  v_today_start := (now() AT TIME ZONE 'Asia/Manila')::date AT TIME ZONE 'Asia/Manila';
  v_today_end := v_today_start + interval '1 day';
  
  v_month_start := date_trunc('month', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila';
  v_month_end := v_month_start + interval '1 month';

  WITH current_unpaid AS (
    SELECT COALESCE(SUM(GREATEST(GREATEST(shipping_cost - COALESCE(discount_amount, 0), 0) - COALESCE(amount_paid, 0), 0)), 0) as total
    FROM orders
    WHERE status IN ('Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered')
  ),
  delivered_unpaid AS (
    SELECT COALESCE(SUM(GREATEST(GREATEST(shipping_cost - COALESCE(discount_amount, 0), 0) - COALESCE(amount_paid, 0), 0)), 0) as total
    FROM orders
    WHERE status = 'Delivered'
  ),
  collected_today AS (
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payment_transactions
    WHERE payment_status IN ('paid', 'partial') AND LOWER(TRIM(payment_method)) != 'paylater'
      AND created_at >= v_today_start AND created_at < v_today_end
  ),
  refunds_today AS (
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payment_refunds
    WHERE status = 'succeeded'
      AND updated_at >= v_today_start AND updated_at < v_today_end
  ),
  collected_month AS (
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payment_transactions
    WHERE payment_status IN ('paid', 'partial') AND LOWER(TRIM(payment_method)) != 'paylater'
      AND created_at >= v_month_start AND created_at < v_month_end
  ),
  refunds_month AS (
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payment_refunds
    WHERE status = 'succeeded'
      AND updated_at >= v_month_start AND updated_at < v_month_end
  ),
  monthly_payments AS (
    SELECT EXTRACT(MONTH FROM created_at AT TIME ZONE 'Asia/Manila') as mth, SUM(amount) as gross
    FROM payment_transactions
    WHERE payment_status IN ('paid', 'partial') AND LOWER(TRIM(payment_method)) != 'paylater'
      AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'Asia/Manila') = p_year
    GROUP BY 1
  ),
  monthly_refunds AS (
    SELECT EXTRACT(MONTH FROM updated_at AT TIME ZONE 'Asia/Manila') as mth, SUM(amount) as refunds
    FROM payment_refunds
    WHERE status = 'succeeded'
      AND EXTRACT(YEAR FROM updated_at AT TIME ZONE 'Asia/Manila') = p_year
    GROUP BY 1
  ),
  monthly_data AS (
    SELECT m.mth, 
           COALESCE(p.gross, 0) as gross, 
           COALESCE(r.refunds, 0) as refunds,
           COALESCE(p.gross, 0) - COALESCE(r.refunds, 0) as net
    FROM (SELECT generate_series(1, 12) as mth) m
    LEFT JOIN monthly_payments p ON p.mth = m.mth
    LEFT JOIN monthly_refunds r ON r.mth = m.mth
    ORDER BY m.mth
  )
  SELECT jsonb_build_object(
    'collectedToday', (SELECT total FROM collected_today) - (SELECT total FROM refunds_today),
    'netCollectedThisMonth', (SELECT total FROM collected_month) - (SELECT total FROM refunds_month),
    'currentUnpaidBalance', (SELECT total FROM current_unpaid),
    'deliveredButUnpaid', (SELECT total FROM delivered_unpaid),
    'monthlyChart', COALESCE((SELECT jsonb_agg(to_jsonb(md)) FROM monthly_data md), '[]'::jsonb)
  ) INTO payload;

  RETURN payload;
END;
$func;

GRANT EXECUTE ON FUNCTION public.get_financial_report_data(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_overview_data(INT) TO authenticated;