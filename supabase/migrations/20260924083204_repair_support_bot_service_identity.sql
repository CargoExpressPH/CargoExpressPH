-- PostgREST's new sb_secret key runs as the service_role database role but
-- does not populate the legacy request.jwt.claim.role setting. Read the
-- database role selected by PostgREST instead of trusting a writable claim.
CREATE OR REPLACE FUNCTION public.guard_chat_message_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actual_role text;
BEGIN
  IF current_setting('role', true) = 'service_role' THEN
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
