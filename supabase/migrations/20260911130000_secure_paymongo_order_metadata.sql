-- ============================================================
-- Customer PayMongo attempts must never carry trusted pickup data.
--
-- The customer-facing Edge Function is intentionally allowed to register a
-- source for an order the customer owns. Before this migration, the same
-- request could also stage actual_weight, payer_type and pickup_photos. The
-- service-role reconciliation RPC then copied those values to orders.
--
-- The Edge Function now rejects those fields for customers. This migration is
-- the independent database boundary: reconciliation only applies staged
-- operational metadata when the attempt creator is still an admin. Customer
-- payments continue to credit the ledger while preserving the order's trusted
-- weight, Freight Prepaid/Freight Collect choice, photos and promise date.
-- ============================================================

-- Remove unsafe values from unfinished legacy customer attempts. Reconciled
-- rows are historical records and are left untouched; current production was
-- verified to contain no unfinished customer attempt before this migration.
UPDATE public.payment_attempts AS pa
   SET actual_weight = NULL,
       payer_type = NULL,
       pickup_photos = NULL
 WHERE pa.status <> 'reconciled'
   AND NOT EXISTS (
     SELECT 1
       FROM public.profiles AS p
      WHERE p.id = pa.created_by
        AND p.role = 'admin'
   )
   AND (
     pa.actual_weight IS NOT NULL
     OR pa.payer_type IS NOT NULL
     OR (pa.pickup_photos IS NOT NULL AND pa.pickup_photos <> '[]'::jsonb)
   );

-- Missing payer metadata must mean "preserve the order", not silently turn a
-- Freight Collect order into sender-pays.
ALTER TABLE public.payment_attempts
  ALTER COLUMN payer_type DROP DEFAULT;

ALTER TABLE public.payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_actual_weight_valid;

ALTER TABLE public.payment_attempts
  ADD CONSTRAINT payment_attempts_actual_weight_valid
  CHECK (actual_weight IS NULL OR (actual_weight > 0 AND actual_weight <= 10000));

ALTER TABLE public.payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_pickup_photos_valid;

ALTER TABLE public.payment_attempts
  ADD CONSTRAINT payment_attempts_pickup_photos_valid
  CHECK (
    pickup_photos IS NULL
    OR (
      jsonb_typeof(pickup_photos) = 'array'
      AND jsonb_array_length(pickup_photos) <= 3
    )
  );

-- Replace the old upper-bound-only order constraint. NULL remains the valid
-- "not weighed yet" state; every recorded weight must be positive.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS check_orders_actual_weight_upper_bound;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS check_orders_actual_weight_valid;

ALTER TABLE public.orders
  ADD CONSTRAINT check_orders_actual_weight_valid
  CHECK (actual_weight IS NULL OR (actual_weight > 0 AND actual_weight <= 10000));


CREATE OR REPLACE FUNCTION public.reconcile_paymongo_payment_attempt(
  p_source_id text,
  p_payment_id text,
  p_payment_amount numeric,
  p_payment_status text DEFAULT 'paid'::text
)
RETURNS TABLE(order_reconciled boolean, order_id uuid, payment_id text, message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  attempt_row             public.payment_attempts%ROWTYPE;
  order_row               public.orders%ROWTYPE;
  paid_amount             DECIMAL(10,2);
  final_payment_status    TEXT;
  attempt_creator_is_admin BOOLEAN := FALSE;
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

  IF attempt_row.status = 'reconciled' THEN
    RETURN QUERY SELECT true, attempt_row.order_id, attempt_row.payment_id, 'Already reconciled (no-op)';
    RETURN;
  END IF;

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

  -- This lookup is intentionally performed inside the same locked
  -- reconciliation transaction. Missing/deleted/demoted creators fail closed:
  -- their genuine payment is recorded, but staged pickup metadata is ignored.
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles AS p
     WHERE p.id = attempt_row.created_by
       AND p.role = 'admin'
  )
    INTO attempt_creator_is_admin;

  IF attempt_row.payment_type = 'paylater' THEN
    final_payment_status := 'partial';
  ELSE
    final_payment_status := 'paid';
  END IF;

  INSERT INTO public.payment_transactions (
    order_id, amount, payment_method, payment_status,
    transaction_reference, gcash_channel, admin_name, notes
  ) VALUES (
    attempt_row.order_id, paid_amount, 'gcash', final_payment_status,
    p_payment_id, 'paymongo', 'System Webhook', 'Captured via PayMongo Webhook'
  )
  ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
  DO NOTHING;

  -- Money metadata is updated for every genuine payment. Pickup metadata is
  -- copied only for an admin-created attempt, preserving the current combined
  -- admin pickup + GCash workflow without trusting a customer request.
  UPDATE public.orders
     SET payment_method    = 'gcash',
         payment_reference = COALESCE(p_payment_id, order_row.payment_reference),
         payer_type = CASE
           WHEN attempt_creator_is_admin
             THEN COALESCE(attempt_row.payer_type, order_row.payer_type, 'sender')
           ELSE COALESCE(order_row.payer_type, 'sender')
         END,
         actual_weight = CASE
           WHEN attempt_creator_is_admin
             THEN COALESCE(attempt_row.actual_weight, order_row.actual_weight)
           ELSE order_row.actual_weight
         END,
         pickup_photos = CASE
           WHEN attempt_creator_is_admin
             THEN COALESCE(attempt_row.pickup_photos, order_row.pickup_photos)
           ELSE order_row.pickup_photos
         END,
         promised_payment_date = CASE
           WHEN attempt_creator_is_admin
             THEN COALESCE(attempt_row.promised_payment_date, order_row.promised_payment_date)
           ELSE order_row.promised_payment_date
         END
   WHERE id = attempt_row.order_id;

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

-- CREATE OR REPLACE preserves old ACLs, but restate the least-privilege
-- boundary so this migration is safe even if a target project has drifted.
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(text, text, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(text, text, numeric, text)
  TO service_role;
