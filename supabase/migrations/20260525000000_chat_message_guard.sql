-- Migration: Harden chat_messages insert policy and add sender guard trigger
-- Applied: 2026-05-25
-- Fixes: sender_id spoofing and sender_role impersonation

-- 1. Replace the insert policy to enforce sender_id = auth.uid()
DROP POLICY IF EXISTS "Users insert messages in allowed conversations" ON chat_messages;

CREATE POLICY "Users insert messages in allowed conversations" ON chat_messages
  FOR INSERT WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations
      WHERE id = chat_messages.conversation_id AND (
        customer_id = auth.uid() OR
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
      )
    )
  );

-- 2. Add trigger to force sender_id and sender_role to real values
CREATE OR REPLACE FUNCTION public.guard_chat_message_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actual_role TEXT;
BEGIN
  SELECT role INTO actual_role FROM public.profiles WHERE id = auth.uid();
  IF actual_role IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  NEW.sender_id := auth.uid();
  NEW.sender_role := actual_role;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_guard_insert ON chat_messages;
CREATE TRIGGER chat_messages_guard_insert
  BEFORE INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_message_insert();
