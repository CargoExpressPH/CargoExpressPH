-- ======================================================================
-- 20260730120000_admins_insert_conversations.sql
--
-- Allow admins to start a conversation with any customer from the
-- admin Inbox. Previously only customers could insert their own
-- conversation row, so admin-initiated chats with customers who had
-- never opened support chat failed silently.
-- ======================================================================

DROP POLICY IF EXISTS "Admins insert conversations" ON public.conversations;

CREATE POLICY "Admins insert conversations" ON public.conversations
  FOR INSERT
  WITH CHECK (
    public.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = conversations.customer_id AND role = 'customer'
    )
  );
