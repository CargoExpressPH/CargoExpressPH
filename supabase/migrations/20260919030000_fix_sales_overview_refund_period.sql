-- Fix refund period bucketing in get_sales_overview_data()
-- Aligning it with the fix made in get_financial_report_data() in migration 20260918010000.
-- Replaces raw updated_at with COALESCE(succeeded_at, provider_updated_at, updated_at).

CREATE OR REPLACE FUNCTION public.get_sales_overview_data(p_year INT DEFAULT EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Manila'))
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      AND COALESCE(succeeded_at, provider_updated_at, updated_at) >= v_today_start 
      AND COALESCE(succeeded_at, provider_updated_at, updated_at) < v_today_end
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
      AND COALESCE(succeeded_at, provider_updated_at, updated_at) >= v_month_start 
      AND COALESCE(succeeded_at, provider_updated_at, updated_at) < v_month_end
  ),
  monthly_payments AS (
    SELECT EXTRACT(MONTH FROM created_at AT TIME ZONE 'Asia/Manila') as mth, SUM(amount) as gross
    FROM payment_transactions
    WHERE payment_status IN ('paid', 'partial') AND LOWER(TRIM(payment_method)) != 'paylater'
      AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'Asia/Manila') = p_year
    GROUP BY 1
  ),
  monthly_refunds AS (
    SELECT EXTRACT(MONTH FROM COALESCE(succeeded_at, provider_updated_at, updated_at) AT TIME ZONE 'Asia/Manila') as mth, SUM(amount) as refunds
    FROM payment_refunds
    WHERE status = 'succeeded'
      AND EXTRACT(YEAR FROM COALESCE(succeeded_at, provider_updated_at, updated_at) AT TIME ZONE 'Asia/Manila') = p_year
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
$$;
