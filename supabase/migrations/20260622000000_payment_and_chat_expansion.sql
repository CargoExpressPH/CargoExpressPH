-- 1. Create payment_transactions table
CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  payment_method TEXT NOT NULL,
  transaction_reference TEXT DEFAULT NULL,
  payment_status TEXT NOT NULL,
  admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS for payment_transactions
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can insert and select payment transactions" 
ON public.payment_transactions FOR ALL 
USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
) 
WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
);

-- Backfill existing payments
INSERT INTO public.payment_transactions (order_id, amount, payment_method, payment_status, admin_name, notes, created_at)
SELECT 
  id, 
  amount_paid, 
  COALESCE(payment_method, 'cash'), 
  CASE WHEN amount_paid >= shipping_cost THEN 'paid' ELSE 'partial' END, 
  'System Migration', 
  'Initial pickup payment', 
  created_at
FROM public.orders
WHERE amount_paid > 0;

-- 2. Chat Extensions
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open',
ADD COLUMN IF NOT EXISTS assigned_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 3. Database Trigger for Customer Chat Messages
CREATE OR REPLACE FUNCTION log_customer_chat_message() RETURNS trigger AS $$
BEGIN
  IF NEW.sender_role = 'customer' THEN
    -- Check if this is the first message
    IF (SELECT count(*) FROM chat_messages WHERE conversation_id = NEW.conversation_id) = 1 THEN
      INSERT INTO activity_logs (admin_name, module, action, record_type, record_id, record_ref, details, created_at)
      SELECT profiles.name, 'Chat', 'Customer Started Conversation', 'conversation', NEW.conversation_id, profiles.name, 'Customer initiated a new support conversation.', NOW()
      FROM conversations JOIN profiles ON conversations.customer_id = profiles.id
      WHERE conversations.id = NEW.conversation_id;
    ELSE
      INSERT INTO activity_logs (admin_name, module, action, record_type, record_id, record_ref, details, created_at)
      SELECT profiles.name, 'Chat', 'Customer Sent Message', 'conversation', NEW.conversation_id, profiles.name, 'Customer replied.', NOW()
      FROM conversations JOIN profiles ON conversations.customer_id = profiles.id
      WHERE conversations.id = NEW.conversation_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_log_customer_chat ON public.chat_messages;
CREATE TRIGGER trigger_log_customer_chat
AFTER INSERT ON public.chat_messages
FOR EACH ROW EXECUTE FUNCTION log_customer_chat_message();
