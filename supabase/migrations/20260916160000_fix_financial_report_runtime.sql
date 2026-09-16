-- Forward fix for the 20260916140000 report RPC. PL/pgSQL defers planning
-- its SQL body until invocation, so the unused invalid aggregate CTE passed
-- CREATE FUNCTION but made every report call fail.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_financial_report_data(p_start_date TIMESTAMPTZ, p_end_date TIMESTAMPTZ)
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
$$;

REVOKE ALL ON FUNCTION public.get_financial_report_data(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_financial_report_data(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

COMMIT;
