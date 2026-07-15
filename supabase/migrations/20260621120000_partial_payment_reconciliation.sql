-- Fix partial payment reconciliation for GCash Pay Later orders.
-- Adds payment_type and estimated_cost to payment_attempts so the reconcile
-- function can correctly calculate remaining_balance instead of always setting it to 0.

-- Step 1: Add new columns to payment_attempts
ALTER TABLE public.payment_attempts
  ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'full' CHECK (payment_type IN ('full', 'paylater')),
  ADD COLUMN IF NOT EXISTS estimated_cost DECIMAL(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS promised_payment_date DATE DEFAULT NULL;

-- Step 2: Replace the reconcile function to handle partial payments correctly
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
SET search_path = public
AS $$
DECLARE
  attempt_row public.payment_attempts%ROWTYPE;
  order_row public.orders%ROWTYPE;
  paid_amount DECIMAL(10,2);
  total_cost DECIMAL(10,2);
  remaining DECIMAL(10,2);
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
       SET status = 'failed',
           payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status,
           last_error = 'Order no longer exists'
     WHERE source_id = p_source_id;

    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order no longer exists';
    RETURN;
  END IF;

  -- Block duplicate payment only if already fully paid with a DIFFERENT payment reference.
  -- Partial payments ('partial' status) should always be allowed to proceed.
  IF order_row.payment_status = 'paid'
     AND order_row.payment_reference IS NOT NULL
     AND p_payment_id IS NOT NULL
     AND order_row.payment_reference <> p_payment_id THEN
    UPDATE public.payment_attempts
       SET status = 'failed',
           payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status,
           last_error = 'Order already fully paid with a different payment reference'
     WHERE source_id = p_source_id;

    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order already fully paid with a different payment reference';
    RETURN;
  END IF;

  -- Calculate remaining balance and payment status based on payment type
  total_cost := COALESCE(attempt_row.estimated_cost, order_row.shipping_cost, paid_amount);
  remaining := GREATEST(0, total_cost - paid_amount);

  IF attempt_row.payment_type = 'paylater' THEN
    -- Pay Later: this is a downpayment, there may be a remaining balance
    IF paid_amount > 0 THEN
      final_payment_status := CASE WHEN remaining > 0 THEN 'partial' ELSE 'paid' END;
    ELSE
      final_payment_status := 'unpaid';
    END IF;
  ELSE
    -- Full Payment: set as paid (remaining should be 0 or small rounding)
    final_payment_status := CASE WHEN remaining > 0 THEN 'partial' ELSE 'paid' END;
    remaining := 0; -- For full payment, trust the QR amount was the full amount
  END IF;

  UPDATE public.orders
     SET payment_method = 'gcash',
         payer_type = COALESCE(attempt_row.payer_type, 'sender'),
         amount_paid = paid_amount,
         remaining_balance = remaining,
         payment_status = final_payment_status,
         payment_reference = COALESCE(p_payment_id, order_row.payment_reference),
         actual_weight = COALESCE(attempt_row.actual_weight, order_row.actual_weight),
         pickup_photos = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos),
         promised_payment_date = COALESCE(attempt_row.promised_payment_date, order_row.promised_payment_date),
         status = 'Picked Up'
   WHERE id = attempt_row.order_id;

  UPDATE public.payment_attempts
     SET status = 'reconciled',
         payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
         payment_status = final_payment_status,
         amount = paid_amount,
         last_error = NULL,
         reconciled_at = COALESCE(payment_attempts.reconciled_at, NOW())
   WHERE source_id = p_source_id;

  RETURN QUERY SELECT true, attempt_row.order_id, p_payment_id, 'Order reconciled';
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, DECIMAL, TEXT) TO service_role;
