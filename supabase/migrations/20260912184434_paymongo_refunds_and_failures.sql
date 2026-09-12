-- ============================================================
-- F-002: PayMongo refund and failed-payment reconciliation
--
-- Refunds are a separate, immutable provider ledger. Only a succeeded refund
-- changes an order's collected amount; creating/pending/processing/failed
-- rows remain visible for support and audit purposes without moving money.
-- All provider writes are service-role-only. Authenticated clients receive
-- read access through RLS, limited to admins or the customer who owns the
-- linked order.
-- ============================================================

-- Rows created before gcash_channel was introduced still carry the provider's
-- unmistakable pay_ identifier. Backfill them so historical PayMongo refunds
-- can be linked too; manual GCash references never use this provider prefix.
UPDATE public.payment_transactions
SET gcash_channel = 'paymongo'
WHERE payment_method = 'gcash'
  AND gcash_channel IS NULL
  AND transaction_reference ~ '^pay_[A-Za-z0-9_-]{4,128}$';

CREATE TABLE public.payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id TEXT,
  idempotency_key UUID,
  payment_transaction_id UUID NOT NULL
    REFERENCES public.payment_transactions(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'pending', 'processing', 'succeeded', 'failed')),
  reason TEXT NOT NULL
    CHECK (reason IN ('duplicate', 'fraudulent', 'requested_by_customer', 'others')),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 255),
  livemode BOOLEAN,
  initiated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  initiated_by_name TEXT,
  last_error TEXT,
  last_event_id TEXT,
  provider_created_at TIMESTAMPTZ,
  provider_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_refunds_provider_id_format
    CHECK (refund_id IS NULL OR refund_id ~ '^ref_[A-Za-z0-9_-]{4,128}$'),
  CONSTRAINT payment_refunds_payment_id_format
    CHECK (payment_id ~ '^pay_[A-Za-z0-9_-]{4,128}$')
);

CREATE UNIQUE INDEX payment_refunds_refund_id_key
  ON public.payment_refunds (refund_id) WHERE refund_id IS NOT NULL;
CREATE UNIQUE INDEX payment_refunds_idempotency_key
  ON public.payment_refunds (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX payment_refunds_order_created_idx
  ON public.payment_refunds (order_id, created_at DESC);
CREATE INDEX payment_refunds_payment_transaction_idx
  ON public.payment_refunds (payment_transaction_id);
CREATE INDEX payment_refunds_payment_status_idx
  ON public.payment_refunds (payment_id, status);

COMMENT ON TABLE public.payment_refunds IS
  'Provider refund lifecycle linked to the original PayMongo payment ledger row. Only status=succeeded reduces collected totals.';

ALTER TABLE public.payment_refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view payment refunds"
  ON public.payment_refunds FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

CREATE POLICY "Customers can view own payment refunds"
  ON public.payment_refunds FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = payment_refunds.order_id
      AND o.user_id = (SELECT auth.uid())
  ));

REVOKE ALL ON TABLE public.payment_refunds FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.payment_refunds TO authenticated;
GRANT ALL ON TABLE public.payment_refunds TO service_role;

CREATE TRIGGER payment_refunds_set_updated_at
BEFORE UPDATE ON public.payment_refunds
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Reserve an amount before talking to PayMongo. Locking the original payment
-- row serializes two admins refunding the same transaction at the same time.
CREATE OR REPLACE FUNCTION public.prepare_paymongo_refund(
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
  v_payment public.payment_transactions%ROWTYPE;
  v_existing public.payment_refunds%ROWTYPE;
  v_reserved NUMERIC(10,2);
  v_amount NUMERIC(10,2);
  v_reason TEXT;
  v_admin_name TEXT;
BEGIN
  IF p_payment_transaction_id IS NULL OR p_idempotency_key IS NULL OR p_initiated_by IS NULL THEN
    RAISE EXCEPTION 'Payment, idempotency key, and initiating admin are required'
      USING ERRCODE = '22023';
  END IF;

  v_amount := ROUND(COALESCE(p_amount, 0), 2);
  v_reason := LOWER(BTRIM(COALESCE(p_reason, '')));
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF v_reason NOT IN ('duplicate', 'fraudulent', 'requested_by_customer', 'others') THEN
    RAISE EXCEPTION 'Invalid refund reason' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(BTRIM(p_notes)) > 255 THEN
    RAISE EXCEPTION 'Refund notes must be 255 characters or fewer' USING ERRCODE = '22023';
  END IF;
  SELECT p.name INTO v_admin_name
  FROM public.profiles p
  WHERE p.id = p_initiated_by AND p.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
  FROM public.payment_refunds
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.payment_transaction_id <> p_payment_transaction_id
       OR v_existing.amount <> v_amount
       OR v_existing.reason <> v_reason THEN
      RAISE EXCEPTION 'Idempotency key was already used for a different refund request'
        USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(v_existing) || jsonb_build_object('created', FALSE);
  END IF;

  SELECT * INTO v_payment
  FROM public.payment_transactions
  WHERE id = p_payment_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original payment was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_payment.payment_method <> 'gcash'
     OR v_payment.gcash_channel IS DISTINCT FROM 'paymongo'
     OR v_payment.transaction_reference IS NULL
     OR v_payment.transaction_reference !~ '^pay_[A-Za-z0-9_-]{4,128}$'
     OR v_payment.payment_status NOT IN ('paid', 'partial') THEN
    RAISE EXCEPTION 'Only a verified PayMongo GCash payment can be refunded in the app'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(pr.amount), 0) INTO v_reserved
  FROM public.payment_refunds pr
  WHERE pr.payment_transaction_id = v_payment.id
    AND pr.status IN ('creating', 'pending', 'processing', 'succeeded');

  IF v_amount > v_payment.amount - v_reserved + 0.005 THEN
    RAISE EXCEPTION 'Refund exceeds the remaining refundable amount of %',
      GREATEST(v_payment.amount - v_reserved, 0)
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_refunds (
    idempotency_key, payment_transaction_id, order_id, payment_id,
    amount, reason, notes, status, initiated_by, initiated_by_name
  ) VALUES (
    p_idempotency_key, v_payment.id, v_payment.order_id,
    v_payment.transaction_reference, v_amount, v_reason,
    NULLIF(BTRIM(p_notes), ''), 'creating', p_initiated_by, v_admin_name
  )
  RETURNING * INTO v_existing;

  RETURN to_jsonb(v_existing) || jsonb_build_object('created', TRUE);
END;
$function$;

-- Mark a request whose provider call definitively failed, or whose outcome is
-- unknown after a timeout. Unknown requests remain reserved until their signed
-- webhook arrives, preventing an unsafe duplicate refund.
CREATE OR REPLACE FUNCTION public.mark_paymongo_refund_request(
  p_idempotency_key UUID,
  p_status TEXT,
  p_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_refund public.payment_refunds%ROWTYPE;
  v_status TEXT := LOWER(BTRIM(COALESCE(p_status, '')));
BEGIN
  IF v_status NOT IN ('processing', 'failed') THEN
    RAISE EXCEPTION 'Request status must be processing or failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payment_refunds
  SET status = CASE WHEN status = 'succeeded' THEN status ELSE v_status END,
      last_error = CASE WHEN status = 'succeeded' THEN last_error ELSE LEFT(p_error, 1000) END
  WHERE idempotency_key = p_idempotency_key
  RETURNING * INTO v_refund;

  RETURN CASE WHEN FOUND THEN to_jsonb(v_refund) ELSE NULL END;
END;
$function$;

-- Upsert one provider refund. The payment row lock protects the cumulative
-- succeeded total and makes webhook redelivery/concurrent partial refunds safe.
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
      provider_created_at, provider_updated_at
    ) VALUES (
      p_refund_id, p_idempotency_key, v_payment.id, v_payment.order_id, p_payment_id,
      v_amount, v_status, v_reason, NULLIF(BTRIM(p_notes), ''), p_livemode, p_event_id,
      p_provider_created_at, p_provider_updated_at
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
        provider_updated_at = COALESCE(p_provider_updated_at, provider_updated_at)
    WHERE id = v_refund.id
    RETURNING * INTO v_refund;
  END IF;

  RETURN to_jsonb(v_refund) || jsonb_build_object('linked', TRUE, 'changed', TRUE);
END;
$function$;

-- Signed payment.failed events close their registered attempt and activate the
-- existing customer notification trigger. A late failure can never downgrade
-- an already reconciled paid attempt.
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
  IF p_source_id IS NULL OR p_source_id !~ '^src_[A-Za-z0-9_-]{4,128}$' THEN
    RETURN jsonb_build_object('linked', FALSE, 'message', 'No valid source id');
  END IF;
  IF p_payment_id IS NOT NULL AND p_payment_id !~ '^pay_[A-Za-z0-9_-]{4,128}$' THEN
    RAISE EXCEPTION 'Invalid PayMongo payment id' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_attempt
  FROM public.payment_attempts
  WHERE source_id = p_source_id
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

-- Safe read model for failed attempts. The payment_attempts table remains
-- admin-only because it contains provider source ids and staged pickup data;
-- customers receive only the non-sensitive failure facts for orders they own.
CREATE OR REPLACE FUNCTION public.get_payment_attempt_history(p_order_ids UUID[])
RETURNS TABLE(
  id UUID,
  order_id UUID,
  amount NUMERIC,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  failure_message TEXT
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
  SELECT pa.id, pa.order_id, pa.amount, pa.status, pa.created_at, pa.updated_at,
    CASE WHEN v_is_admin THEN pa.last_error ELSE NULL END
  FROM public.payment_attempts pa
  JOIN public.orders o ON o.id = pa.order_id
  WHERE pa.order_id = ANY(p_order_ids)
    AND pa.status = 'failed'
    AND (v_is_admin OR o.user_id = auth.uid())
  ORDER BY pa.created_at, pa.id;
END;
$function$;

-- Defense in depth: payment.paid is the only event allowed to write money.
-- A 2xx provider response carrying any other status must never credit an order.
CREATE OR REPLACE FUNCTION public.reconcile_paymongo_payment_attempt(
  p_source_id TEXT,
  p_payment_id TEXT,
  p_payment_amount NUMERIC,
  p_payment_status TEXT DEFAULT 'paid'
)
RETURNS TABLE(order_reconciled BOOLEAN, order_id UUID, payment_id TEXT, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  attempt_row public.payment_attempts%ROWTYPE;
  order_row public.orders%ROWTYPE;
  paid_amount NUMERIC(10,2);
  final_payment_status TEXT;
BEGIN
  IF LOWER(COALESCE(p_payment_status, '')) <> 'paid' THEN
    RAISE EXCEPTION 'Only a paid PayMongo payment can be reconciled'
      USING ERRCODE = '22023';
  END IF;
  IF p_payment_id IS NULL OR p_payment_id !~ '^pay_[A-Za-z0-9_-]{4,128}$' THEN
    RAISE EXCEPTION 'A verified PayMongo payment id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt_row
  FROM public.payment_attempts
  WHERE source_id = p_source_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, p_payment_id, 'No payment attempt found for source';
    RETURN;
  END IF;
  IF attempt_row.status = 'reconciled' THEN
    RETURN QUERY SELECT TRUE, attempt_row.order_id, attempt_row.payment_id, 'Already reconciled (no-op)';
    RETURN;
  END IF;

  paid_amount := ROUND(COALESCE(NULLIF(p_payment_amount, 0), attempt_row.amount), 2);
  IF paid_amount <= 0 OR ABS(paid_amount - attempt_row.amount) > 0.005 THEN
    RAISE EXCEPTION 'PayMongo payment amount does not match the registered attempt'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO order_row
  FROM public.orders
  WHERE id = attempt_row.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.payment_attempts
    SET status = 'failed', payment_id = p_payment_id, payment_status = 'failed',
        last_error = 'Order no longer exists'
    WHERE source_id = p_source_id;
    RETURN QUERY SELECT FALSE, attempt_row.order_id, p_payment_id, 'Order no longer exists';
    RETURN;
  END IF;

  final_payment_status := CASE WHEN attempt_row.payment_type = 'paylater' THEN 'partial' ELSE 'paid' END;

  INSERT INTO public.payment_transactions (
    order_id, amount, payment_method, payment_status,
    transaction_reference, gcash_channel, admin_name, notes
  ) VALUES (
    attempt_row.order_id, paid_amount, 'gcash', final_payment_status,
    p_payment_id, 'paymongo', 'System Webhook', 'Captured via PayMongo Webhook'
  )
  ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL DO NOTHING;

  UPDATE public.orders
  SET payment_method = 'gcash',
      payer_type = COALESCE(attempt_row.payer_type, order_row.payer_type, 'sender'),
      payment_reference = COALESCE(p_payment_id, order_row.payment_reference),
      actual_weight = COALESCE(attempt_row.actual_weight, order_row.actual_weight),
      pickup_photos = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos),
      promised_payment_date = COALESCE(attempt_row.promised_payment_date, order_row.promised_payment_date)
  WHERE id = attempt_row.order_id;

  UPDATE public.payment_attempts
  SET status = 'reconciled', payment_id = p_payment_id,
      payment_status = final_payment_status, amount = paid_amount,
      last_error = NULL, reconciled_at = COALESCE(reconciled_at, NOW())
  WHERE source_id = p_source_id;

  RETURN QUERY SELECT TRUE, attempt_row.order_id, p_payment_id,
    'Order reconciled via payment_transactions insert';
END;
$function$;

-- Recalculate financial totals from gross successful payments less succeeded
-- refunds. Shipment workflow status is intentionally untouched.
CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_gross_paid NUMERIC(10,2);
  v_refunded NUMERIC(10,2);
  v_total_paid NUMERIC(10,2);
  v_shipping_cost NUMERIC(10,2);
  v_discount_amount NUMERIC(10,2);
  v_payable NUMERIC(10,2);
  v_remaining NUMERIC(10,2);
  v_order_id UUID;
BEGIN
  v_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;

  SELECT COALESCE(SUM(amount), 0) INTO v_gross_paid
  FROM public.payment_transactions
  WHERE order_id = v_order_id AND payment_status IN ('paid', 'partial');

  SELECT COALESCE(SUM(amount), 0) INTO v_refunded
  FROM public.payment_refunds
  WHERE order_id = v_order_id AND status = 'succeeded';

  v_total_paid := GREATEST(v_gross_paid - v_refunded, 0);

  SELECT shipping_cost, discount_amount INTO v_shipping_cost, v_discount_amount
  FROM public.orders WHERE id = v_order_id;

  IF NOT FOUND THEN RETURN NULL; END IF;

  v_payable := public.order_payable_amount(v_shipping_cost, v_discount_amount);
  v_remaining := GREATEST(0, v_payable - v_total_paid);

  UPDATE public.orders
  SET amount_paid = v_total_paid,
      remaining_balance = v_remaining,
      payment_status = public.derive_payment_status(v_payable, v_total_paid)
  WHERE id = v_order_id;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_update_totals_after_refund ON public.payment_refunds;
CREATE TRIGGER trigger_update_totals_after_refund
AFTER INSERT OR UPDATE OR DELETE ON public.payment_refunds
FOR EACH ROW EXECUTE FUNCTION public.update_order_payment_totals();

-- One customer notification per succeeded refund, emitted after the totals
-- trigger so its remaining-balance wording sees the new net amount.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS payment_refund_id UUID
    REFERENCES public.payment_refunds(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_payment_refund_key
  ON public.notifications (payment_refund_id) WHERE payment_refund_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.notify_refund_succeeded()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_amount_text TEXT;
  v_balance_text TEXT;
BEGIN
  IF NEW.status <> 'succeeded'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'succeeded') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.user_id IS NULL THEN RETURN NEW; END IF;

  v_amount_text := chr(8369) || to_char(NEW.amount, 'FM999,999,999,990.00');
  v_balance_text := chr(8369) || to_char(
    GREATEST(COALESCE(v_order.remaining_balance, 0), 0),
    'FM999,999,999,990.00'
  );

  INSERT INTO public.notifications (
    user_id, title, message, type, reference_id, payment_refund_id
  ) VALUES (
    v_order.user_id,
    'Refund Processed',
    format(
      'A %s refund for order %s was sent to the original GCash account. Current balance: %s.',
      v_amount_text, v_order.tracking_number, v_balance_text
    ),
    'payment_update', v_order.id, NEW.id
  ) ON CONFLICT (payment_refund_id) WHERE payment_refund_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_refund_succeeded() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_payment_refunds_notify_customer ON public.payment_refunds;
CREATE TRIGGER zz_payment_refunds_notify_customer
AFTER INSERT OR UPDATE OF status ON public.payment_refunds
FOR EACH ROW EXECUTE FUNCTION private.notify_refund_succeeded();

-- Net collections by method plus explicit gross/refund totals. Existing JSON
-- keys are preserved so old frontend bundles remain deploy-order compatible.
CREATE OR REPLACE FUNCTION public.get_sales_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;

  WITH active_orders AS (
    SELECT o.*,
      GREATEST(COALESCE(o.shipping_cost, 0) - COALESCE(o.discount_amount, 0) - COALESCE(o.amount_paid, 0), 0) AS outstanding,
      (COALESCE(o.actual_weight, 0) > 0) AS is_priced,
      (o.status IN ('Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered')) AS is_tracked
    FROM public.orders o WHERE o.status <> 'Cancelled'
  ),
  payments AS (
    SELECT LOWER(COALESCE(NULLIF(TRIM(pt.payment_method), ''), 'unspecified')) AS method,
      COALESCE(SUM(pt.amount), 0) AS gross_total, COUNT(*) AS payment_count
    FROM public.payment_transactions pt
    JOIN active_orders o ON o.id = pt.order_id
    WHERE pt.payment_status IN ('paid', 'partial') GROUP BY 1
  ),
  refunds AS (
    SELECT LOWER(COALESCE(NULLIF(TRIM(pt.payment_method), ''), 'unspecified')) AS method,
      COALESCE(SUM(pr.amount), 0) AS refund_total, COUNT(*) AS refund_count
    FROM public.payment_refunds pr
    JOIN public.payment_transactions pt ON pt.id = pr.payment_transaction_id
    JOIN active_orders o ON o.id = pr.order_id
    WHERE pr.status = 'succeeded' GROUP BY 1
  ),
  ledger AS (
    SELECT COALESCE(p.method, r.method) AS method,
      COALESCE(p.gross_total, 0) - COALESCE(r.refund_total, 0) AS total,
      COALESCE(p.gross_total, 0) AS gross_total,
      COALESCE(r.refund_total, 0) AS refund_total,
      COALESCE(p.payment_count, 0) AS payment_count,
      COALESCE(r.refund_count, 0) AS refund_count
    FROM payments p FULL OUTER JOIN refunds r USING (method)
  ),
  ledger_rollup AS (
    SELECT
      COALESCE(SUM(total) FILTER (WHERE method = 'cash'), 0) AS cash_total,
      COALESCE(SUM(total) FILTER (WHERE method = 'gcash'), 0) AS gcash_total,
      COALESCE(SUM(total) FILTER (WHERE method = 'paylater'), 0) AS paylater_total,
      COALESCE(SUM(total), 0) AS ledger_total,
      COALESCE(SUM(gross_total), 0) AS gross_ledger_total,
      COALESCE(SUM(refund_total), 0) AS refund_total,
      COALESCE(SUM(refund_count), 0) AS refund_count,
      COALESCE(jsonb_agg(jsonb_build_object(
        'method', method, 'total', total, 'grossTotal', gross_total,
        'refundTotal', refund_total, 'count', payment_count, 'refundCount', refund_count
      ) ORDER BY total DESC), '[]'::jsonb) AS method_totals
    FROM ledger
  ),
  order_rollup AS (
    SELECT COALESCE(SUM(GREATEST(shipping_cost - discount_amount, 0)), 0) AS total_revenue,
      COALESCE(SUM(discount_amount), 0) AS total_discounts,
      COALESCE(SUM(amount_paid), 0) AS paid_total,
      COALESCE(SUM(outstanding) FILTER (WHERE is_tracked), 0) AS outstanding_tracked,
      COALESCE(SUM(outstanding), 0) AS outstanding_all,
      COALESCE(SUM(remaining_balance) FILTER (WHERE is_tracked), 0) AS outstanding_stored,
      COUNT(*) FILTER (WHERE is_tracked AND outstanding > 0.005) AS unpaid_count,
      COUNT(*) FILTER (WHERE NOT is_priced) AS unpriced_count
    FROM active_orders
  ),
  summary AS (
    SELECT jsonb_build_object(
      'totalRevenue', o.total_revenue, 'totalDiscounts', o.total_discounts,
      'cashTotal', l.cash_total, 'gcashTotal', l.gcash_total, 'paylaterTotal', l.paylater_total,
      'methodTotals', l.method_totals, 'ledgerTotal', l.ledger_total,
      'grossLedgerTotal', l.gross_ledger_total,
      'refundTotal', l.refund_total, 'refundCount', l.refund_count,
      'grossCollected', o.paid_total + l.refund_total, 'netCollected', o.paid_total,
      'unattributedTotal', GREATEST(o.paid_total - l.ledger_total, 0),
      'paidTotal', o.paid_total, 'outstandingTotal', o.outstanding_tracked,
      'outstandingAllOrders', o.outstanding_all, 'outstandingStored', o.outstanding_stored,
      'unpaidTotal', o.outstanding_all, 'unpaidCount', o.unpaid_count, 'unpricedCount', o.unpriced_count
    ) AS value FROM order_rollup o, ledger_rollup l
  ),
  monthly AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.month DESC), '[]'::jsonb) AS value
    FROM (
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COALESCE(SUM(GREATEST(shipping_cost - discount_amount, 0)), 0) AS total_revenue,
        COALESCE(SUM(amount_paid), 0) AS collected,
        COALESCE(SUM(outstanding), 0) AS outstanding
      FROM active_orders GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC LIMIT 24
    ) m
  ),
  unpaid AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.created_at DESC), '[]'::jsonb) AS value
    FROM (
      SELECT id, tracking_number, created_at, status, shipping_cost, amount_paid,
        outstanding AS remaining_balance, payment_status
      FROM active_orders WHERE is_tracked AND outstanding > 0.005
      ORDER BY created_at DESC LIMIT 100
    ) u
  )
  SELECT jsonb_build_object('summary', summary.value, 'monthlySales', monthly.value, 'unpaidOrders', unpaid.value)
  INTO payload FROM summary, monthly, unpaid;
  RETURN payload;
END;
$function$;

REVOKE ALL ON FUNCTION public.prepare_paymongo_refund(UUID, NUMERIC, TEXT, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_paymongo_refund(UUID, NUMERIC, TEXT, TEXT, UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.mark_paymongo_refund_request(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_paymongo_refund_request(UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_paymongo_refund(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_refund(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_failure(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_failure(TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.get_payment_attempt_history(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payment_attempt_history(UUID[]) TO authenticated;
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, NUMERIC, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.update_order_payment_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_payment_totals() TO service_role;
REVOKE ALL ON FUNCTION public.get_sales_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_summary() TO authenticated;
