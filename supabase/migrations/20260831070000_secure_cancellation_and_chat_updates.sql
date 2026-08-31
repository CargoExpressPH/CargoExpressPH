-- Fix only the two authorization defects verified on 2026-08-31:
--   1. cancellation reviews must be admin-only and serialized;
--   2. customers may mark admin chat messages read, but may not edit them.

CREATE OR REPLACE FUNCTION public.review_order_cancellation(
  p_order_id uuid,
  p_approve boolean,
  p_notes text DEFAULT NULL::text
)
 RETURNS public.orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.orders;
  v_restore varchar;
  v_notes text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required' USING ERRCODE = '42501';
  END IF;

  v_notes := NULLIF(trim(p_notes), '');

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status != 'Pending Cancellation' THEN
    RAISE EXCEPTION 'Order is not pending cancellation';
  END IF;

  v_restore := COALESCE(v_order.cancellation_details->>'previous_status', 'Pending');

  UPDATE public.orders
     SET status = CASE WHEN p_approve THEN 'Cancelled' ELSE v_restore END,
         cancellation_details = COALESCE(v_order.cancellation_details, '{}'::jsonb)
           || jsonb_strip_nulls(jsonb_build_object(
             'reviewed_at', now(),
             'reviewed_by', auth.uid(),
             'review_notes', v_notes
           ))
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  VALUES (v_order.user_id,
          CASE WHEN p_approve THEN 'Cancellation Approved' ELSE 'Cancellation Declined' END,
          CASE WHEN p_approve
               THEN 'Order ' || v_order.tracking_number || ' has been cancelled as you requested.'
               ELSE 'Order ' || v_order.tracking_number || ' was not cancelled and is back to '
                    || chr(34) || v_restore || chr(34) || '.'
          END
          || COALESCE(' Note: ' || v_notes, ''),
          'order_update', v_order.id);

  INSERT INTO public.activity_logs (
    module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  )
  VALUES ('Orders',
          CASE WHEN p_approve THEN 'Cancellation Approved' ELSE 'Cancellation Rejected' END,
          'order',
          v_order.id,
          v_order.tracking_number,
          jsonb_build_object('status', 'Pending Cancellation'),
          jsonb_build_object('status', v_order.status),
          CASE WHEN p_approve
               THEN 'Approved the customer''s cancellation request; order cancelled.'
               ELSE 'Rejected the customer''s cancellation request; order restored to '
                    || chr(34) || v_restore || chr(34) || '.'
          END
          || COALESCE(' Note: ' || v_notes, '')
          || COALESCE(' Customer''s stated reason: ' || (v_order.cancellation_details->>'reason'), ''));

  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.review_order_cancellation(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_order_cancellation(uuid, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.review_order_cancellation(uuid, boolean, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.review_order_cancellation(uuid, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_order_cancellation(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_chat_message_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Service work has no end-user JWT. Admins retain their existing full
  -- UPDATE policy. The remaining path is a customer read acknowledgement.
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF OLD.sender_role IS DISTINCT FROM 'admin'
     OR NOT EXISTS (
       SELECT 1
       FROM public.conversations
       WHERE id = OLD.conversation_id
         AND customer_id = auth.uid()
     )
  THEN
    RAISE EXCEPTION 'Customers may update only admin messages in their own conversations'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.sender_role IS DISTINCT FROM OLD.sender_role
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Customers may change only the read state of a chat message'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_read IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Customers may only mark admin messages as read'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_chat_message_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_chat_message_update() FROM anon;
REVOKE ALL ON FUNCTION public.guard_chat_message_update() FROM authenticated;

DROP TRIGGER IF EXISTS chat_messages_guard_customer_update ON public.chat_messages;
CREATE TRIGGER chat_messages_guard_customer_update
  BEFORE UPDATE ON public.chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_chat_message_update();
