-- Add missing UPDATE policy for conversations
-- This allows admins and customers to update the status of conversations

DROP POLICY IF EXISTS "Admins can update conversations" ON conversations;

CREATE POLICY "Admins can update conversations" ON conversations
FOR UPDATE USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Customers can update own conversations" ON conversations
FOR UPDATE USING (customer_id = auth.uid());
