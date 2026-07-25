-- ======================================================================
-- 20260725200000_fix_chat_activity_log_security_definer.sql
--
-- Bug Fix: Grant SECURITY DEFINER to log_customer_chat_message()
-- 
-- Root Cause: When a customer inserts a chat message, the AFTER INSERT
-- trigger `trigger_log_customer_chat` executes `log_customer_chat_message()`.
-- The function attempts to INSERT into `activity_logs`. Because the RLS policy
-- on `activity_logs` requires `public.is_admin()`, and this function lacked
-- `SECURITY DEFINER`, PostgreSQL executed the insert under the Customer's non-admin
-- security context. RLS blocked the insert into activity_logs, which caused the
-- entire chat message transaction to fail and roll back, displaying:
-- "Failed to send message. Please try again."
-- ======================================================================

CREATE OR REPLACE FUNCTION public.log_customer_chat_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_role = 'customer' THEN
    IF (SELECT count(*) FROM chat_messages WHERE conversation_id = NEW.conversation_id) = 1 THEN
      INSERT INTO activity_logs (admin_name, module, action, record_type, record_id, record_ref, details, created_at)
      SELECT profiles.name, 'Chat', 'Customer Started Conversation', 'conversation', NEW.conversation_id, profiles.name, 'Customer initiated a new support conversation.', NOW()
      FROM conversations JOIN profiles ON conversations.customer_id = profiles.id
      WHERE conversations.id = NEW.conversation_id;
    ELSE
      INSERT INTO activity_logs (admin_name, module, action, record_type, record_id, record_ref, details, created_at)
      SELECT profiles.name, 'Chat', 'Customer Sent Message', 'conversation', NEW.conversation_id, profiles.name, 'Customer replied.', NOW()
      FROM conversations JOIN profiles ON conversations.customer_id = profiles.id
      WHERE conversations.id = NEW.conversation_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
