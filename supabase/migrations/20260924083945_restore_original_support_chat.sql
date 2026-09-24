-- Restore the support chat behavior that preceded the server bot change.
-- This reverses both support chat migrations deployed on September 24.
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

  IF actual_role = 'customer' AND NEW.sender_role = 'bot' THEN
    NEW.sender_role := 'bot';
  ELSE
    NEW.sender_role := actual_role;
  END IF;

  RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION public.guard_chat_message_insert() TO PUBLIC;

DROP TRIGGER IF EXISTS conversations_notify_support_handoff ON public.conversations;
DROP FUNCTION IF EXISTS private.notify_support_handoff();
