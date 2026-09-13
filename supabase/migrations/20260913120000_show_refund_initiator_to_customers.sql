-- Show the initiating administrator's recorded name on customer-visible
-- refund entries for transparency. Keep internal identifiers, provider fields,
-- and notes restricted to administrators.

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
      ELSE COALESCE(NULLIF(BTRIM(pr.initiated_by_name), ''), 'CargoExpress Staff')
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

REVOKE ALL ON FUNCTION public.get_payment_refund_history(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payment_refund_history(UUID[]) TO authenticated;
