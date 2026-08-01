-- ======================================================================
-- 20260801010000_customer_chat_read_policy.sql
--
-- Allow customers to mark ADMIN messages as read (is_read = true) in
-- their own conversations. Previously only admins could UPDATE
-- chat_messages ("Admins update messages" policy), so the customer
-- chat-unread badge could never be cleared.
--
-- The WITH CHECK clause locks the update to is_read = true only, on
-- admin messages, inside the customer's own conversations.
-- ======================================================================

CREATE POLICY "Customers mark admin messages read" ON public.chat_messages
  FOR UPDATE
  TO authenticated
  USING (
    sender_role = 'admin'
    AND EXISTS (
      SELECT 1 FROM conversations
      WHERE id = chat_messages.conversation_id AND customer_id = auth.uid()
    )
  )
  WITH CHECK (
    sender_role = 'admin'
    AND is_read = true
    AND EXISTS (
      SELECT 1 FROM conversations
      WHERE id = chat_messages.conversation_id AND customer_id = auth.uid()
    )
  );
