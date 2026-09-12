-- Some payment.failed payloads omit the nested source even though they carry
-- the Payment id. Permit the server-only reconciler to use either identifier
-- while keeping a settled attempt terminal.
CREATE OR REPLACE FUNCTION public.reconcile_paymongo_payment_failure(
  p_source_id TEXT,
  p_payment_id TEXT DEFAULT NULL,
  p_failure_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_attempt public.payment_attempts%ROWTYPE;
BEGIN
  IF p_source_id IS NOT NULL AND p_source_id !~ '^src_[A-Za-z0-9_-]{4,128}$' THEN
    RAISE EXCEPTION 'Invalid PayMongo source id' USING ERRCODE = '22023';
  END IF;
  IF p_payment_id IS NOT NULL AND p_payment_id !~ '^pay_[A-Za-z0-9_-]{4,128}$' THEN
    RAISE EXCEPTION 'Invalid PayMongo payment id' USING ERRCODE = '22023';
  END IF;
  IF p_source_id IS NULL AND p_payment_id IS NULL THEN
    RETURN jsonb_build_object('linked', FALSE, 'message', 'No provider identifier was supplied');
  END IF;

  SELECT * INTO v_attempt
  FROM public.payment_attempts
  WHERE (p_source_id IS NOT NULL AND source_id = p_source_id)
     OR (p_payment_id IS NOT NULL AND payment_id = p_payment_id)
  ORDER BY CASE WHEN source_id = p_source_id THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('linked', FALSE, 'message', 'No payment attempt found');
  END IF;
  IF v_attempt.status = 'reconciled' THEN
    RETURN jsonb_build_object('linked', TRUE, 'changed', FALSE, 'message', 'Paid attempt is already reconciled');
  END IF;

  UPDATE public.payment_attempts
  SET status = 'failed',
      payment_id = COALESCE(p_payment_id, payment_id),
      payment_status = 'failed',
      last_error = LEFT(COALESCE(NULLIF(BTRIM(p_failure_message), ''), 'PayMongo reported payment.failed'), 1000)
  WHERE id = v_attempt.id
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object(
    'linked', TRUE,
    'changed', TRUE,
    'order_id', v_attempt.order_id,
    'payment_id', v_attempt.payment_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_failure(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_failure(TEXT, TEXT, TEXT)
  TO service_role;
