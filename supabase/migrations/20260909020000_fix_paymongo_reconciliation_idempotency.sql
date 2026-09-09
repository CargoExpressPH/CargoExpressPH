-- ============================================================
-- BUG-01 fix (part 2 of 3): true idempotency in
-- reconcile_paymongo_payment_attempt(), and reject synthetic references.
--
-- Root cause (verified against the current repo, corroborating
-- SYSTEM_MODULE_BUG_AUDIT.md BUG-01): the webhook's source.chargeable
-- self-heal branch and the poll action's self-heal branch each reconciled a
-- PayMongo source using a MADE-UP reference (`auto_${sourceId}`) whenever a
-- capture call raced against a sibling capture and lost with a "not
-- chargeable" error but the source itself read back as PayMongo-confirmed
-- "paid". The real payment.paid webhook then arrived independently with the
-- REAL PayMongo payment id and called reconcile() again. Because the two
-- reconcile calls carried two different transaction_reference values, the
-- database's own idempotency guard — ON CONFLICT (transaction_reference) —
-- could not recognize them as the same money, and both inserted a
-- payment_transactions row. One real GCash payment was credited twice.
--
-- This migration closes the gap at the one place both callers already
-- funnel through, instead of trying to fix the race in application code:
--
--   1. Once a payment_attempts row reaches status = 'reconciled', ANY further
--      call — a synthetic self-heal call, a redelivered webhook, or two
--      requests this function's own `FOR UPDATE` lock has now serialized —
--      is a true no-op: it returns the existing result and writes nothing.
--      This is checked BEFORE the ledger insert, so it holds regardless of
--      what reference the caller passes.
--   2. A payment id matching the synthetic `auto_...` shape is rejected
--      outright. The corresponding fix in supabase/functions/paymongo-webhook
--      and supabase/functions/paymongo-create-payment stops generating that
--      shape at all (see PAYMENT_DUPLICATE_PREVENTION_FIX.md); this is
--      defense in depth against an old, un-redeployed function version, or a
--      future regression, doing it again.
--
-- The `FOR UPDATE` row lock this function already took on payment_attempts
-- is what makes step 1 safe under concurrency: Postgres serializes any two
-- callers racing on the same source_id, so the second one to run always
-- observes the first one's committed 'reconciled' status before it can
-- decide whether to insert anything.
-- ============================================================

CREATE OR REPLACE FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text DEFAULT 'paid'::text)
 RETURNS TABLE(order_reconciled boolean, order_id uuid, payment_id text, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  attempt_row public.payment_attempts%ROWTYPE;
  order_row   public.orders%ROWTYPE;
  paid_amount DECIMAL(10,2);
  final_payment_status TEXT;
BEGIN
  IF p_payment_id IS NOT NULL AND p_payment_id ~ '^auto_' THEN
    RAISE EXCEPTION 'Synthetic payment references are not allowed; a verified PayMongo payment id is required to reconcile a payment.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO attempt_row
    FROM public.payment_attempts
   WHERE source_id = p_source_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, p_payment_id, 'No payment attempt found for source';
    RETURN;
  END IF;

  -- ── THE FIX ──────────────────────────────────────────────────────────────
  -- Already reconciled: whatever reference this call carries, the money for
  -- this attempt has already been recorded exactly once. Returning the
  -- existing result (rather than falling through to the insert below) is
  -- what makes a redelivered webhook, a second internal self-heal, and two
  -- requests racing on this lock all safe no-ops instead of a second ledger
  -- row.
  IF attempt_row.status = 'reconciled' THEN
    RETURN QUERY SELECT true, attempt_row.order_id, attempt_row.payment_id, 'Already reconciled (no-op)';
    RETURN;
  END IF;
  -- ─────────────────────────────────────────────────────────────────────────

  -- No verified payment id means nothing was actually captured — a "check
  -- the source status" call, not a "credit the order" call. Report it
  -- honestly as not reconciled and leave the attempt's status untouched,
  -- rather than marking it 'reconciled' with no backing ledger row.
  IF p_payment_id IS NULL THEN
    RETURN QUERY SELECT false, attempt_row.order_id, NULL::TEXT, 'No verified payment id supplied; nothing recorded';
    RETURN;
  END IF;

  paid_amount := COALESCE(NULLIF(p_payment_amount, 0), attempt_row.amount);

  SELECT *
    INTO order_row
    FROM public.orders
   WHERE id = attempt_row.order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.payment_attempts
       SET status         = 'failed',
           payment_id     = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status,
           last_error     = 'Order no longer exists'
     WHERE source_id = p_source_id;

    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order no longer exists';
    RETURN;
  END IF;

  IF attempt_row.payment_type = 'paylater' THEN
    final_payment_status := 'partial';
  ELSE
    final_payment_status := 'paid';
  END IF;

  -- Only record money when the payment was actually captured.
  IF p_payment_id IS NOT NULL THEN
    -- The ledger is the source of truth; trigger_update_totals_after_payment
    -- recomputes orders.amount_paid / remaining_balance / payment_status.
    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, gcash_channel, admin_name, notes
    ) VALUES (
      attempt_row.order_id, paid_amount, 'gcash', final_payment_status,
      p_payment_id, 'paymongo', 'System Webhook', 'Captured via PayMongo Webhook'
    )
    -- Retained as defense in depth for an exact-reference redelivery (e.g. the
    -- same payment.paid event processed twice concurrently before either
    -- commits) even though the status check above is now the primary guard.
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;

    -- Order metadata only. amount_paid is deliberately NOT written here —
    -- the ledger trigger owns it.
    UPDATE public.orders
       SET payment_method        = 'gcash',
           payer_type            = COALESCE(attempt_row.payer_type, order_row.payer_type, 'sender'),
           payment_reference     = COALESCE(p_payment_id, order_row.payment_reference),
           actual_weight         = COALESCE(attempt_row.actual_weight, order_row.actual_weight),
           pickup_photos         = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos),
           promised_payment_date = COALESCE(attempt_row.promised_payment_date, order_row.promised_payment_date)
     WHERE id = attempt_row.order_id;
  END IF;

  UPDATE public.payment_attempts
     SET status         = 'reconciled',
         payment_id     = COALESCE(p_payment_id, payment_attempts.payment_id),
         payment_status = final_payment_status,
         amount         = paid_amount,
         last_error     = NULL,
         reconciled_at  = COALESCE(payment_attempts.reconciled_at, NOW())
   WHERE source_id = p_source_id;

  RETURN QUERY SELECT true, attempt_row.order_id, p_payment_id, 'Order reconciled via payment_transactions insert';
END;
$function$;

-- CREATE OR REPLACE FUNCTION does not change privileges, but the grants are
-- restated here to keep this migration self-describing and safe to run
-- against a database where they somehow drifted.
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text) TO service_role;
