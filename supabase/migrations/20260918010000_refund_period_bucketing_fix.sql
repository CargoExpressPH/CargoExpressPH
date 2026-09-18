-- Fix: period-based financial reports bucketed a successful refund by
-- payment_refunds.updated_at, which is not fixed at the moment the refund
-- actually succeeded. `payment_refunds_set_updated_at` (BEFORE UPDATE)
-- bumps updated_at on ANY update to the row, including a no-op touch such
-- as mark_paymongo_refund_uncertain() re-running against an already-
-- `succeeded` row during a delayed/duplicate webhook retry (it leaves
-- status/outcome_uncertain unchanged for a succeeded row but the UPDATE
-- statement still runs, so updated_at still moves). That silently moves a
-- historical refund into whatever reporting period the retry happened to
-- land in, even though nothing about the refund's outcome changed.
--
-- Fix: add `succeeded_at`, set once (COALESCE-guarded, so it is written the
-- first time a refund reaches 'succeeded' and never touched again), and use
-- it instead of `updated_at` for period bucketing.
BEGIN;

ALTER TABLE public.payment_refunds
  ADD COLUMN IF NOT EXISTS succeeded_at TIMESTAMPTZ;

-- Backfill existing succeeded rows. provider_updated_at (PayMongo's own
-- event timestamp, monotonic-guarded on write) is the best available proxy
-- for the true success moment; updated_at is the last-resort fallback for
-- any row where a provider timestamp was never recorded.
UPDATE public.payment_refunds
SET succeeded_at = COALESCE(provider_updated_at, updated_at)
WHERE status = 'succeeded'
  AND succeeded_at IS NULL;

CREATE OR REPLACE FUNCTION public.reconcile_paymongo_refund(
  p_refund_id TEXT,
  p_payment_id TEXT,
  p_amount NUMERIC,
  p_status TEXT,
  p_reason TEXT DEFAULT 'others',
  p_notes TEXT DEFAULT NULL,
  p_livemode BOOLEAN DEFAULT NULL,
  p_event_id TEXT DEFAULT NULL,
  p_provider_created_at TIMESTAMPTZ DEFAULT NULL,
  p_provider_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_idempotency_key UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_payment public.payment_transactions%ROWTYPE;
  v_refund public.payment_refunds%ROWTYPE;
  v_amount NUMERIC(10,2);
  v_status TEXT;
  v_reason TEXT;
  v_other_succeeded NUMERIC(10,2);
BEGIN
  v_amount := ROUND(COALESCE(p_amount, 0), 2);
  v_status := LOWER(BTRIM(COALESCE(p_status, '')));
  v_reason := LOWER(BTRIM(COALESCE(p_reason, 'others')));

  IF p_refund_id IS NULL OR p_refund_id !~ '^ref_[A-Za-z0-9_-]{4,128}$'
     OR p_payment_id IS NULL OR p_payment_id !~ '^pay_[A-Za-z0-9_-]{4,128}$'
     OR v_amount <= 0
     OR v_status NOT IN ('pending', 'processing', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'Invalid PayMongo refund resource' USING ERRCODE = '22023';
  END IF;
  IF v_reason NOT IN ('duplicate', 'fraudulent', 'requested_by_customer', 'others') THEN
    v_reason := 'others';
  END IF;

  SELECT * INTO v_payment
  FROM public.payment_transactions
  WHERE transaction_reference = p_payment_id
    AND payment_method = 'gcash'
    AND gcash_channel = 'paymongo'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'linked', FALSE,
      'refund_id', p_refund_id,
      'message', 'Original PayMongo payment ledger row was not found'
    );
  END IF;

  SELECT * INTO v_refund
  FROM public.payment_refunds
  WHERE refund_id = p_refund_id
  FOR UPDATE;

  IF NOT FOUND AND p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_refund
    FROM public.payment_refunds
    WHERE idempotency_key = p_idempotency_key
    FOR UPDATE;
  END IF;

  -- A signed webhook does not carry our local idempotency key. If the Edge
  -- Function timed out after PayMongo accepted the request, attach that
  -- webhook to the recent unresolved reservation instead of creating an
  -- orphaned second row.
  IF NOT FOUND AND p_idempotency_key IS NULL THEN
    SELECT * INTO v_refund
    FROM public.payment_refunds
    WHERE payment_transaction_id = v_payment.id
      AND refund_id IS NULL
      AND amount = v_amount
      AND reason = v_reason
      AND status IN ('creating', 'processing')
      AND created_at >= NOW() - INTERVAL '24 hours'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF FOUND THEN
    IF v_refund.payment_transaction_id <> v_payment.id OR v_refund.amount <> v_amount THEN
      RAISE EXCEPTION 'Refund identity conflicts with its original payment'
        USING ERRCODE = '23505';
    END IF;

    -- A completed refund is terminal. Ignore older or lower-state deliveries.
    IF v_refund.status = 'succeeded' AND v_status <> 'succeeded' THEN
      RETURN to_jsonb(v_refund) || jsonb_build_object('linked', TRUE, 'changed', FALSE);
    END IF;
    IF v_refund.provider_updated_at IS NOT NULL
       AND p_provider_updated_at IS NOT NULL
       AND p_provider_updated_at < v_refund.provider_updated_at THEN
      RETURN to_jsonb(v_refund) || jsonb_build_object('linked', TRUE, 'changed', FALSE);
    END IF;
  END IF;

  IF v_status = 'succeeded' THEN
    SELECT COALESCE(SUM(pr.amount), 0) INTO v_other_succeeded
    FROM public.payment_refunds pr
    WHERE pr.payment_transaction_id = v_payment.id
      AND pr.status = 'succeeded'
      AND (v_refund.id IS NULL OR pr.id <> v_refund.id);

    IF v_other_succeeded + v_amount > v_payment.amount + 0.005 THEN
      RAISE EXCEPTION 'Successful refunds exceed the original payment amount'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_refund.id IS NULL THEN
    INSERT INTO public.payment_refunds (
      refund_id, idempotency_key, payment_transaction_id, order_id, payment_id,
      amount, status, reason, notes, livemode, last_event_id,
      provider_created_at, provider_updated_at, succeeded_at
    ) VALUES (
      p_refund_id, p_idempotency_key, v_payment.id, v_payment.order_id, p_payment_id,
      v_amount, v_status, v_reason, NULLIF(BTRIM(p_notes), ''), p_livemode, p_event_id,
      p_provider_created_at, p_provider_updated_at,
      CASE WHEN v_status = 'succeeded' THEN COALESCE(p_provider_updated_at, NOW()) ELSE NULL END
    ) RETURNING * INTO v_refund;
  ELSE
    UPDATE public.payment_refunds
    SET refund_id = COALESCE(refund_id, p_refund_id),
        payment_id = p_payment_id,
        status = v_status,
        reason = v_reason,
        notes = COALESCE(NULLIF(BTRIM(p_notes), ''), notes),
        livemode = COALESCE(p_livemode, livemode),
        last_event_id = COALESCE(p_event_id, last_event_id),
        last_error = CASE WHEN v_status = 'failed' THEN last_error ELSE NULL END,
        provider_created_at = COALESCE(p_provider_created_at, provider_created_at),
        provider_updated_at = COALESCE(p_provider_updated_at, provider_updated_at),
        -- Set once. A refund that is already succeeded keeps its original
        -- succeeded_at even if this function runs again for it (terminal
        -- guards above already return early for that case, but this COALESCE
        -- is the belt-and-suspenders: succeeded_at, once non-null, never moves).
        succeeded_at = CASE
          WHEN v_status = 'succeeded' THEN COALESCE(succeeded_at, p_provider_updated_at, NOW())
          ELSE succeeded_at
        END
    WHERE id = v_refund.id
    RETURNING * INTO v_refund;
  END IF;

  RETURN to_jsonb(v_refund) || jsonb_build_object('linked', TRUE, 'changed', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_paymongo_refund(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_refund(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO service_role;

-- Period-based financial report: bucket refunds by succeeded_at (fixed at
-- success time) instead of updated_at (which can drift on a later no-op
-- touch). COALESCE keeps this safe for any row somehow missing succeeded_at.
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
    SELECT pr.id, pr.order_id, pr.amount, LOWER(TRIM(pt.payment_method)) as method,
           COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) as event_date,
           pr.payment_id, pr.refund_id
    FROM payment_refunds pr
    JOIN payment_transactions pt ON pr.payment_transaction_id = pt.id
    WHERE pr.status = 'succeeded'
      AND COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) >= p_start_date
      AND COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) < p_end_date
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
    SELECT (COALESCE(succeeded_at, provider_updated_at, updated_at) AT TIME ZONE 'Asia/Manila')::date as day, 0 as gross, amount as ref_amt
    FROM payment_refunds
    WHERE status = 'succeeded'
      AND COALESCE(succeeded_at, provider_updated_at, updated_at) >= p_start_date
      AND COALESCE(succeeded_at, provider_updated_at, updated_at) < p_end_date
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
