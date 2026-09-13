-- Restore customer payment privacy after 20260913100000 and reduce provider
-- polling for payments that have no unresolved refund work.

CREATE OR REPLACE FUNCTION public.get_payment_transaction_history(p_order_ids UUID[])
RETURNS TABLE(
  id UUID,
  order_id UUID,
  amount NUMERIC,
  payment_method TEXT,
  transaction_reference TEXT,
  payment_status TEXT,
  admin_id UUID,
  admin_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ,
  payment_type TEXT,
  payment_date DATE,
  receipt_url TEXT,
  idempotency_key UUID,
  gcash_channel TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_order_ids IS NULL OR cardinality(p_order_ids) = 0 THEN RETURN; END IF;
  IF cardinality(p_order_ids) > 100 THEN
    RAISE EXCEPTION 'At most 100 order ids may be requested' USING ERRCODE = '22023';
  END IF;
  v_is_admin := public.is_admin();

  RETURN QUERY
  SELECT
    pt.id,
    pt.order_id,
    pt.amount,
    pt.payment_method,
    CASE
      WHEN v_is_admin THEN pt.transaction_reference
      WHEN pt.transaction_reference ~* '^(pay_|ref_|src_|link_|paym_|pi_|re_|sub_|cus_|evt_)' THEN NULL
      ELSE pt.transaction_reference
    END,
    pt.payment_status,
    CASE WHEN v_is_admin THEN pt.admin_id ELSE NULL END,
    CASE
      WHEN v_is_admin THEN pt.admin_name
      WHEN LOWER(BTRIM(COALESCE(pt.admin_name, ''))) IN
        ('system webhook', 'system', 'payment system', 'paymongo dashboard')
        THEN 'Payment System'
      ELSE 'CargoExpress Staff'
    END,
    CASE WHEN v_is_admin THEN pt.notes ELSE NULL END,
    pt.created_at,
    pt.payment_type,
    pt.payment_date,
    pt.receipt_url,
    CASE WHEN v_is_admin THEN pt.idempotency_key ELSE NULL END,
    pt.gcash_channel
  FROM public.payment_transactions AS pt
  JOIN public.orders AS o ON o.id = pt.order_id
  WHERE pt.order_id = ANY(p_order_ids)
    AND (v_is_admin OR o.user_id = auth.uid())
  ORDER BY pt.created_at, pt.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_payment_refund_history(p_order_ids UUID[])
RETURNS TABLE(
  id UUID,
  refund_id TEXT,
  idempotency_key UUID,
  payment_transaction_id UUID,
  order_id UUID,
  payment_id TEXT,
  amount NUMERIC,
  currency TEXT,
  status TEXT,
  reason TEXT,
  notes TEXT,
  livemode BOOLEAN,
  initiated_by UUID,
  initiated_by_name TEXT,
  provider_created_at TIMESTAMPTZ,
  provider_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  outcome_uncertain BOOLEAN,
  public_failure_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_order_ids IS NULL OR cardinality(p_order_ids) = 0 THEN RETURN; END IF;
  IF cardinality(p_order_ids) > 100 THEN
    RAISE EXCEPTION 'At most 100 order ids may be requested' USING ERRCODE = '22023';
  END IF;
  v_is_admin := public.is_admin();

  RETURN QUERY
  SELECT
    pr.id,
    CASE WHEN v_is_admin THEN pr.refund_id ELSE NULL END,
    CASE WHEN v_is_admin THEN pr.idempotency_key ELSE NULL END,
    pr.payment_transaction_id,
    pr.order_id,
    CASE WHEN v_is_admin THEN pr.payment_id ELSE NULL END,
    pr.amount,
    pr.currency,
    pr.status,
    CASE WHEN v_is_admin THEN pr.reason ELSE 'others' END,
    CASE WHEN v_is_admin THEN pr.notes ELSE NULL END,
    CASE WHEN v_is_admin THEN pr.livemode ELSE NULL END,
    CASE WHEN v_is_admin THEN pr.initiated_by ELSE NULL END,
    CASE
      WHEN v_is_admin THEN COALESCE(pr.initiated_by_name, 'Payment System')
      WHEN pr.initiated_by IS NULL THEN 'Payment System'
      ELSE 'CargoExpress Staff'
    END,
    pr.provider_created_at,
    pr.provider_updated_at,
    pr.created_at,
    pr.updated_at,
    pr.outcome_uncertain,
    pr.public_failure_reason
  FROM public.payment_refunds AS pr
  JOIN public.orders AS o ON o.id = pr.order_id
  WHERE pr.order_id = ANY(p_order_ids)
    AND (v_is_admin OR o.user_id = auth.uid())
  ORDER BY pr.created_at, pr.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payment_transaction_history(UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_payment_refund_history(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payment_transaction_history(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_payment_refund_history(UUID[]) TO authenticated;

-- This obsolete read model came from an unrecorded deployment and is unused.
-- Removing it leaves one reviewed, audience-aware access path for each ledger.
DROP FUNCTION IF EXISTS public.get_payment_activity_history(UUID[]);

CREATE OR REPLACE FUNCTION public.finish_paymongo_refund_recovery_job(
  p_payment_transaction_id UUID,
  p_claim_token UUID,
  p_success BOOLEAN,
  p_livemode BOOLEAN,
  p_has_unresolved BOOLEAN DEFAULT FALSE,
  p_refund_count INTEGER DEFAULT 0,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_updated INTEGER;
  v_payment_created_at TIMESTAMPTZ;
  v_oldest_unresolved_at TIMESTAMPTZ;
  v_has_unlinked BOOLEAN := FALSE;
  v_next_delay INTERVAL;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_payment_transaction_id IS NULL OR p_claim_token IS NULL OR p_livemode IS NULL THEN
    RAISE EXCEPTION 'Job, claim, and PayMongo mode are required' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_success, FALSE) THEN
    SELECT pt.created_at INTO v_payment_created_at
    FROM public.payment_transactions AS pt
    WHERE pt.id = p_payment_transaction_id;

    IF COALESCE(p_has_unresolved, FALSE) THEN
      SELECT MIN(pr.created_at), BOOL_OR(pr.refund_id IS NULL)
      INTO v_oldest_unresolved_at, v_has_unlinked
      FROM public.payment_refunds AS pr
      WHERE pr.payment_transaction_id = p_payment_transaction_id
        AND pr.status IN ('creating', 'pending', 'processing');

      v_next_delay := CASE
        WHEN COALESCE(v_has_unlinked, FALSE) THEN INTERVAL '5 minutes'
        WHEN v_oldest_unresolved_at >= NOW() - INTERVAL '1 hour' THEN INTERVAL '5 minutes'
        WHEN v_oldest_unresolved_at >= NOW() - INTERVAL '24 hours' THEN INTERVAL '30 minutes'
        ELSE INTERVAL '6 hours'
      END;
    ELSIF GREATEST(COALESCE(p_refund_count, 0), 0) > 0 THEN
      v_next_delay := INTERVAL '12 hours';
    ELSE
      v_next_delay := CASE
        WHEN v_payment_created_at >= NOW() - INTERVAL '7 days' THEN INTERVAL '6 hours'
        WHEN v_payment_created_at >= NOW() - INTERVAL '30 days' THEN INTERVAL '24 hours'
        ELSE INTERVAL '72 hours'
      END;
    END IF;

    UPDATE private.paymongo_refund_recovery_jobs AS j
    SET livemode = COALESCE(j.livemode, p_livemode),
        status = CASE
          WHEN NOT COALESCE(p_has_unresolved, FALSE) AND NOW() >= j.scan_until THEN 'completed'
          ELSE 'active'
        END,
        next_check_at = CASE
          WHEN NOT COALESCE(p_has_unresolved, FALSE) AND NOW() >= j.scan_until THEN NULL
          ELSE NOW() + v_next_delay
        END,
        last_checked_at = NOW(),
        last_success_at = NOW(),
        last_refund_count = GREATEST(COALESCE(p_refund_count, 0), 0),
        consecutive_failures = 0,
        last_error = NULL,
        last_error_at = NULL,
        claim_token = NULL,
        claimed_at = NULL,
        updated_at = NOW()
    WHERE j.payment_transaction_id = p_payment_transaction_id
      AND j.claim_token = p_claim_token
      AND (j.livemode IS NULL OR j.livemode = p_livemode);
  ELSE
    UPDATE private.paymongo_refund_recovery_jobs AS j
    SET status = 'active',
        next_check_at = NOW() + make_interval(
          mins => LEAST(360, 5 * (2 ^ LEAST(j.consecutive_failures, 6))::INTEGER)
        ),
        last_checked_at = NOW(),
        consecutive_failures = j.consecutive_failures + 1,
        last_error = LEFT(
          COALESCE(NULLIF(BTRIM(p_error), ''), 'unknown_stage: Unexpected non-error failure'),
          1000
        ),
        last_error_at = NOW(),
        claim_token = NULL,
        claimed_at = NULL,
        updated_at = NOW()
    WHERE j.payment_transaction_id = p_payment_transaction_id
      AND j.claim_token = p_claim_token;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.finish_paymongo_refund_recovery_job(
  UUID, UUID, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_paymongo_refund_recovery_job(
  UUID, UUID, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, TEXT
) TO service_role;
