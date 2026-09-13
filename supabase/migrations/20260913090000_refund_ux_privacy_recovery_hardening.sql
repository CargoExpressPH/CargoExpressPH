-- Refund UX/privacy and recovery hardening.
--
-- 1. Keep an explicit local uncertainty flag without pretending that PayMongo
--    is merely processing a request whose provider outcome is unknown.
-- 2. Separate safe customer failure copy from private operational diagnostics.
-- 3. Expose payment/refund history through audience-aware read models so a
--    customer never receives staff identity or internal provider fields.
-- 4. Preserve missed-webhook recovery with adaptive scheduling: unresolved
--    work stays fast, old payments with no refund activity become daily scans.

ALTER TABLE public.payment_refunds
  ADD COLUMN IF NOT EXISTS outcome_uncertain BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS public_failure_reason TEXT,
  ADD CONSTRAINT payment_refunds_public_failure_reason_length
    CHECK (public_failure_reason IS NULL OR char_length(public_failure_reason) <= 500);

COMMENT ON COLUMN public.payment_refunds.outcome_uncertain IS
  'True only when CargoExpress cannot establish whether PayMongo accepted the protected request. The provider lifecycle status remains processing until reconciliation.';
COMMENT ON COLUMN public.payment_refunds.public_failure_reason IS
  'Sanitized, non-technical failure copy safe for the customer who owns the order. Private diagnostics remain in last_error.';

CREATE OR REPLACE FUNCTION private.clear_refund_uncertainty_on_provider_result()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.refund_id IS NOT NULL OR NEW.status IN ('failed', 'succeeded') THEN
    NEW.outcome_uncertain := FALSE;
  END IF;
  IF NEW.status <> 'failed' THEN
    NEW.public_failure_reason := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS payment_refunds_clear_uncertainty ON public.payment_refunds;
CREATE TRIGGER payment_refunds_clear_uncertainty
BEFORE INSERT OR UPDATE OF refund_id, status ON public.payment_refunds
FOR EACH ROW EXECUTE FUNCTION private.clear_refund_uncertainty_on_provider_result();

REVOKE ALL ON FUNCTION private.clear_refund_uncertainty_on_provider_result()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mark_paymongo_refund_uncertain(
  p_idempotency_key UUID,
  p_error TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_refund public.payment_refunds%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.payment_refunds
  SET status = CASE WHEN status IN ('succeeded', 'failed') THEN status ELSE 'processing' END,
      outcome_uncertain = CASE WHEN status IN ('succeeded', 'failed') THEN FALSE ELSE TRUE END,
      last_error = CASE
        WHEN status IN ('succeeded', 'failed') THEN last_error
        ELSE LEFT(COALESCE(NULLIF(BTRIM(p_error), ''), 'Provider outcome is unknown'), 1000)
      END,
      public_failure_reason = NULL
  WHERE idempotency_key = p_idempotency_key
  RETURNING * INTO v_refund;
  RETURN CASE WHEN FOUND THEN to_jsonb(v_refund) ELSE NULL END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_paymongo_refund_failed(
  p_idempotency_key UUID,
  p_error TEXT,
  p_public_error TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_refund public.payment_refunds%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.payment_refunds
  SET status = CASE WHEN status = 'succeeded' THEN status ELSE 'failed' END,
      outcome_uncertain = FALSE,
      last_error = CASE
        WHEN status = 'succeeded' THEN last_error
        ELSE LEFT(COALESCE(NULLIF(BTRIM(p_error), ''), 'Provider rejected the refund'), 1000)
      END,
      public_failure_reason = CASE
        WHEN status = 'succeeded' THEN public_failure_reason
        ELSE LEFT(COALESCE(NULLIF(BTRIM(p_public_error), ''),
          'PayMongo could not complete the refund. No refund amount was deducted from the order’s collected total.'), 500)
      END
  WHERE idempotency_key = p_idempotency_key
  RETURNING * INTO v_refund;
  RETURN CASE WHEN FOUND THEN to_jsonb(v_refund) ELSE NULL END;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_paymongo_refund_uncertain(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_paymongo_refund_failed(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_paymongo_refund_uncertain(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_paymongo_refund_failed(UUID, TEXT, TEXT) TO service_role;

-- Audience-aware ledger reads. Customers get the financial facts they need,
-- generic staff/system attribution, no internal PayMongo identifier, and no
-- free-form staff notes. Admins retain the complete operational presentation.
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

-- Direct SELECT returned admin_name, initiated_by_name, and private last_error
-- to customer JWTs. All authenticated reads now pass through the functions
-- above; Edge Functions retain service-role access.
REVOKE SELECT ON TABLE public.payment_transactions FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON TABLE public.payment_refunds FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.payment_transactions TO service_role;
GRANT SELECT ON TABLE public.payment_refunds TO service_role;

ALTER TABLE private.paymongo_refund_recovery_jobs
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

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
    ELSE
      v_next_delay := CASE
        WHEN v_payment_created_at >= NOW() - INTERVAL '1 day' THEN INTERVAL '30 minutes'
        WHEN v_payment_created_at >= NOW() - INTERVAL '7 days' THEN INTERVAL '6 hours'
        ELSE INTERVAL '24 hours'
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

CREATE OR REPLACE FUNCTION public.get_paymongo_refund_recovery_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'activeJobs', COUNT(*) FILTER (WHERE j.status = 'active'),
    'completedJobs', COUNT(*) FILTER (WHERE j.status = 'completed'),
    'dueJobs', COUNT(*) FILTER (WHERE j.status = 'active' AND j.next_check_at <= NOW()),
    'jobsInBackoff', COUNT(*) FILTER (WHERE j.consecutive_failures > 0),
    'failuresLast24Hours', COUNT(*) FILTER (WHERE j.last_error_at >= NOW() - INTERVAL '24 hours'),
    'oldestDueAt', MIN(j.next_check_at) FILTER (WHERE j.status = 'active' AND j.next_check_at <= NOW()),
    'lastSuccessfulScanAt', MAX(j.last_success_at),
    'lastFailureAt', MAX(j.last_error_at),
    'unresolvedRefunds', (
      SELECT COUNT(*) FROM public.payment_refunds AS pr
      WHERE pr.status IN ('creating', 'pending', 'processing')
    ),
    'uncertainRefunds', (
      SELECT COUNT(*) FROM public.payment_refunds AS pr WHERE pr.outcome_uncertain
    ),
    'recentFailureDiagnostics', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'at', recent.last_error_at,
        'diagnostic', recent.last_error,
        'consecutiveFailures', recent.consecutive_failures
      ) ORDER BY recent.last_error_at DESC)
      FROM (
        SELECT last_error_at, last_error, consecutive_failures
        FROM private.paymongo_refund_recovery_jobs
        WHERE last_error_at IS NOT NULL
        ORDER BY last_error_at DESC
        LIMIT 10
      ) AS recent
    ), '[]'::JSONB)
  ) INTO v_result
  FROM private.paymongo_refund_recovery_jobs AS j;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_paymongo_refund_recovery_health()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_paymongo_refund_recovery_health() TO service_role;
