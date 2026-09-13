-- Thesis defense requirement: panelists need to see the actual admin name
-- (not "CargoExpress Staff") who recorded a payment or refund, even on the
-- customer-facing UI. Re-point get_payment_transaction_history and
-- get_payment_refund_history (introduced in
-- 20260913090000_refund_ux_privacy_recovery_hardening.sql) to always return
-- the real admin_name / initiated_by_name. All other masking in these
-- functions (transaction_reference, notes, refund_id, etc.) is unchanged.

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
      WHEN LOWER(BTRIM(COALESCE(pt.admin_name, ''))) IN
        ('system webhook', 'system', 'payment system', 'paymongo dashboard')
        THEN 'Payment System'
      ELSE pt.admin_name
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
      WHEN pr.initiated_by IS NULL THEN 'Payment System'
      ELSE COALESCE(pr.initiated_by_name, 'Payment System')
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
