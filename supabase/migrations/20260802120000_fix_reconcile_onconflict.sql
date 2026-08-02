-- ============================================================================
-- EMERGENCY FIX — restore PayMongo reconciliation
--
-- DIAGNOSIS (Step 0, 2026-08-02):
--   The deployed reconcile function is the v3 "ledger" version from migration
--   20260622010000_fix_payment_reconciliation.sql. It contains:
--
--       ON CONFLICT (transaction_reference) DO NOTHING
--
--   but the only unique index on that column is PARTIAL:
--
--       CREATE UNIQUE INDEX unique_tx_ref ON payment_transactions
--         (transaction_reference) WHERE (transaction_reference IS NOT NULL);
--
--   PostgreSQL cannot infer a partial unique index for ON CONFLICT unless the
--   statement repeats the index predicate. Inference fails with:
--
--       42P10: there is no unique or exclusion constraint matching the
--              ON CONFLICT specification
--
--   The exception aborts the whole function, so the order is never updated.
--
-- EVIDENCE:
--   Last successful reconciliation: 2026-06-21 (5 attempts).
--   The v3 migration was applied on 2026-06-22.
--   Since then: 18 attempts stuck at 'chargeable', 12 at 'pending', 0 settled.
--   All 15 payment_transactions rows have admin_name != 'System Webhook',
--   i.e. NOT ONE automated payment has ever reached the ledger.
--
-- THIS IS A STOPGAP, NOT THE FIX.
--   It restores service while the unified payment architecture is built.
--   This entire function is scheduled for removal — see
--   docs/payment-redesign-v2.md, Phase 8.
--
-- CHANGES (minimal and surgical):
--   1. Add the index predicate to ON CONFLICT so inference succeeds.
--   2. Add `SET search_path = public` — this SECURITY DEFINER function was
--      missing it, unlike every other function in the schema.
--   3. Add an index on payment_transactions(order_id): the totals trigger runs
--      SUM(...) WHERE order_id = ? on every ledger write and had no index.
--   Nothing else is altered. Behaviour is otherwise identical to v3.
-- ============================================================================


-- ─── 1. Missing index (pure performance, no behaviour change) ───────────────
-- update_order_payment_totals() aggregates by order_id on every insert.
CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_id
  ON public.payment_transactions (order_id);


-- ─── 2. Reconcile function — v3 with the ON CONFLICT predicate fixed ────────
CREATE OR REPLACE FUNCTION public.reconcile_paymongo_payment_attempt(
  p_source_id TEXT,
  p_payment_id TEXT,
  p_payment_amount DECIMAL,
  p_payment_status TEXT DEFAULT 'paid'
)
RETURNS TABLE (
  order_reconciled BOOLEAN,
  order_id UUID,
  payment_id TEXT,
  message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public          -- ← ADDED: was missing on this SECURITY DEFINER fn
AS $$
DECLARE
  attempt_row public.payment_attempts%ROWTYPE;
  order_row   public.orders%ROWTYPE;
  paid_amount DECIMAL(10,2);
  final_payment_status TEXT;
BEGIN
  SELECT *
    INTO attempt_row
    FROM public.payment_attempts
   WHERE source_id = p_source_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, p_payment_id, 'No payment attempt found for source';
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
      transaction_reference, admin_name, notes
    ) VALUES (
      attempt_row.order_id, paid_amount, 'gcash', final_payment_status,
      p_payment_id, 'System Webhook', 'Captured via PayMongo Webhook'
    )
    -- ↓↓↓ THE FIX: the index predicate is required to infer a PARTIAL index ↓↓↓
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
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, DECIMAL, TEXT)
  TO service_role;


-- ============================================================================
-- POST-DEPLOY VERIFICATION (run separately, read-only)
--
--   -- The ON CONFLICT bug should now be gone:
--   SELECT prosrc LIKE '%ON CONFLICT (transaction_reference) WHERE%' AS fixed
--   FROM pg_proc WHERE proname = 'reconcile_paymongo_payment_attempt';
--
--   -- After the next real payment, this should return a 'System Webhook' row:
--   SELECT admin_name, count(*) FROM payment_transactions GROUP BY admin_name;
-- ============================================================================
