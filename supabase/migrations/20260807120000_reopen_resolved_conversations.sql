-- ============================================================
-- 20260807120000_reopen_resolved_conversations.sql
--
-- A customer writing into a RESOLVED thread reopens it to 'waiting' (the
-- admin queue) instead of being handed back to the bot.
--
-- ── WHAT THIS REVERSES ───────────────────────────────────────────────────
--
-- 20260804260000 deliberately routed resolved → 'bot_active' on client
-- direction: a returning customer usually has a NEW and usually basic
-- question, so the bot got first crack. That migration recorded the accepted
-- cost in its own header — "someone replying 'that didn't work' to a resolved
-- issue now meets the bot rather than the person who helped them" — and bet
-- that the escalation patterns plus the rating prompt would catch it.
--
-- E2E testing showed the bet does not hold, and the failure is worse than the
-- comment predicted. The customer is not merely met by the bot; they are met
-- by a bot with no thread context, answering a follow-up to a conversation it
-- cannot see, while the admin who resolved the ticket is never told the
-- customer came back. The thread stays out of the queue: 'bot_active' is
-- excluded from the inbox unread count and carries no badge, so the reply is
-- invisible to every admin surface. "One extra round trip" was the estimate;
-- a silently stranded customer is the actual behaviour.
--
-- ── THE RULE NOW ─────────────────────────────────────────────────────────
--
--   bot_active        → bot_active     bot keeps the thread it is handling
--   resolved          → waiting        REOPENED — this migration
--   waiting           → waiting        unchanged, still ours
--   waiting_customer  → waiting        unchanged, their reply is ours now
--
-- Only a brand-new conversation now starts in 'bot_active'. A thread that a
-- human has already touched stays with humans, which is the property the
-- original model was missing.
--
-- ── WHAT IS DELIBERATELY NOT CHANGED ─────────────────────────────────────
--
-- `assigned_admin_id` is untouched, so a reopened thread returns to the admin
-- who resolved it rather than to an unassigned queue slot. `resolved_at` is
-- already cleared by the customer branch — the thread is no longer resolved,
-- so a resolution timestamp on it would be a lie.
--
-- `escalated` stays FALSE. Reopening says "whose turn"; escalated says "how
-- urgent". A polite follow-up is not urgent, and conflating the two is the
-- exact defect 20260804260000 was written to remove. An escalation pattern in
-- the message still raises the flag through the normal path.
--
-- Reopening is done HERE and not in the client on purpose. The client could
-- insert the message and then PATCH the status — guard_conversation_update
-- permits a customer to set 'waiting' — but that is two round trips with a
-- failure window between them, and losing the second one leaves the message
-- written and the thread invisible. That is the bug, reintroduced as a race.
-- ============================================================

CREATE OR REPLACE FUNCTION public.maintain_conversation_service_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM public.conversations WHERE id = NEW.conversation_id;

  -- Marks this as a SERVER decision so guard_conversation_update lets the
  -- status move through. Transaction-local and cleared immediately; a client
  -- cannot set it, since inserting a message is its own transaction.
  PERFORM set_config('app.conversation_service_write', 'on', true);

  IF NEW.sender_role = 'customer' THEN
    UPDATE public.conversations
       SET last_customer_message_at = NEW.created_at,
           status = CASE
                      -- The bot keeps the thread it is already handling.
                      WHEN v_status = 'bot_active' THEN 'bot_active'
                      -- Everything else is our turn, INCLUDING 'resolved':
                      -- a human owned this thread, and a follow-up belongs to
                      -- them, not to a bot that cannot see the history.
                      ELSE 'waiting'
                    END,
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
$$;


-- ============================================================
-- VERIFY (as the customer who owns conversation :cid):
--
--   UPDATE conversations SET status = 'resolved', resolved_at = now()
--    WHERE id = :cid;                                    -- admin resolves
--
--   INSERT INTO chat_messages (conversation_id, sender_id, sender_role, message)
--   VALUES (:cid, :customer_id, 'customer', 'I have one more question');
--
--   SELECT status, resolved_at, assigned_admin_id, escalated
--     FROM conversations WHERE id = :cid;
--   -- expect: status 'waiting', resolved_at NULL,
--   --         assigned_admin_id UNCHANGED, escalated still FALSE
--
--   -- and the thread now counts toward the admin inbox badge, which selects
--   -- unread customer messages in conversations with status = 'waiting'.
-- ============================================================
