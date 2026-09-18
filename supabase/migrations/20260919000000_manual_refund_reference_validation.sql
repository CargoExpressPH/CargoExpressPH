-- Fix: the GCash manual-return reference only required 4+ characters — any
-- non-empty string passed, including an email address, a phone number, or
-- the ORIGINAL payment's own reference accidentally reused. This tightens
-- both the RPC (clear, specific error messages) and the table itself (a
-- backstop that holds even for a hypothetical direct service-role write
-- that bypasses the RPC).
--
-- There is no single universal GCash reference format to enforce exactly —
-- verified guides describe a numeric "Ref No." (commonly ~13 digits for a
-- wallet-to-wallet transfer) versus a separately-labelled "InstaPay Ref No."
-- for a bank-linked transfer, which is not guaranteed to share that same
-- shape. See MANUAL_REFUND_REFERENCE_VALIDATION_FIX_REPORT.md for the
-- sources. So this checks structure and clearly-wrong values (blank, an
-- email, a phone number, an internal PayMongo id, or the original payment's
-- own reference) rather than one fixed length/pattern.
--
-- Existing records: this column (`return_reference`) was added by
-- 20260918020000_manual_refund_recording.sql in the same work that shipped
-- this feature, which has not been deployed — there are zero existing rows
-- using it in any real environment, so no backfill/migration of existing
-- data is needed. The constraint below is still written as an ordinary
-- (not NOT VALID) CHECK for that reason; if this were ever added against a
-- table with real historical rows, it should be added NOT VALID and
-- validated separately after confirming no existing row violates it.
BEGIN;

-- A GCash reference that contains '@' is not a transfer reference — reject
-- it at the table level too, not just in the RPC's own message.
ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_gcash_reference_not_email CHECK (
    return_method <> 'gcash'
    OR return_reference IS NULL
    OR return_reference !~ '@'
  );

-- Every documented GCash-adjacent reference format (the app's own wallet
-- transfer reference, or an InstaPay reference for a bank-linked transfer)
-- is numeric-based. A value with fewer than 4 digits in it is not
-- reference-shaped by any of those formats.
ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_gcash_reference_has_digits CHECK (
    return_method <> 'gcash'
    OR return_reference IS NULL
    OR return_reference ~ '[0-9]{4,}'
  );

CREATE OR REPLACE FUNCTION public.record_manual_refund(
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
  v_payment public.payment_transactions%ROWTYPE;
  v_existing public.payment_refunds%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_reserved NUMERIC(10,2);
  v_amount NUMERIC(10,2);
  v_reason TEXT;
  v_return_method TEXT;
  v_notes TEXT;
  v_return_reference TEXT;
  v_returned_at TIMESTAMPTZ;
  v_admin_name TEXT;
BEGIN
  -- Reachable only via service_role (see GRANT below) — i.e. only the
  -- record-manual-refund Edge Function, after it has verified the caller's
  -- password against Supabase Auth. p_admin_id is that verified identity,
  -- never a browser-supplied value the browser could set to someone else.
  -- Rechecked against profiles regardless, so this function alone can never
  -- attribute a refund to an id that isn't actually an admin right now.
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_payment_transaction_id IS NULL OR p_idempotency_key IS NULL OR p_admin_id IS NULL THEN
    RAISE EXCEPTION 'Payment, idempotency key, and verified admin are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT p.name INTO v_admin_name
  FROM public.profiles p
  WHERE p.id = p_admin_id AND p.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  v_amount := ROUND(COALESCE(p_amount, 0), 2);
  v_reason := LOWER(BTRIM(COALESCE(p_reason, '')));
  v_return_method := LOWER(BTRIM(COALESCE(p_return_method, '')));
  v_notes := NULLIF(BTRIM(p_notes), '');
  v_return_reference := NULLIF(BTRIM(p_return_reference), '');
  v_returned_at := COALESCE(p_returned_at, NOW());

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF v_reason NOT IN ('duplicate', 'fraudulent', 'requested_by_customer', 'others') THEN
    RAISE EXCEPTION 'Invalid refund reason' USING ERRCODE = '22023';
  END IF;
  IF v_return_method NOT IN ('cash', 'gcash') THEN
    RAISE EXCEPTION 'Return method must be cash or gcash' USING ERRCODE = '22023';
  END IF;
  IF v_return_method = 'gcash' AND (v_return_reference IS NULL OR char_length(v_return_reference) < 4) THEN
    RAISE EXCEPTION 'A GCash transfer reference is required to record a manual GCash return'
      USING ERRCODE = '22023';
  END IF;
  -- Format checks beyond "present and 4+ characters" — mirrors
  -- src/utils/gcashReference.js on the client and the equivalent checks in
  -- the record-manual-refund Edge Function, so all three layers agree.
  IF v_return_method = 'gcash' AND v_return_reference ~ '@' THEN
    RAISE EXCEPTION 'That looks like an email address, not a GCash transfer reference'
      USING ERRCODE = '22023';
  END IF;
  -- Checked in two steps: first that the value is phone-SHAPED at all (only
  -- digits and common phone punctuation) before stripping anything.
  -- Stripping non-digits from an alphanumeric value first — e.g. a PayMongo
  -- id like "pay_9f8a7b6c5d4e3f2a1b0c" — can coincidentally leave a
  -- 10-digit string starting with 9, which would misread as a phone number
  -- even though the original value plainly wasn't one.
  IF v_return_method = 'gcash'
     AND v_return_reference ~ '^[0-9[:space:]()+-]+$'
     AND regexp_replace(v_return_reference, '[^0-9]', '', 'g') ~ '^(63|0)?9[0-9]{9}$'
     AND char_length(regexp_replace(v_return_reference, '[^0-9]', '', 'g')) <= 12 THEN
    RAISE EXCEPTION 'That looks like a phone number, not a GCash transfer reference'
      USING ERRCODE = '22023';
  END IF;
  IF v_return_method = 'gcash' AND v_return_reference ~* '^(pay|ref|src|link|paym|pi|re|sub|cus|evt)_[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'That looks like an internal payment system ID, not a GCash transfer reference'
      USING ERRCODE = '22023';
  END IF;
  IF v_return_method = 'gcash' AND v_return_reference !~ '[0-9]{4,}' THEN
    RAISE EXCEPTION 'Enter the reference number from the completed GCash transfer receipt'
      USING ERRCODE = '22023';
  END IF;
  IF v_return_method = 'cash' AND (v_notes IS NULL OR char_length(v_notes) < 5) THEN
    RAISE EXCEPTION 'A short acknowledgement note is required to record a manual cash return'
      USING ERRCODE = '22023';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 255 THEN
    RAISE EXCEPTION 'Notes must be 255 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF v_returned_at > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'The return time cannot be in the future' USING ERRCODE = '22023';
  END IF;

  -- Idempotent retry (double-click / network retry from the Edge Function):
  -- the identical key must describe the identical request, never a second
  -- logical refund.
  SELECT * INTO v_existing
  FROM public.payment_refunds
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.payment_transaction_id <> p_payment_transaction_id
       OR v_existing.amount <> v_amount
       OR v_existing.reason <> v_reason
       OR v_existing.refund_channel <> 'manual' THEN
      RAISE EXCEPTION 'Idempotency key was already used for a different refund request'
        USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(v_existing) || jsonb_build_object('created', FALSE);
  END IF;

  -- Locking the original payment row serializes two admins recording a
  -- manual refund (or one admin double-submitting from two tabs) for the
  -- same transaction at the same time — same technique as
  -- prepare_paymongo_refund.
  SELECT * INTO v_payment
  FROM public.payment_transactions
  WHERE id = p_payment_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original payment was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_payment.payment_status NOT IN ('paid', 'partial') THEN
    RAISE EXCEPTION 'Only a paid or partially paid transaction can be refunded' USING ERRCODE = '22023';
  END IF;
  -- A verified PayMongo GCash payment has its own reconcilable provider
  -- record and must go through prepare_paymongo_refund/paymongo-refund
  -- instead, so it stays checkable against PayMongo's own ledger. This RPC
  -- exists only for the payments PayMongo has no record of at all.
  IF v_payment.payment_method = 'gcash' AND v_payment.gcash_channel = 'paymongo' THEN
    RAISE EXCEPTION 'This payment was made through PayMongo. Use the provider refund instead of a manual refund.'
      USING ERRCODE = '22023';
  END IF;
  -- Only meaningful once v_payment is loaded: the reference of the NEW
  -- outgoing refund transfer must not just be the original payment's own
  -- reference copied back in (a plausible mistake, not a malicious one, but
  -- it would record something that never actually happened as evidence).
  IF v_return_method = 'gcash'
     AND v_payment.transaction_reference IS NOT NULL
     AND LOWER(v_return_reference) = LOWER(BTRIM(v_payment.transaction_reference)) THEN
    RAISE EXCEPTION 'That matches the original payment''s own reference. Enter the reference of the NEW outgoing refund transfer.'
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
    idempotency_key, payment_transaction_id, order_id, payment_id, refund_id,
    amount, currency, status, reason, notes, initiated_by, initiated_by_name,
    refund_channel, return_method, return_reference, returned_at, succeeded_at
  ) VALUES (
    p_idempotency_key, v_payment.id, v_payment.order_id, NULL, NULL,
    v_amount, 'PHP', 'succeeded', v_reason, v_notes, p_admin_id, v_admin_name,
    'manual', v_return_method, v_return_reference, v_returned_at, v_returned_at
  )
  RETURNING * INTO v_existing;

  -- Fires the existing trigger_update_totals_after_refund trigger
  -- (unchanged) via the INSERT above, recomputing amount_paid /
  -- remaining_balance / payment_status the same way a PayMongo refund does.
  -- Also fires the existing notify_refund_succeeded trigger for the
  -- customer notification, and (for a manual refund's parent payment,
  -- which is never gcash_channel='paymongo') wake_paymongo_refund_recovery_for_refund
  -- is a guaranteed no-op — see that function's own refund_channel guard.

  SELECT * INTO v_order FROM public.orders WHERE id = v_payment.order_id;

  -- guard_activity_log_insert() only derives admin_id/admin_name from
  -- auth.uid() when it is non-null; a service-role call has no auth.uid(),
  -- so it passes the row through untouched — these must be set explicitly
  -- here, using the identity this function itself just verified above, not
  -- anything supplied by the Edge Function's request body directly.
  INSERT INTO public.activity_logs (
    admin_id, admin_name, module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  ) VALUES (
    p_admin_id, v_admin_name, 'Payments', 'Manual Refund Recorded', 'order',
    v_payment.order_id, v_order.tracking_number,
    jsonb_build_object('amount_paid', v_order.amount_paid),
    jsonb_build_object('manual_refund_amount', v_amount, 'return_method', v_return_method),
    format(
      'Recorded a manual %s return of %s against the original %s payment (transaction %s). %s',
      v_return_method,
      to_char(v_amount, 'FM999,999,999,990.00'),
      v_payment.payment_method,
      v_payment.id,
      CASE WHEN v_return_method = 'gcash'
        THEN 'Transfer reference: ' || v_return_reference
        ELSE 'Acknowledgement: ' || v_notes
      END
    )
  );

  RETURN to_jsonb(v_existing) || jsonb_build_object('created', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_manual_refund(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_refund(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, UUID)
  TO service_role;

COMMIT;
