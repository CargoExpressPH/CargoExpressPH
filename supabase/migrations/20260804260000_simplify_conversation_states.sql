-- ============================================================
-- 20260804260000_simplify_conversation_states.sql
--
-- Simplification, by client direction: fewer states, zero manual state
-- buttons, and returning customers meet the bot again.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────
--
-- Phase 1 removed an overloaded state, then reintroduced the same class of
-- mistake in a new place: it added an "Awaiting Customer" BUTTON, asking an
-- admin to tell the system something it already knows — who spoke last.
-- State the system can compute should never be a human's job to maintain.
--
-- ── THE MODEL, ALL DERIVED ───────────────────────────────────────────────
--
--   bot_active        new chat, or a resolved customer returning
--   waiting           the customer spoke last  → OUR TURN (the queue)
--   waiting_customer  an admin spoke last      → their turn
--   resolved          an admin said so         → the ONLY manual state
--
-- `open` is deleted. Once every admin reply means "waiting on the
-- customer", `open` described nothing that assigned_admin_id did not
-- already say. One state and one button removed by the same change.
--
-- ── RETURNING CUSTOMERS GO BACK TO THE BOT ───────────────────────────────
--
-- Previously a customer writing into a resolved thread was routed straight
-- to the admin queue. Client direction, and the better default: they most
-- often have a NEW basic question the bot can answer, so the bot gets first
-- crack and escalates if it cannot help.
--
-- Accepted cost, recorded here so it is not rediscovered as a bug: someone
-- replying "that didn't work" to a resolved issue now meets the bot rather
-- than the person who helped them. The ~20 escalation patterns catch most
-- of that phrasing and the 👍/👎 prompt always offers a way through, so the
-- worst case is one extra round trip, not a buried customer.
--
-- ── SIDE EFFECT WORTH HAVING ─────────────────────────────────────────────
--
-- The 7-day auto-resolve sweep barely fired before, because a thread only
-- reached 'waiting_customer' if somebody clicked the button. Now every
-- answered thread lands there on its own, so the inbox stays clean without
-- anyone maintaining it.
-- ============================================================


-- ============================================================
-- 1. Widen, remap, then narrow — same safe ordering as 20260804210000
-- ============================================================

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('bot_active', 'waiting', 'waiting_customer', 'resolved', 'open'));

-- 'open' becomes whichever side the transcript says is next to speak.
WITH last_sender AS (
  SELECT DISTINCT ON (conversation_id) conversation_id, sender_role
    FROM public.chat_messages
   ORDER BY conversation_id, created_at DESC
)
UPDATE public.conversations c
   SET status = CASE
         WHEN l.sender_role = 'customer' THEN 'waiting'
         ELSE 'waiting_customer'
       END
  FROM (SELECT id FROM public.conversations WHERE status = 'open') AS ids
  LEFT JOIN last_sender l ON l.conversation_id = ids.id
 WHERE c.id = ids.id;

ALTER TABLE public.conversations DROP CONSTRAINT conversations_status_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('bot_active', 'waiting', 'waiting_customer', 'resolved'));


-- ============================================================
-- 2. The trigger — every transition, derived from who just spoke
--
-- WHY THE GUC: this function runs with the CUSTOMER's auth.uid(), so its
-- UPDATE is subject to guard_conversation_update, which (correctly) refuses
-- customer-driven status changes other than escalation to 'waiting'. Without
-- a way to distinguish "the server decided this" from "the client asked for
-- this", the resolved → bot_active transition below would be silently
-- reverted by the guard.
--
-- The flag is transaction-local (set_config third argument = true) and is
-- cleared immediately after the UPDATE. A client cannot set it: PostgREST
-- gives each request its own transaction, and inserting a chat message is
-- not a statement that can also carry a hand-written UPDATE.
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

  PERFORM set_config('app.conversation_service_write', 'on', true);

  IF NEW.sender_role = 'customer' THEN
    UPDATE public.conversations
       SET last_customer_message_at = NEW.created_at,
           status = CASE
                      -- Bot keeps the thread it is already handling.
                      WHEN v_status = 'bot_active' THEN 'bot_active'
                      -- A returning customer starts over with the bot: the
                      -- question is usually new, and usually basic.
                      WHEN v_status = 'resolved'   THEN 'bot_active'
                      -- Otherwise a human is mid-conversation: our turn.
                      ELSE 'waiting'
                    END,
           resolved_at = NULL
     WHERE id = NEW.conversation_id;

  ELSIF NEW.sender_role = 'admin' THEN
    -- An admin replying IS the signal that we are now waiting on the
    -- customer. This is what the "Awaiting Customer" button used to ask a
    -- human to state manually.
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
-- 3. Teach the guard to recognise a server-side write
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_conversation_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service role, admins, and the service-state trigger above.
  IF auth.uid() IS NULL
     OR public.is_admin()
     OR COALESCE(current_setting('app.conversation_service_write', true), 'off') = 'on'
  THEN
    RETURN NEW;
  END IF;

  IF OLD.customer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cannot modify another customer''s conversation';
  END IF;

  NEW.id                       := OLD.id;
  NEW.customer_id              := OLD.customer_id;
  NEW.created_at               := OLD.created_at;
  NEW.assigned_admin_id        := OLD.assigned_admin_id;
  NEW.first_response_at        := OLD.first_response_at;
  NEW.last_customer_message_at := OLD.last_customer_message_at;
  NEW.resolved_at              := OLD.resolved_at;

  -- Escalation remains the only status a customer may set, and only upward.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'waiting' THEN
    NEW.status := OLD.status;
  END IF;

  IF NEW.escalated IS DISTINCT FROM OLD.escalated AND NEW.escalated = FALSE THEN
    NEW.escalated := OLD.escalated;
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- 4. Sweep now covers exactly one state
--
-- 'waiting' stays excluded, and that exclusion is still the load-bearing
-- part: a timer must never clear a conversation where a human is needed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_resolve_stale_conversations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH swept AS (
    UPDATE public.conversations
       SET status = 'resolved'
     WHERE status = 'waiting_customer'
       AND COALESCE(last_customer_message_at, created_at) < now() - interval '7 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM swept;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auto_resolve_stale_conversations() FROM PUBLIC, anon, authenticated;


-- ============================================================
-- VERIFY:
--   SELECT status, COUNT(*) FROM conversations GROUP BY status;   -- no 'open'
--
--   -- admin reply parks the thread on the customer, with no button:
--   -- insert an admin message, expect status 'waiting_customer'
--   -- customer writes into a resolved thread, expect status 'bot_active'
--
-- ROLLBACK: re-apply 20260804210000 (its trigger and sweep bodies) and
-- restore 'open' to the CHECK constraint.
-- ============================================================
