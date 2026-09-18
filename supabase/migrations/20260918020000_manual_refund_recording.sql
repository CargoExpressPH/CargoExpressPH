-- Manual Cash / manual-GCash Refund Recording.
--
-- Cash and manually-recorded GCash payments (payment_method = 'cash', or
-- 'gcash' with gcash_channel = 'manual') have no PayMongo record, so
-- prepare_paymongo_refund()/reconcile_paymongo_refund() correctly refuse
-- them (payment_method='gcash' AND gcash_channel='paymongo' is required).
-- Until now there was no way to record that money was actually handed back
-- for these payments, so a cancelled-and-manually-refunded Cash booking kept
-- inflating Cash Sales in every report forever.
--
-- This does NOT move money. It records that a return already happened,
-- after the admin's identity and password have been verified server-side by
-- the `record-manual-refund` Edge Function (never inside this database —
-- Postgres cannot and does not read auth.users' password hash here; the
-- Edge Function verifies it against Supabase Auth itself). This RPC is
-- reachable only by service_role, so the browser cannot call it directly and
-- skip that verification.
--
-- refund_channel distinguishes a manual row from a provider (PayMongo) row
-- everywhere a provider webhook or the recovery worker could otherwise touch
-- one — those paths are explicitly scoped to refund_channel = 'paymongo'
-- below, on top of the structural fact that a manual refund's parent
-- payment is never gcash_channel = 'paymongo' in the first place (so the
-- recovery job queue trigger, enqueue_paymongo_refund_recovery_payment(),
-- already never creates a job for it at all).
BEGIN;

-- ============================================================
-- 1. Schema: distinguish manual refunds, without repurposing the
--    PayMongo-only refund_id/payment_id columns.
-- ============================================================

ALTER TABLE public.payment_refunds
  ADD COLUMN IF NOT EXISTS refund_channel TEXT NOT NULL DEFAULT 'paymongo'
    CHECK (refund_channel IN ('paymongo', 'manual')),
  ADD COLUMN IF NOT EXISTS return_method TEXT
    CHECK (return_method IS NULL OR return_method IN ('cash', 'gcash')),
  ADD COLUMN IF NOT EXISTS return_reference TEXT
    CHECK (return_reference IS NULL OR char_length(return_reference) <= 255),
  ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;

-- A manual refund has no PayMongo resource at all. Do not invent a fake
-- 'man_...' value for a column whose format CHECK and downstream code
-- (reconcile_paymongo_refund's `transaction_reference = p_payment_id` /
-- `refund_id = p_refund_id` lookups) both assume a real PayMongo id — leave
-- both NULL for a manual row instead, and keep the format CHECK strict for
-- any row that does have a value.
ALTER TABLE public.payment_refunds ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE public.payment_refunds DROP CONSTRAINT IF EXISTS payment_refunds_payment_id_format;
ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_payment_id_format
  CHECK (payment_id IS NULL OR payment_id ~ '^pay_[A-Za-z0-9_-]{4,128}$');

ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_channel_identity CHECK (
    (refund_channel = 'paymongo' AND payment_id IS NOT NULL)
    OR (refund_channel = 'manual' AND payment_id IS NULL AND refund_id IS NULL)
  );

ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_return_method_channel CHECK (
    (refund_channel = 'manual' AND return_method IS NOT NULL)
    OR (refund_channel = 'paymongo' AND return_method IS NULL)
  );

-- Required evidence per return method, enforced at the database layer too
-- (not just the admin modal) — a GCash return needs a transfer reference to
-- check against later; a cash handover needs a short acknowledgement note,
-- since there is no transfer record for it at all.
ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_manual_return_evidence CHECK (
    refund_channel <> 'manual'
    OR (return_method = 'gcash' AND return_reference IS NOT NULL AND char_length(BTRIM(return_reference)) >= 4)
    OR (return_method = 'cash' AND notes IS NOT NULL AND char_length(BTRIM(notes)) >= 5)
  );

CREATE INDEX IF NOT EXISTS idx_payment_refunds_channel ON public.payment_refunds (refund_channel);

-- ============================================================
-- 2. Password-reauth rate limiting. Service-role only — bookkeeping for the
--    record-manual-refund Edge Function's own lockout policy, never
--    reachable from the browser (which cannot brute-force through it: every
--    attempt still requires a real Supabase Auth password check first).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.manual_refund_reauth_attempts (
  admin_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  first_failed_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE ALL ON TABLE private.manual_refund_reauth_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE private.manual_refund_reauth_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.check_manual_refund_reauth_lockout(p_admin_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_row private.manual_refund_reauth_attempts%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM private.manual_refund_reauth_attempts WHERE admin_id = p_admin_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('locked', FALSE, 'locked_until', NULL, 'failed_count', 0);
  END IF;
  RETURN jsonb_build_object(
    'locked', v_row.locked_until IS NOT NULL AND v_row.locked_until > NOW(),
    'locked_until', v_row.locked_until,
    'failed_count', v_row.failed_count
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.check_manual_refund_reauth_lockout(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_manual_refund_reauth_lockout(UUID) TO service_role;

-- 5 failed password attempts within a rolling window locks re-authentication
-- for 15 minutes. A success resets the counter. This bounds password
-- guessing through this specific flow even though the real check happens at
-- Supabase Auth, which has its own limits — defense in depth, applied here
-- because this flow is higher-value (it authorizes a financial write).
CREATE OR REPLACE FUNCTION public.record_manual_refund_reauth_attempt(p_admin_id UUID, p_success BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_max_attempts CONSTANT INTEGER := 5;
  v_lockout_minutes CONSTANT INTEGER := 15;
  v_row private.manual_refund_reauth_attempts%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_admin_id IS NULL THEN
    RAISE EXCEPTION 'Admin id is required' USING ERRCODE = '22023';
  END IF;

  IF p_success THEN
    INSERT INTO private.manual_refund_reauth_attempts (admin_id, failed_count, first_failed_at, locked_until, updated_at)
    VALUES (p_admin_id, 0, NULL, NULL, NOW())
    ON CONFLICT (admin_id) DO UPDATE
    SET failed_count = 0, first_failed_at = NULL, locked_until = NULL, updated_at = NOW();
    RETURN jsonb_build_object('locked', FALSE, 'locked_until', NULL, 'failed_count', 0);
  END IF;

  INSERT INTO private.manual_refund_reauth_attempts (admin_id, failed_count, first_failed_at, updated_at)
  VALUES (p_admin_id, 1, NOW(), NOW())
  ON CONFLICT (admin_id) DO UPDATE
  SET failed_count = CASE
        WHEN private.manual_refund_reauth_attempts.locked_until IS NOT NULL
             AND private.manual_refund_reauth_attempts.locked_until <= NOW()
          THEN 1
        ELSE private.manual_refund_reauth_attempts.failed_count + 1
      END,
      first_failed_at = CASE
        WHEN private.manual_refund_reauth_attempts.locked_until IS NOT NULL
             AND private.manual_refund_reauth_attempts.locked_until <= NOW()
          THEN NOW()
        ELSE COALESCE(private.manual_refund_reauth_attempts.first_failed_at, NOW())
      END,
      updated_at = NOW()
  RETURNING * INTO v_row;

  IF v_row.failed_count >= v_max_attempts THEN
    UPDATE private.manual_refund_reauth_attempts
    SET locked_until = NOW() + (v_lockout_minutes || ' minutes')::interval
    WHERE admin_id = p_admin_id
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'locked', v_row.locked_until IS NOT NULL AND v_row.locked_until > NOW(),
    'locked_until', v_row.locked_until,
    'failed_count', v_row.failed_count
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.record_manual_refund_reauth_attempt(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_refund_reauth_attempt(UUID, BOOLEAN) TO service_role;

-- ============================================================
-- 3. record_manual_refund — the actual write. Modeled on
--    prepare_paymongo_refund's locking/reservation logic, but synchronous
--    (no provider round trip, so no "creating" intermediate state is
--    needed — the money was already physically handed back before the
--    admin submits this).
-- ============================================================

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

-- ============================================================
-- 4. Keep provider-only paths (webhook reconciliation, uncertain/failed
--    marking, the recovery worker's wake trigger) from ever touching a
--    manual row, explicitly — not just structurally.
-- ============================================================

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
    AND refund_channel = 'paymongo'
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
    AND refund_channel = 'paymongo'
  RETURNING * INTO v_refund;
  RETURN CASE WHEN FOUND THEN to_jsonb(v_refund) ELSE NULL END;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_paymongo_refund_uncertain(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_paymongo_refund_uncertain(UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.mark_paymongo_refund_failed(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_paymongo_refund_failed(UUID, TEXT, TEXT) TO service_role;

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
  -- orphaned second row. refund_channel = 'paymongo' keeps this from ever
  -- being able to match a manual refund row, even hypothetically (a manual
  -- row's parent payment is never gcash_channel='paymongo', so v_payment
  -- above already could not have matched it — this is the explicit,
  -- belt-and-suspenders guard).
  IF NOT FOUND AND p_idempotency_key IS NULL THEN
    SELECT * INTO v_refund
    FROM public.payment_refunds
    WHERE payment_transaction_id = v_payment.id
      AND refund_channel = 'paymongo'
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
      provider_created_at, provider_updated_at, succeeded_at, refund_channel
    ) VALUES (
      p_refund_id, p_idempotency_key, v_payment.id, v_payment.order_id, p_payment_id,
      v_amount, v_status, v_reason, NULLIF(BTRIM(p_notes), ''), p_livemode, p_event_id,
      p_provider_created_at, p_provider_updated_at,
      CASE WHEN v_status = 'succeeded' THEN COALESCE(p_provider_updated_at, NOW()) ELSE NULL END,
      'paymongo'
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
        succeeded_at = CASE
          WHEN v_status = 'succeeded' THEN COALESCE(succeeded_at, p_provider_updated_at, NOW())
          ELSE succeeded_at
        END
    WHERE id = v_refund.id
      AND refund_channel = 'paymongo'
    RETURNING * INTO v_refund;
  END IF;

  RETURN to_jsonb(v_refund) || jsonb_build_object('linked', TRUE, 'changed', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_paymongo_refund(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_refund(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO service_role;

-- The recovery worker's "wake this payment's job" trigger fires on every
-- payment_refunds insert/status change. A manual refund's parent payment
-- was never enqueued in the first place (enqueue_paymongo_refund_recovery_payment
-- only queues gcash_channel='paymongo' payments), so this UPDATE already
-- always affects zero rows for a manual refund — this guard makes that
-- explicit and testable instead of relying on the coincidence.
CREATE OR REPLACE FUNCTION private.wake_paymongo_refund_recovery_for_refund()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.refund_channel <> 'paymongo' THEN
    RETURN NEW;
  END IF;

  UPDATE private.paymongo_refund_recovery_jobs
  SET status = 'active',
      scan_until = GREATEST(scan_until, NOW() + INTERVAL '24 hours'),
      next_check_at = LEAST(
        COALESCE(next_check_at, NOW() + INTERVAL '2 minutes'),
        NOW() + INTERVAL '2 minutes'
      ),
      updated_at = NOW()
  WHERE payment_transaction_id = NEW.payment_transaction_id;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.wake_paymongo_refund_recovery_for_refund()
  FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 5. Customer notification copy must not claim a manual return "may take
--    additional time to appear in your original GCash account" — that
--    sentence is only true for a PayMongo-processed refund. A manual
--    return already happened in person or by a direct transfer the admin
--    made themselves.
-- ============================================================

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
  v_message TEXT;
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

  v_message := CASE
    WHEN NEW.refund_channel = 'manual' AND NEW.return_method = 'cash' THEN
      format(
        'A %s cash refund for order %s was recorded. The remaining balance for this order is now %s.',
        v_amount_text, v_order.tracking_number, v_balance_text
      )
    WHEN NEW.refund_channel = 'manual' AND NEW.return_method = 'gcash' THEN
      format(
        'A %s GCash refund for order %s was recorded as returned by our team. The remaining balance for this order is now %s.',
        v_amount_text, v_order.tracking_number, v_balance_text
      )
    ELSE
      format(
        'Your %s refund for order %s was successfully processed. The remaining balance for this order is now %s. It may take additional time for the refund to appear in your original GCash account.',
        v_amount_text, v_order.tracking_number, v_balance_text
      )
  END;

  INSERT INTO public.notifications (
    user_id, title, message, type, reference_id, payment_refund_id
  ) VALUES (
    v_order.user_id,
    'Refund Completed',
    v_message,
    'payment_update', v_order.id, NEW.id
  ) ON CONFLICT (payment_refund_id) WHERE payment_refund_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_refund_succeeded()
  FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 6. get_payment_refund_history — surface the new columns. This changes the
--    function's output column list, so it must be dropped and recreated
--    rather than CREATE OR REPLACE'd. return_reference stays admin-only
--    (mirrors payment_id/refund_id's existing redaction); refund_channel
--    and return_method are shown to the customer too — knowing *how* their
--    money came back is not sensitive, unlike the provider's internal ids.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_payment_refund_history(UUID[]);

CREATE FUNCTION public.get_payment_refund_history(p_order_ids UUID[])
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
  public_failure_reason TEXT,
  refund_channel TEXT,
  return_method TEXT,
  return_reference TEXT,
  returned_at TIMESTAMPTZ,
  succeeded_at TIMESTAMPTZ
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
    pr.public_failure_reason,
    pr.refund_channel,
    pr.return_method,
    CASE WHEN v_is_admin THEN pr.return_reference ELSE NULL END,
    pr.returned_at,
    pr.succeeded_at
  FROM public.payment_refunds AS pr
  JOIN public.orders AS o ON o.id = pr.order_id
  WHERE pr.order_id = ANY(p_order_ids)
    AND (v_is_admin OR o.user_id = auth.uid())
  ORDER BY pr.created_at, pr.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payment_refund_history(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payment_refund_history(UUID[]) TO authenticated;

COMMIT;
