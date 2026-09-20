CREATE OR REPLACE FUNCTION public.maintain_conversation_service_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status      TEXT;
  v_next        TEXT;
  v_new_session BOOLEAN;
BEGIN
  SELECT status
    INTO v_status
    FROM public.conversations
   WHERE id = NEW.conversation_id;

  PERFORM set_config('app.conversation_service_write', 'on', true);

  IF NEW.sender_role = 'customer' THEN
    v_next := CASE
                WHEN v_status = 'bot_active' THEN 'bot_active'
                WHEN v_status = 'resolved' THEN 'bot_active'
                ELSE 'waiting'
              END;

    v_new_session := (v_status = 'resolved' AND v_next = 'bot_active');

    UPDATE public.conversations
       SET last_customer_message_at = NEW.created_at,
           status      = v_next,
           escalated   = CASE WHEN v_new_session THEN FALSE ELSE escalated END,
           resolved_at = NULL
     WHERE id = NEW.conversation_id;

  ELSIF NEW.sender_role = 'admin' THEN
    UPDATE public.conversations
       SET first_response_at = COALESCE(first_response_at, NEW.created_at),
           status = 'waiting_customer'
     WHERE id = NEW.conversation_id;
  END IF;

  PERFORM set_config('app.conversation_service_write', 'off', true);
  RETURN NEW;
END;
$$;
