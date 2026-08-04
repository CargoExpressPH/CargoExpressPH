-- ============================================================
-- 20260804240000_guard_conversation_update.sql
--
-- Phase 2b support — stop a customer writing service state they should
-- not control.
--
-- ── THE GAP ──────────────────────────────────────────────────────────────
--
-- The RLS policy is:
--
--     "Customers can update own conversations"
--     FOR UPDATE USING (customer_id = auth.uid())      -- no WITH CHECK
--
-- USING decides which ROWS you may touch. Without WITH CHECK there is no
-- constraint on what you may write into them, so a customer could update
-- EVERY column of their own conversation:
--
--   status            -> 'resolved' removes them from the admin queue;
--                        'waiting' at will jumps it
--   assigned_admin_id -> point their conversation at any admin
--   first_response_at -> forge a response time in the service report
--   resolved_at       -> same
--
-- This predates Phase 1, but Phase 1 is what made it matter: status now
-- drives the queue an admin works from, and the timestamps now drive
-- reporting. Phase 2b adds one more legitimate customer write
-- (bot_resolved), which is the moment to bound the whole surface.
--
-- ── WHAT A CUSTOMER LEGITIMATELY WRITES ──────────────────────────────────
--
--   bot_resolved   the 👍/👎 answer — only the customer knows it
--   escalated      TRUE, when they ask for a human
--   status         'waiting', the same escalation
--
-- Everything else is the server's business. Rather than deny the update —
-- which would break escalation — the trigger reverts the fields a customer
-- may not set, the same approach guard_profile_write already takes for
-- role and guard_chat_message_insert takes for sender identity.
--
-- Admins and service-role writes pass through untouched.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_conversation_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service role / trigger-internal writes (auth.uid() IS NULL) and admins
  -- are unrestricted. maintain_conversation_service_state() runs as its
  -- definer but still carries the customer's auth.uid(), so it is covered
  -- by the allowances below — it only ever sets status, the timestamps and
  -- resolved_at, and those are re-derived here from OLD where disallowed.
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  -- Not the owner: nothing about this row may change. (RLS should already
  -- have refused, but a trigger that assumes RLS is correct is a trigger
  -- that stops being true the day a policy is edited.)
  IF OLD.customer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cannot modify another customer''s conversation';
  END IF;

  -- Immutable from the client side, always.
  NEW.id                       := OLD.id;
  NEW.customer_id              := OLD.customer_id;
  NEW.created_at               := OLD.created_at;
  NEW.assigned_admin_id        := OLD.assigned_admin_id;
  NEW.first_response_at        := OLD.first_response_at;
  NEW.last_customer_message_at := OLD.last_customer_message_at;
  NEW.resolved_at              := OLD.resolved_at;

  -- Escalation is the only status a customer may set, and it is one-way:
  -- they can ask for a human, never mark themselves handled.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'waiting' THEN
    NEW.status := OLD.status;
  END IF;

  -- escalated may only be raised, never cleared.
  IF NEW.escalated IS DISTINCT FROM OLD.escalated AND NEW.escalated = FALSE THEN
    NEW.escalated := OLD.escalated;
  END IF;

  -- bot_resolved passes through: the customer is the only source for it.

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_guard_update ON public.conversations;
CREATE TRIGGER conversations_guard_update
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_update();


-- ============================================================
-- ORDERING NOTE
--
-- Two BEFORE UPDATE triggers now exist on conversations:
--   conversations_guard_update        (this one)
--   conversations_stamp_resolved_at   (20260804210000)
--
-- PostgreSQL fires BEFORE triggers in alphabetical order by name, so
-- `conversations_guard_update` runs FIRST and `..._stamp_resolved_at`
-- second. That is the order we want: the guard reverts a forged
-- resolved_at, then the stamp sets the real one if the status genuinely
-- moved to 'resolved'. Renaming either trigger could silently invert this.
-- ============================================================


-- ============================================================
-- VERIFY (as a CUSTOMER session, on your own conversation):
--
--   -- allowed
--   UPDATE conversations SET bot_resolved = true WHERE customer_id = auth.uid();
--   UPDATE conversations SET status = 'waiting', escalated = true
--    WHERE customer_id = auth.uid();
--
--   -- silently reverted (no error, no effect)
--   UPDATE conversations SET status = 'resolved' WHERE customer_id = auth.uid();
--   UPDATE conversations SET first_response_at = now() WHERE customer_id = auth.uid();
--   UPDATE conversations SET assigned_admin_id = '<an admin uuid>'
--    WHERE customer_id = auth.uid();
-- ============================================================
