-- Allow customers to insert messages with sender_role = 'bot' for hybrid chatbot support

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
  
  -- If customer session inserts a bot message, preserve the bot role
  IF actual_role = 'customer' AND NEW.sender_role = 'bot' THEN
    NEW.sender_role := 'bot';
  ELSE
    NEW.sender_role := actual_role;
  END IF;
  
  RETURN NEW;
END;
$$;
