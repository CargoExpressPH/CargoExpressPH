-- Add payment_type to payment_transactions
ALTER TABLE public.payment_transactions
ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'Additional Payment';

-- Update previous initial payments
UPDATE public.payment_transactions
SET payment_type = 'Downpayment'
WHERE notes = 'Initial pickup payment' AND payment_status = 'partial';

UPDATE public.payment_transactions
SET payment_type = 'Full Payment'
WHERE notes = 'Initial pickup payment' AND payment_status = 'paid';

-- Allow customers to view their own payment transactions
DROP POLICY IF EXISTS "Customers can view their own payment transactions" ON public.payment_transactions;
CREATE POLICY "Customers can view their own payment transactions"
ON public.payment_transactions FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM orders 
    WHERE orders.id = payment_transactions.order_id 
    AND orders.user_id = auth.uid()
  )
);
