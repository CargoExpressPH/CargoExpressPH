-- ============================================================
-- 20260804210000_conversation_service_state.sql
--
-- Customer Service restructure, Phase 1a — split the overloaded
-- conversation state and make service measurable.
--
-- See docs/customer-service-workflow-study.md for the full study, and the
-- Phase 1 plan for the approved scope.
--
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────
--
-- A conversation is BORN 'closed': getOrCreateConversation inserts with
-- status='closed' so the bot answers first. An admin finishing a
-- conversation ALSO sets 'closed'. One value means both "never needed a
-- human" and "a human is done", so the state "nobody has replied to this
-- customer yet" cannot be represented — and therefore cannot be queued,
-- counted, filtered or alerted on.
--
-- ── THE MODEL ────────────────────────────────────────────────────────────
--
--   bot_active        bot is handling it; no human needed yet. HIDDEN from
--                     the admin queue by decision — the waiting count must
--                     mean exactly one thing.
--   waiting           a human is needed. THE QUEUE.
--   open              an admin has replied and is engaged.
--   waiting_customer  we answered and asked something; their turn.
--   resolved          done. Reopens automatically if they write again.
--
-- `escalated` is a FLAG, not a state: it answers "how urgent", while status
-- answers "whose turn". Collapsing the two is what produced the original
-- defect.
--
-- ── SAFETY PROPERTY ──────────────────────────────────────────────────────
--
-- Nothing in this migration may move a conversation OUT of 'waiting' except
-- an admin actually replying. The auto-resolve sweep below deliberately
-- excludes 'waiting' for that reason: a rule that silently clears customers
-- who need a human would recreate the exact bug this phase exists to fix.
-- ============================================================


-- ============================================================
-- 1. Widen the CHECK constraint FIRST
--
-- Ordering matters: the constraint must accept the new values before any
-- application code writes one. Old values remain valid until step 3
-- rewrites them, so this migration is safe to apply under a live inbox.
-- ============================================================

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_status_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN (
    -- new vocabulary
    'bot_active', 'waiting', 'open', 'waiting_customer', 'resolved',
    -- legacy values, tolerated only between this step and step 3
    'closed', 'waiting_admin'
  ));


-- ============================================================
-- 2. Service columns
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS escalated                BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS first_response_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at              TIMESTAMPTZ,
  -- NULL is the honest default: "we do not know whether the bot helped".
  -- Populated later by the customer-facing thumbs up/down (Phase 2b).
  ADD COLUMN IF NOT EXISTS bot_resolved             BOOLEAN;

COMMENT ON COLUMN public.conversations.escalated IS
  'Bot matched an escalation pattern, or the customer asked for a human. A flag, not a state.';
COMMENT ON COLUMN public.conversations.first_response_at IS
  'First admin message in this conversation. Set once, server-side; never rewritten.';
COMMENT ON COLUMN public.conversations.bot_resolved IS
  'NULL = unknown. TRUE/FALSE only once the customer answers the thumbs prompt.';


-- ============================================================
-- 3. Backfill
--
-- The mapping for 'closed' turns on WHO SPOKE LAST, which is the only
-- evidence the schema retained:
--
--   last message from customer -> 'waiting'     a human never answered them.
--                                               These are the buried ones;
--                                               resurfacing them is the point.
--   last message from admin    -> 'resolved'    an admin finished the job.
--   last message from bot      -> 'bot_active'  the bot answered and no human
--                                               was ever asked for. Ambiguous
--                                               by construction (see Finding 4)
--                                               and NOT queue-worthy under the
--                                               approved model.
--   no messages at all         -> 'bot_active'  opened, never used.
-- ============================================================

WITH last_sender AS (
  SELECT DISTINCT ON (conversation_id)
         conversation_id, sender_role, created_at
    FROM public.chat_messages
   ORDER BY conversation_id, created_at DESC
)
UPDATE public.conversations c
   SET status = CASE
         WHEN c.status = 'open'          THEN 'open'
         WHEN c.status = 'waiting_admin' THEN 'waiting'
         WHEN l.sender_role = 'customer' THEN 'waiting'
         WHEN l.sender_role = 'admin'    THEN 'resolved'
         ELSE 'bot_active'
       END
  FROM (SELECT id FROM public.conversations) AS ids
  LEFT JOIN last_sender l ON l.conversation_id = ids.id
 WHERE c.id = ids.id;


-- Timestamps reconstructed from message history. This is the last moment
-- these can be recovered — from here the trigger maintains them live.
UPDATE public.conversations c
   SET first_response_at = (
         SELECT MIN(created_at) FROM public.chat_messages
          WHERE conversation_id = c.id AND sender_role = 'admin'
       ),
       last_customer_message_at = (
         SELECT MAX(created_at) FROM public.chat_messages
          WHERE conversation_id = c.id AND sender_role = 'customer'
       ),
       resolved_at = CASE
         WHEN c.status = 'resolved' THEN (
           SELECT MAX(created_at) FROM public.chat_messages
            WHERE conversation_id = c.id AND sender_role = 'admin'
         )
         ELSE NULL
       END;


-- Now that every row speaks the new vocabulary, drop the legacy values.
ALTER TABLE public.conversations
  DROP CONSTRAINT conversations_status_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('bot_active', 'waiting', 'open', 'waiting_customer', 'resolved'));


-- ============================================================
-- 4. Keep it honest server-side
--
-- Same principle as update_order_payment_totals: derived values are
-- computed by the database, never written by a client. A customer cannot
-- fake a response time — guard_chat_message_insert already overwrites
-- sender_id and sender_role from auth.uid() before this trigger sees the
-- row, so sender_role here is trustworthy.
--
-- SECURITY DEFINER is required, not decorative: a customer's INSERT must
-- update a conversations row they do not own.
-- ============================================================

CREATE OR REPLACE FUNCTION public.maintain_conversation_service_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_role = 'customer' THEN
    UPDATE public.conversations
       SET last_customer_message_at = NEW.created_at,
           -- An unanswered customer message means a human is needed —
           -- except while the bot is still handling the thread, which is
           -- the one case where no human has been asked for.
           status = CASE
                      WHEN status = 'bot_active' THEN 'bot_active'
                      ELSE 'waiting'
                    END,
           resolved_at = NULL
     WHERE id = NEW.conversation_id;

  ELSIF NEW.sender_role = 'admin' THEN
    UPDATE public.conversations
       SET first_response_at = COALESCE(first_response_at, NEW.created_at),
           status = CASE
                      WHEN status IN ('waiting', 'bot_active') THEN 'open'
                      ELSE status
                    END
     WHERE id = NEW.conversation_id;
  END IF;

  -- sender_role = 'bot' deliberately changes nothing: a bot reply is not a
  -- response for service purposes, and must not clear the queue.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_maintain_service_state ON public.chat_messages;
CREATE TRIGGER chat_messages_maintain_service_state
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.maintain_conversation_service_state();


-- ============================================================
-- 5. Stamp resolved_at from the status transition itself
--
-- So it is correct however the row got there — admin action, RPC, or the
-- nightly sweep below.
-- ============================================================

CREATE OR REPLACE FUNCTION public.stamp_conversation_resolved_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN
    NEW.resolved_at := COALESCE(NEW.resolved_at, now());
  ELSIF NEW.status <> 'resolved' THEN
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_stamp_resolved_at ON public.conversations;
CREATE TRIGGER conversations_stamp_resolved_at
  BEFORE UPDATE OF status ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_conversation_resolved_at();


-- ============================================================
-- 6. Auto-resolve after 7 days of customer silence
--
-- Approved rule. Safe because of the auto-reopen edge in step 4: if the
-- customer writes again, the conversation returns to 'waiting' and they
-- get their thread back.
--
-- 'waiting' is EXCLUDED, and that exclusion is the load-bearing part of
-- this function. A conversation where a human is still needed must never
-- be cleared by a timer — that is precisely the failure this phase exists
-- to eliminate. 'bot_active' is also left alone: it is the customer's
-- persistent thread, not a task.
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
     WHERE status IN ('open', 'waiting_customer')
       AND COALESCE(last_customer_message_at, created_at) < now() - interval '7 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM swept;

  RETURN v_count;
END;
$$;

-- Cron runs as postgres; no client role should call this directly.
REVOKE EXECUTE ON FUNCTION public.auto_resolve_stale_conversations() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-resolve-stale-conversations') THEN
    PERFORM cron.unschedule('auto-resolve-stale-conversations');
  END IF;
END;
$$;

SELECT cron.schedule(
  'auto-resolve-stale-conversations',
  '30 3 * * *',   -- 03:30 daily, half an hour after the activity-log purge
  $$SELECT public.auto_resolve_stale_conversations()$$
);


-- ============================================================
-- VERIFY (run manually after applying):
--
--   -- Every row on the new vocabulary, nothing stranded
--   SELECT status, COUNT(*) FROM conversations GROUP BY status;
--
--   -- The buried conversations are back in the queue
--   SELECT id, status, last_customer_message_at
--     FROM conversations WHERE status = 'waiting';
--
--   -- Auto-reopen: resolve one, insert a customer message, confirm 'waiting'
--   -- Sweep is a no-op on 'waiting':
--   SELECT public.auto_resolve_stale_conversations();
--
-- ROLLBACK:
--   DROP TRIGGER chat_messages_maintain_service_state ON chat_messages;
--   DROP TRIGGER conversations_stamp_resolved_at ON conversations;
--   SELECT cron.unschedule('auto-resolve-stale-conversations');
--   UPDATE conversations SET status = CASE
--     WHEN status IN ('bot_active','resolved') THEN 'closed'
--     WHEN status = 'waiting' THEN 'waiting_admin'
--     ELSE 'open' END;
--   ALTER TABLE conversations DROP CONSTRAINT conversations_status_check;
--   ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
--     CHECK (status IN ('open','closed','waiting_admin'));
--   -- The added columns can stay; they are harmless when unused.
-- ============================================================
