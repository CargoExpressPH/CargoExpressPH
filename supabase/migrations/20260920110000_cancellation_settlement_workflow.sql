-- Cancellation financial settlement is deliberately separate from shipment
-- cancellation and from the payment/refund ledgers. A decision classifies
-- money already retained; it never creates a charge, payment, or refund.

BEGIN;

CREATE TABLE public.cancellation_settlements (
  order_id UUID PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('full_refund', 'retained_fee')),
  agreed_retained_amount NUMERIC(10,2) NOT NULL CHECK (agreed_retained_amount >= 0),
  customer_agreement_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  customer_agreement_confirmed_at TIMESTAMPTZ,
  internal_notes TEXT CHECK (internal_notes IS NULL OR char_length(internal_notes) <= 1000),
  decided_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_idempotency_key UUID NOT NULL UNIQUE,
  CONSTRAINT cancellation_settlement_decision_shape CHECK (
    (decision_type = 'full_refund'
      AND agreed_retained_amount = 0
      AND customer_agreement_confirmed = FALSE
      AND customer_agreement_confirmed_at IS NULL)
    OR
    (decision_type = 'retained_fee'
      AND agreed_retained_amount > 0
      AND customer_agreement_confirmed = TRUE
      AND customer_agreement_confirmed_at IS NOT NULL)
  )
);

-- This is the durable audit source. It intentionally has no cascading order
-- FK: deleting an operational order must not erase the old/new money decision.
CREATE TABLE public.cancellation_settlement_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  tracking_number TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('recorded', 'amended')),
  old_decision JSONB,
  new_decision JSONB NOT NULL,
  changed_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  changed_by_name TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key UUID NOT NULL UNIQUE
);

CREATE INDEX cancellation_settlement_history_order_time_idx
  ON public.cancellation_settlement_history(order_id, changed_at DESC);

ALTER TABLE public.cancellation_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cancellation_settlement_history ENABLE ROW LEVEL SECURITY;

-- No direct authenticated table access: customer reads must redact notes and
-- writes must pass through the locking/validation RPCs below.
REVOKE ALL ON public.cancellation_settlements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cancellation_settlement_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cancellation_settlements TO service_role;
GRANT ALL ON public.cancellation_settlement_history TO service_role;

CREATE OR REPLACE FUNCTION public.get_cancellation_settlement_summary(p_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_decision public.cancellation_settlements%ROWTYPE;
  v_is_admin BOOLEAN;
  v_gross NUMERIC(10,2);
  v_succeeded NUMERIC(10,2);
  v_pending NUMERIC(10,2);
  v_net NUMERIC(10,2);
  v_final_charge NUMERIC(10,2);
  v_fee NUMERIC(10,2);
  v_due NUMERIC(10,2);
  v_available NUMERIC(10,2);
  v_invalid BOOLEAN := FALSE;
  v_state TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0002';
  END IF;

  v_is_admin := public.is_admin();
  IF NOT v_is_admin AND v_order.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not allowed to view this settlement' USING ERRCODE = '42501';
  END IF;
  IF v_order.status <> 'Cancelled' THEN
    RAISE EXCEPTION 'Cancellation settlement is available only for cancelled bookings'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_gross
  FROM public.payment_transactions
  WHERE order_id = p_order_id AND payment_status IN ('paid', 'partial');

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0),
    COALESCE(SUM(amount) FILTER (
      WHERE status IN ('creating', 'pending', 'processing')
         OR (COALESCE(outcome_uncertain, FALSE) AND status NOT IN ('succeeded', 'failed'))
    ), 0)
  INTO v_succeeded, v_pending
  FROM public.payment_refunds
  WHERE order_id = p_order_id;

  SELECT * INTO v_decision
  FROM public.cancellation_settlements
  WHERE order_id = p_order_id;

  v_final_charge := public.order_payable_amount(v_order.shipping_cost, v_order.discount_amount);
  v_net := v_gross - v_succeeded;

  IF FOUND THEN
    v_fee := v_decision.agreed_retained_amount;
    v_due := v_gross - v_succeeded - v_fee;
    v_available := v_gross - v_succeeded - v_pending - v_fee;
    v_invalid := v_gross < 0
      OR v_succeeded < 0
      OR v_pending < 0
      OR v_succeeded > v_gross + 0.005
      OR v_succeeded + v_pending > v_gross + 0.005
      OR v_fee < 0
      OR v_fee > LEAST(v_gross, v_final_charge) + 0.005
      OR v_succeeded + v_pending + v_fee > v_gross + 0.005
      OR v_due < -0.005
      OR v_available < -0.005;

    IF v_invalid THEN
      v_state := 'needs_reconciliation';
    ELSIF v_due > 0.005 AND v_pending > 0.005 THEN
      v_state := 'refund_pending';
    ELSIF v_due > 0.005 THEN
      v_state := 'refund_due';
    ELSE
      v_state := 'refund_settled';
    END IF;
  ELSE
    v_fee := NULL;
    v_due := NULL;
    v_available := NULL;
    v_invalid := v_gross < 0 OR v_succeeded < 0 OR v_pending < 0
      OR v_succeeded > v_gross + 0.005
      OR v_succeeded + v_pending > v_gross + 0.005;
    v_state := CASE WHEN v_invalid THEN 'needs_reconciliation' ELSE 'for_review' END;
  END IF;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'booking_status', v_order.status,
    'historical_final_charge', v_final_charge,
    'gross_collected', v_gross,
    'successful_refunds', v_succeeded,
    'net_retained', v_net,
    'refund_in_progress', v_pending,
    'refund_still_due', v_due,
    'refund_not_initiated', v_available,
    'settlement_status', v_state,
    'has_confirmed_decision', v_decision.order_id IS NOT NULL,
    'decision_type', v_decision.decision_type,
    'agreed_cancellation_fee', v_fee,
    'customer_agreement_confirmed', COALESCE(v_decision.customer_agreement_confirmed, FALSE),
    'decided_at', v_decision.decided_at,
    'decided_by', CASE WHEN v_is_admin THEN v_decision.decided_by ELSE NULL END,
    'internal_notes', CASE WHEN v_is_admin THEN v_decision.internal_notes ELSE NULL END,
    'version', v_decision.version,
    'invariants_valid', NOT v_invalid
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_cancellation_settlement_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cancellation_settlement_summary(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_cancellation_settlement_decision(
  p_order_id UUID,
  p_decision_type TEXT,
  p_agreed_retained_amount NUMERIC,
  p_customer_agreement_confirmed BOOLEAN,
  p_internal_notes TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_existing_history public.cancellation_settlement_history%ROWTYPE;
  v_decision public.cancellation_settlements%ROWTYPE;
  v_admin_id UUID := auth.uid();
  v_admin_name TEXT;
  v_type TEXT := LOWER(BTRIM(COALESCE(p_decision_type, '')));
  v_fee NUMERIC(10,2) := ROUND(COALESCE(p_agreed_retained_amount, 0), 2);
  v_notes TEXT := NULLIF(BTRIM(p_internal_notes), '');
  v_gross NUMERIC(10,2);
  v_succeeded NUMERIC(10,2);
  v_pending NUMERIC(10,2);
  v_final_charge NUMERIC(10,2);
BEGIN
  IF v_admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  IF p_order_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Order and idempotency key are required' USING ERRCODE = '22023';
  END IF;
  IF v_type NOT IN ('full_refund', 'retained_fee') THEN
    RAISE EXCEPTION 'Decision must be full_refund or retained_fee' USING ERRCODE = '22023';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 1000 THEN
    RAISE EXCEPTION 'Internal notes must be 1000 characters or fewer' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0002'; END IF;
  IF v_order.status <> 'Cancelled' THEN
    RAISE EXCEPTION 'Only a cancelled booking can receive a cancellation settlement decision'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing_history
  FROM public.cancellation_settlement_history
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing_history.order_id <> p_order_id
       OR v_existing_history.action <> 'recorded'
       OR v_existing_history.new_decision->>'decision_type' <> v_type
       OR (v_existing_history.new_decision->>'agreed_retained_amount')::numeric <> v_fee THEN
      RAISE EXCEPTION 'Idempotency key was already used for another settlement action'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.get_cancellation_settlement_summary(p_order_id);
  END IF;

  IF EXISTS (SELECT 1 FROM public.cancellation_settlements WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'A settlement decision already exists; use the explicit amendment action'
      USING ERRCODE = '23505';
  END IF;

  IF v_type = 'full_refund' THEN
    IF v_fee <> 0 OR COALESCE(p_customer_agreement_confirmed, FALSE) THEN
      RAISE EXCEPTION 'A full-refund decision must retain zero and does not record a fee agreement'
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_fee <= 0 OR NOT COALESCE(p_customer_agreement_confirmed, FALSE) THEN
    RAISE EXCEPTION 'A retained fee must be positive and the admin must confirm the customer agreement'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_gross
  FROM public.payment_transactions
  WHERE order_id = p_order_id AND payment_status IN ('paid', 'partial');
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0),
    COALESCE(SUM(amount) FILTER (
      WHERE status IN ('creating', 'pending', 'processing')
         OR (COALESCE(outcome_uncertain, FALSE) AND status NOT IN ('succeeded', 'failed'))
    ), 0)
  INTO v_succeeded, v_pending
  FROM public.payment_refunds WHERE order_id = p_order_id;
  v_final_charge := public.order_payable_amount(v_order.shipping_cost, v_order.discount_amount);

  IF v_succeeded > v_gross + 0.005 OR v_succeeded + v_pending > v_gross + 0.005 THEN
    RAISE EXCEPTION 'Existing payment/refund records need reconciliation before a decision can be recorded'
      USING ERRCODE = '22023';
  END IF;
  IF v_fee > LEAST(v_gross, v_final_charge) + 0.005 THEN
    RAISE EXCEPTION 'Agreed fee exceeds retained collections or the historical final charge'
      USING ERRCODE = '22023';
  END IF;
  IF v_succeeded + v_pending + v_fee > v_gross + 0.005 THEN
    RAISE EXCEPTION 'Successful refunds, active refunds, and agreed fee exceed successful collections'
      USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_admin_name FROM public.profiles WHERE id = v_admin_id AND role = 'admin';

  INSERT INTO public.cancellation_settlements (
    order_id, decision_type, agreed_retained_amount,
    customer_agreement_confirmed, customer_agreement_confirmed_at,
    internal_notes, decided_by, decided_at, updated_at, version, last_idempotency_key
  ) VALUES (
    p_order_id, v_type, v_fee,
    COALESCE(p_customer_agreement_confirmed, FALSE),
    CASE WHEN v_type = 'retained_fee' THEN NOW() ELSE NULL END,
    v_notes, v_admin_id, NOW(), NOW(), 1, p_idempotency_key
  ) RETURNING * INTO v_decision;

  INSERT INTO public.cancellation_settlement_history (
    order_id, tracking_number, action, old_decision, new_decision,
    changed_by, changed_by_name, idempotency_key
  ) VALUES (
    p_order_id, v_order.tracking_number, 'recorded', NULL, to_jsonb(v_decision),
    v_admin_id, COALESCE(v_admin_name, 'Unknown Admin'), p_idempotency_key
  );

  INSERT INTO public.activity_logs (
    admin_id, admin_name, module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  ) VALUES (
    v_admin_id, COALESCE(v_admin_name, 'Unknown Admin'), 'Payments',
    'Cancellation Settlement Recorded', 'order', p_order_id, v_order.tracking_number,
    NULL,
    jsonb_build_object('decision_type', v_type, 'agreed_retained_amount', v_fee),
    'Recorded a cancellation financial decision. This action did not send money or create a payment/refund.'
  );

  RETURN public.get_cancellation_settlement_summary(p_order_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.amend_cancellation_settlement_decision(
  p_order_id UUID,
  p_decision_type TEXT,
  p_agreed_retained_amount NUMERIC,
  p_customer_agreement_confirmed BOOLEAN,
  p_internal_notes TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_old public.cancellation_settlements%ROWTYPE;
  v_new public.cancellation_settlements%ROWTYPE;
  v_existing_history public.cancellation_settlement_history%ROWTYPE;
  v_admin_id UUID := auth.uid();
  v_admin_name TEXT;
  v_type TEXT := LOWER(BTRIM(COALESCE(p_decision_type, '')));
  v_fee NUMERIC(10,2) := ROUND(COALESCE(p_agreed_retained_amount, 0), 2);
  v_notes TEXT := NULLIF(BTRIM(p_internal_notes), '');
  v_gross NUMERIC(10,2);
  v_succeeded NUMERIC(10,2);
  v_pending NUMERIC(10,2);
  v_final_charge NUMERIC(10,2);
BEGIN
  IF v_admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  IF p_order_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Order and idempotency key are required' USING ERRCODE = '22023';
  END IF;
  IF v_type NOT IN ('full_refund', 'retained_fee') THEN
    RAISE EXCEPTION 'Decision must be full_refund or retained_fee' USING ERRCODE = '22023';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 1000 THEN
    RAISE EXCEPTION 'Internal notes must be 1000 characters or fewer' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0002'; END IF;
  IF v_order.status <> 'Cancelled' THEN
    RAISE EXCEPTION 'Only a cancelled booking can have a settlement decision amended'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing_history
  FROM public.cancellation_settlement_history
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing_history.order_id <> p_order_id OR v_existing_history.action <> 'amended' THEN
      RAISE EXCEPTION 'Idempotency key was already used for another settlement action'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.get_cancellation_settlement_summary(p_order_id);
  END IF;

  SELECT * INTO v_old FROM public.cancellation_settlements
  WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No settlement decision exists; use the record action first'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0),
    COALESCE(SUM(amount) FILTER (
      WHERE status IN ('creating', 'pending', 'processing')
         OR (COALESCE(outcome_uncertain, FALSE) AND status NOT IN ('succeeded', 'failed'))
    ), 0)
  INTO v_succeeded, v_pending
  FROM public.payment_refunds WHERE order_id = p_order_id;
  IF v_pending > 0.005 THEN
    RAISE EXCEPTION 'Settlement decisions cannot be amended while a refund is pending or awaiting confirmation'
      USING ERRCODE = '55000';
  END IF;

  IF v_type = 'full_refund' THEN
    IF v_fee <> 0 OR COALESCE(p_customer_agreement_confirmed, FALSE) THEN
      RAISE EXCEPTION 'A full-refund decision must retain zero and does not record a fee agreement'
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_fee <= 0 OR NOT COALESCE(p_customer_agreement_confirmed, FALSE) THEN
    RAISE EXCEPTION 'A retained fee must be positive and the admin must confirm the customer agreement'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_gross
  FROM public.payment_transactions
  WHERE order_id = p_order_id AND payment_status IN ('paid', 'partial');
  v_final_charge := public.order_payable_amount(v_order.shipping_cost, v_order.discount_amount);
  IF v_succeeded > v_gross + 0.005
     OR v_fee > LEAST(v_gross, v_final_charge) + 0.005
     OR v_succeeded + v_fee > v_gross + 0.005 THEN
    RAISE EXCEPTION 'Amended decision conflicts with successful collections/refunds'
      USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_admin_name FROM public.profiles WHERE id = v_admin_id AND role = 'admin';
  UPDATE public.cancellation_settlements
  SET decision_type = v_type,
      agreed_retained_amount = v_fee,
      customer_agreement_confirmed = COALESCE(p_customer_agreement_confirmed, FALSE),
      customer_agreement_confirmed_at = CASE WHEN v_type = 'retained_fee' THEN NOW() ELSE NULL END,
      internal_notes = v_notes,
      decided_by = v_admin_id,
      decided_at = NOW(),
      updated_at = NOW(),
      version = version + 1,
      last_idempotency_key = p_idempotency_key
  WHERE order_id = p_order_id
  RETURNING * INTO v_new;

  INSERT INTO public.cancellation_settlement_history (
    order_id, tracking_number, action, old_decision, new_decision,
    changed_by, changed_by_name, idempotency_key
  ) VALUES (
    p_order_id, v_order.tracking_number, 'amended', to_jsonb(v_old), to_jsonb(v_new),
    v_admin_id, COALESCE(v_admin_name, 'Unknown Admin'), p_idempotency_key
  );

  INSERT INTO public.activity_logs (
    admin_id, admin_name, module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  ) VALUES (
    v_admin_id, COALESCE(v_admin_name, 'Unknown Admin'), 'Payments',
    'Cancellation Settlement Amended', 'order', p_order_id, v_order.tracking_number,
    jsonb_build_object('decision_type', v_old.decision_type, 'agreed_retained_amount', v_old.agreed_retained_amount),
    jsonb_build_object('decision_type', v_new.decision_type, 'agreed_retained_amount', v_new.agreed_retained_amount),
    'Amended a cancellation financial decision. Durable old/new values are stored in cancellation_settlement_history.'
  );

  RETURN public.get_cancellation_settlement_summary(p_order_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_cancellation_settlement_decision(UUID, TEXT, NUMERIC, BOOLEAN, TEXT, UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.amend_cancellation_settlement_decision(UUID, TEXT, NUMERIC, BOOLEAN, TEXT, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cancellation_settlement_decision(UUID, TEXT, NUMERIC, BOOLEAN, TEXT, UUID)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.amend_cancellation_settlement_decision(UUID, TEXT, NUMERIC, BOOLEAN, TEXT, UUID)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.get_cancellation_settlement_history(p_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.changed_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.cancellation_settlement_history h
  WHERE h.order_id = p_order_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_cancellation_settlement_history(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cancellation_settlement_history(UUID) TO authenticated;

-- Assumes the caller already holds the parent order row lock. Undecided
-- cancelled bookings intentionally retain the existing refund workflow.
CREATE OR REPLACE FUNCTION public.assert_cancellation_refund_capacity(
  p_order_id UUID,
  p_new_refund_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_fee NUMERIC(10,2);
  v_gross NUMERIC(10,2);
  v_succeeded NUMERIC(10,2);
  v_pending NUMERIC(10,2);
  v_amount NUMERIC(10,2) := ROUND(COALESCE(p_new_refund_amount, 0), 2);
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero' USING ERRCODE = '22023';
  END IF;

  SELECT agreed_retained_amount INTO v_fee
  FROM public.cancellation_settlements
  WHERE order_id = p_order_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_gross
  FROM public.payment_transactions
  WHERE order_id = p_order_id AND payment_status IN ('paid', 'partial');
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0),
    COALESCE(SUM(amount) FILTER (
      WHERE status IN ('creating', 'pending', 'processing')
         OR (COALESCE(outcome_uncertain, FALSE) AND status NOT IN ('succeeded', 'failed'))
    ), 0)
  INTO v_succeeded, v_pending
  FROM public.payment_refunds WHERE order_id = p_order_id;

  IF v_succeeded > v_gross + 0.005
     OR v_succeeded + v_pending + v_fee > v_gross + 0.005 THEN
    RAISE EXCEPTION 'Cancellation settlement needs reconciliation before another refund'
      USING ERRCODE = '22023';
  END IF;
  IF v_succeeded + v_pending + v_fee + v_amount > v_gross + 0.005 THEN
    RAISE EXCEPTION 'Refund exceeds the amount available after the agreed cancellation fee'
      USING ERRCODE = '22023';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_cancellation_refund_capacity(UUID, NUMERIC)
  FROM PUBLIC, anon, authenticated, service_role;

-- Wrap the existing, battle-tested provider/manual functions instead of
-- copying their password, provider, reference, idempotency, and per-payment
-- protections. New requests take locks in one order: parent order, then the
-- original payment inside the old implementation.
ALTER FUNCTION public.prepare_paymongo_refund(UUID, NUMERIC, TEXT, TEXT, UUID, UUID)
  RENAME TO prepare_paymongo_refund_without_settlement_guard;
REVOKE ALL ON FUNCTION public.prepare_paymongo_refund_without_settlement_guard(UUID, NUMERIC, TEXT, TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prepare_paymongo_refund(
  p_payment_transaction_id UUID,
  p_amount NUMERIC,
  p_reason TEXT,
  p_notes TEXT,
  p_idempotency_key UUID,
  p_initiated_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order_id UUID;
  v_existing public.payment_refunds%ROWTYPE;
BEGIN
  SELECT * INTO v_existing FROM public.payment_refunds
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN public.prepare_paymongo_refund_without_settlement_guard(
      p_payment_transaction_id, p_amount, p_reason, p_notes, p_idempotency_key, p_initiated_by
    );
  END IF;

  SELECT order_id INTO v_order_id FROM public.payment_transactions
  WHERE id = p_payment_transaction_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original payment was not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.orders WHERE id = v_order_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.payment_refunds
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    RETURN public.prepare_paymongo_refund_without_settlement_guard(
      p_payment_transaction_id, p_amount, p_reason, p_notes, p_idempotency_key, p_initiated_by
    );
  END IF;

  PERFORM public.assert_cancellation_refund_capacity(v_order_id, p_amount);
  RETURN public.prepare_paymongo_refund_without_settlement_guard(
    p_payment_transaction_id, p_amount, p_reason, p_notes, p_idempotency_key, p_initiated_by
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prepare_paymongo_refund(UUID, NUMERIC, TEXT, TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_paymongo_refund(UUID, NUMERIC, TEXT, TEXT, UUID, UUID)
  TO service_role;

ALTER FUNCTION public.record_manual_refund(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, UUID)
  RENAME TO record_manual_refund_without_settlement_guard;
REVOKE ALL ON FUNCTION public.record_manual_refund_without_settlement_guard(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_manual_refund(
  p_payment_transaction_id UUID,
  p_amount NUMERIC,
  p_reason TEXT,
  p_notes TEXT,
  p_return_method TEXT,
  p_return_reference TEXT,
  p_returned_at TIMESTAMPTZ,
  p_idempotency_key UUID,
  p_admin_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order_id UUID;
  v_existing public.payment_refunds%ROWTYPE;
BEGIN
  SELECT * INTO v_existing FROM public.payment_refunds
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN public.record_manual_refund_without_settlement_guard(
      p_payment_transaction_id, p_amount, p_reason, p_notes, p_return_method,
      p_return_reference, p_returned_at, p_idempotency_key, p_admin_id
    );
  END IF;

  SELECT order_id INTO v_order_id FROM public.payment_transactions
  WHERE id = p_payment_transaction_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original payment was not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.orders WHERE id = v_order_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.payment_refunds
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    RETURN public.record_manual_refund_without_settlement_guard(
      p_payment_transaction_id, p_amount, p_reason, p_notes, p_return_method,
      p_return_reference, p_returned_at, p_idempotency_key, p_admin_id
    );
  END IF;

  PERFORM public.assert_cancellation_refund_capacity(v_order_id, p_amount);
  RETURN public.record_manual_refund_without_settlement_guard(
    p_payment_transaction_id, p_amount, p_reason, p_notes, p_return_method,
    p_return_reference, p_returned_at, p_idempotency_key, p_admin_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_manual_refund(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_refund(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, UUID)
  TO service_role;

COMMIT;
