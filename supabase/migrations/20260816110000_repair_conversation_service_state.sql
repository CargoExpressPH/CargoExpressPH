-- ============================================================
-- Repair maintain_conversation_service_state — support chat was dead.
--
-- The live function (see supabase/schema.sql as regenerated in f66906e) was an
-- older revision that had been reintroduced over the top of
-- 20260808150000_remove_chat_assignment.sql. It was broken in three ways, and
-- the first one alone stopped every message in the product:
--
--   1. It wrote `conversations.last_message_at`. There is no such column —
--      the column is `last_customer_message_at`. The UPDATE therefore raised
--      42703 on EVERY branch, and because this is an AFTER INSERT trigger the
--      whole transaction rolled back. So no chat_messages row could be
--      inserted by anyone: not the customer, not the bot's reply, not an
--      admin. That is the "cannot send a message, fails after multiple try
--      again attempts" report — SupportChatPage's retry was retrying an insert
--      that could never succeed, and the bot never spoke because its reply is
--      itself an insert.
--
--   2. The reopen grace window had decayed to 15 SECONDS, not the 12 hours
--      20260807140000_reopen_grace_window.sql specifies. At 15 seconds
--      essentially every follow-up counts as a brand-new session, which hands
--      a continuing conversation back to a bot that cannot see it.
--
--   3. It was neither SECURITY DEFINER nor did it set
--      `app.conversation_service_write`, so guard_conversation_update reverted
--      the very status transition it had just computed whenever the actor was
--      a customer. The trigger's whole output was being thrown away.
--
-- Restored here to the 20260808150000 definition (shared inbox, no
-- assigned_admin_id), which is the intended one.
-- ============================================================

-- Also: the column DEFAULT was still 'open', a value 20260804260000 deleted
-- from the CHECK constraint. Any INSERT that omits `status` therefore fails
-- outright. getOrCreateConversation() happens to pass 'bot_active' explicitly,
-- which is the only reason this has not surfaced — a default that can only
-- ever raise is a trap, not a default.
ALTER TABLE public.conversations ALTER COLUMN status SET DEFAULT 'bot_active';

CREATE OR REPLACE FUNCTION public.maintain_conversation_service_state()
 RETURNS TRIGGER
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status      TEXT;
  v_resolved_at TIMESTAMPTZ;
  v_next        TEXT;
  v_new_session BOOLEAN;
BEGIN
  SELECT status, resolved_at
    INTO v_status, v_resolved_at
    FROM public.conversations
   WHERE id = NEW.conversation_id;

  -- Marks this as a SERVER decision so guard_conversation_update lets the
  -- status move through. Transaction-local and cleared immediately; a client
  -- cannot set it, since inserting a message is its own transaction.
  PERFORM set_config('app.conversation_service_write', 'on', true);

  IF NEW.sender_role = 'customer' THEN
    v_next := CASE
                -- The bot keeps the thread it is already handling.
                WHEN v_status = 'bot_active' THEN 'bot_active'
                -- Resolved within the grace window: a FOLLOW-UP, straight back
                -- to the humans who just handled it.
                WHEN v_status = 'resolved'
                     AND v_resolved_at IS NOT NULL
                     AND v_resolved_at >= now() - INTERVAL '12 hours'
                  THEN 'waiting'
                -- Resolved longer ago, or at an unknown time: a NEW question on
                -- the customer's one and only conversation row. Bot first, same
                -- as any new chat.
                WHEN v_status = 'resolved' THEN 'bot_active'
                -- waiting / waiting_customer: already ours, stays ours.
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
    -- An admin replying IS the signal that we are now waiting on the customer.
    UPDATE public.conversations
       SET first_response_at = COALESCE(first_response_at, NEW.created_at),
           status = 'waiting_customer'
     WHERE id = NEW.conversation_id;
  END IF;

  -- sender_role = 'bot' changes nothing: a bot reply is not a response for
  -- service purposes and must never clear the queue.

  PERFORM set_config('app.conversation_service_write', 'off', true);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS chat_messages_maintain_service_state ON public.chat_messages;
CREATE TRIGGER chat_messages_maintain_service_state
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.maintain_conversation_service_state();
