-- Durable PayMongo source/payment reconciliation for GCash pickup payments.
-- A payment_attempt row is created as soon as the GCash source exists. Webhooks
-- and direct capture calls then reconcile against this row idempotently.

CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  description TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'chargeable', 'reconciled', 'failed')),
  payment_id TEXT UNIQUE DEFAULT NULL,
  payment_status TEXT DEFAULT NULL,
  actual_weight DECIMAL(10,2) DEFAULT NULL,
  payer_type VARCHAR(20) DEFAULT 'sender' CHECK (payer_type IN ('sender', 'receiver')),
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  last_error TEXT DEFAULT NULL,
  reconciled_at TIMESTAMPTZ DEFAULT NULL,
  created_by UUID DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage payment attempts" ON public.payment_attempts;
CREATE POLICY "Admins can manage payment attempts" ON public.payment_attempts
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order_id ON public.payment_attempts(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON public.payment_attempts(status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_created_at ON public.payment_attempts(created_at DESC);

DROP TRIGGER IF EXISTS payment_attempts_updated_at ON public.payment_attempts;
CREATE TRIGGER payment_attempts_updated_at BEFORE UPDATE ON public.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

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

  IF order_row.payment_status = 'paid'
     AND order_row.payment_reference IS NOT NULL
     AND p_payment_id IS NOT NULL
     AND order_row.payment_reference <> p_payment_id THEN
    UPDATE public.payment_attempts
       SET status = 'failed',
           payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status,
           last_error = 'Order already paid with a different payment reference'
     WHERE source_id = p_source_id;

    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order already paid with a different payment reference';
    RETURN;
  END IF;

  UPDATE public.orders
     SET payment_method = 'gcash',
         payer_type = COALESCE(attempt_row.payer_type, 'sender'),
         amount_paid = paid_amount,
         remaining_balance = 0,
         payment_status = 'paid',
         payment_reference = COALESCE(p_payment_id, order_row.payment_reference),
         actual_weight = COALESCE(attempt_row.actual_weight, order_row.actual_weight),
         pickup_photos = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos),
         promised_payment_date = NULL,
         status = 'Picked Up'
   WHERE id = attempt_row.order_id;

  UPDATE public.payment_attempts
     SET status = 'reconciled',
         payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
         payment_status = p_payment_status,
         amount = paid_amount,
         last_error = NULL,
         reconciled_at = COALESCE(payment_attempts.reconciled_at, NOW())
   WHERE source_id = p_source_id;

  RETURN QUERY SELECT true, attempt_row.order_id, p_payment_id, 'Order reconciled';
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, DECIMAL, TEXT) TO service_role;
