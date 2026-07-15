-- 1. Create a unique index for transaction_reference to prevent duplicate payment logs
CREATE UNIQUE INDEX IF NOT EXISTS unique_tx_ref ON public.payment_transactions (transaction_reference) WHERE transaction_reference IS NOT NULL;

-- 2. Create the trigger function to automatically calculate orders.amount_paid
CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
RETURNS trigger AS $$
DECLARE
  v_total_paid DECIMAL(10,2);
  v_shipping_cost DECIMAL(10,2);
  v_remaining DECIMAL(10,2);
  v_payment_status TEXT;
  v_order_id UUID;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  -- Sum all successful payments for this order
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.payment_transactions
  WHERE order_id = v_order_id AND payment_status IN ('paid', 'partial');

  -- Get shipping cost
  SELECT shipping_cost INTO v_shipping_cost
  FROM public.orders
  WHERE id = v_order_id;

  v_remaining := GREATEST(0, COALESCE(v_shipping_cost, 0) - v_total_paid);

  IF v_remaining <= 0 THEN
    v_payment_status := 'paid';
  ELSIF v_total_paid > 0 THEN
    v_payment_status := 'partial';
  ELSE
    v_payment_status := 'unpaid';
  END IF;

  UPDATE public.orders
  SET amount_paid = v_total_paid,
      remaining_balance = v_remaining,
      payment_status = v_payment_status
  WHERE id = v_order_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Attach trigger to payment_transactions
DROP TRIGGER IF EXISTS trigger_update_totals_after_payment ON public.payment_transactions;
CREATE TRIGGER trigger_update_totals_after_payment
AFTER INSERT OR UPDATE OR DELETE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION public.update_order_payment_totals();


-- 4. Overwrite reconcile_paymongo_payment_attempt
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
) AS $$
DECLARE
  attempt_row public.payment_attempts%ROWTYPE;
  order_row public.orders%ROWTYPE;
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
       SET status = 'failed',
           payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status,
           last_error = 'Order no longer exists'
     WHERE source_id = p_source_id;

    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order no longer exists';
    RETURN;
  END IF;

  IF attempt_row.payment_type = 'paylater' THEN
    final_payment_status := 'partial';
  ELSE
    final_payment_status := 'paid';
  END IF;

  -- Only reconcile if p_payment_id is present (meaning it's captured)
  IF p_payment_id IS NOT NULL THEN
    -- Insert into payment_transactions instead of overwriting orders
    -- The trigger on payment_transactions will automatically recalculate orders.amount_paid
    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status, transaction_reference, admin_name, notes
    ) VALUES (
      attempt_row.order_id, paid_amount, 'gcash', final_payment_status, p_payment_id, 'System Webhook', 'Captured via PayMongo Webhook'
    ) ON CONFLICT (transaction_reference) DO NOTHING;
    
    -- We still need to update the orders metadata like payment_method, payer_type, actual_weight
    UPDATE public.orders
       SET payment_method = 'gcash',
           payer_type = COALESCE(attempt_row.payer_type, order_row.payer_type, 'sender'),
           payment_reference = COALESCE(p_payment_id, order_row.payment_reference),
           actual_weight = COALESCE(attempt_row.actual_weight, order_row.actual_weight),
           pickup_photos = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos),
           promised_payment_date = COALESCE(attempt_row.promised_payment_date, order_row.promised_payment_date)
           -- We do NOT overwrite amount_paid here anymore!
     WHERE id = attempt_row.order_id;
  END IF;

  UPDATE public.payment_attempts
     SET status = 'reconciled',
         payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
         payment_status = final_payment_status,
         amount = paid_amount,
         last_error = NULL,
         reconciled_at = COALESCE(payment_attempts.reconciled_at, NOW())
   WHERE source_id = p_source_id;

  RETURN QUERY SELECT true, attempt_row.order_id, p_payment_id, 'Order reconciled via payment_transactions insert';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, DECIMAL, TEXT) TO service_role;
