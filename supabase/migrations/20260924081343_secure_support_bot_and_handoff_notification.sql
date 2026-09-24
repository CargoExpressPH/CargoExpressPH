-- A customer may never choose the assistant's sender role. The authenticated
-- Edge Function computes the reply and writes it with the service credential.
CREATE OR REPLACE FUNCTION public.guard_chat_message_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actual_role text;
BEGIN
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    IF NEW.sender_role IS DISTINCT FROM 'bot'
       OR NOT EXISTS (
         SELECT 1 FROM public.conversations c
          WHERE c.id = NEW.conversation_id AND c.customer_id = NEW.sender_id
       ) THEN
      RAISE EXCEPTION 'Invalid server bot message' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  SELECT p.role INTO actual_role FROM public.profiles p WHERE p.id = auth.uid();
  IF actual_role NOT IN ('customer', 'admin') OR actual_role IS NULL
     OR NEW.sender_role IS DISTINCT FROM actual_role THEN
    RAISE EXCEPTION 'Sender role does not match the signed-in user' USING ERRCODE = '42501';
  END IF;
  NEW.sender_id := auth.uid();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_chat_message_insert() FROM PUBLIC, anon, authenticated;

-- The existing chat_messages trigger covers messages sent while an admin
-- already owns a conversation. A first handoff happens later, on the status
-- UPDATE from bot_active to waiting, and otherwise creates no notification.
CREATE OR REPLACE FUNCTION private.notify_support_handoff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT p.id, 'Customer Waiting for Support',
         'A customer asked to speak with an administrator.', 'chat_message', NEW.id
    FROM public.profiles p
   WHERE p.role = 'admin';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.notify_support_handoff() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS conversations_notify_support_handoff ON public.conversations;
CREATE TRIGGER conversations_notify_support_handoff
AFTER UPDATE OF status ON public.conversations
FOR EACH ROW
WHEN (OLD.status = 'bot_active' AND NEW.status = 'waiting' AND NEW.escalated = true)
EXECUTE FUNCTION private.notify_support_handoff();
