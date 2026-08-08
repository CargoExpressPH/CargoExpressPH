-- ============================================================
-- 20260808150000_remove_chat_assignment.sql
--
-- Support chat becomes a SHARED INBOX. `conversations.assigned_admin_id` is
-- dropped: any admin may reply to any thread at any time, and no reply locks
-- the ticket to whoever sent it.
--
-- Why the column existed and why it goes: ownership was introduced so that
-- somebody was answerable for a thread and two admins could not answer the
-- same person at once. With a two-person team that guarantee cost more than
-- it bought — a thread claimed by whoever happened to open it first read as
-- "not mine" to the other admin, and the auto-claim on first reply meant the
-- lock was applied by the act of helping. Attribution is what was actually
-- wanted, and attribution is already in the data: every chat_messages row
-- carries sender_id. The admin UI now labels each reply with the sender's
-- name instead of labelling the whole conversation with an owner.
--
-- `contact_inquiries.assigned_admin_id` is DELIBERATELY untouched. Inquiries
-- keep their own page and their own ownership model (20260804230000); only
-- support chat becomes shared.
--
-- Three objects reference the column and are recreated here without it:
--   maintain_conversation_service_state  (cleared it on a new bot session)
--   guard_conversation_update            (reverted a customer's write to it)
--   get_service_summary                  (reported a queue.unassigned count)
-- Dropping a column does not fail a function that reads it — the function
-- breaks at CALL time. All three are therefore rewritten in this same
-- transaction, before the DROP can be observed by anything.
-- ============================================================

BEGIN;

-- ── 1. The service-state trigger ────────────────────────────────────────────
-- Unchanged in every respect except assignment: the 12-hour reopen grace
-- window (20260807140000) still routes a follow-up to 'waiting' and an old
-- thread to 'bot_active'. What a new session no longer has to clear is an
-- owner; `escalated` is still cleared, because urgency belonged to the closed
-- issue just as ownership did.
CREATE OR REPLACE FUNCTION public.maintain_conversation_service_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
                -- Resolved within the grace window → a FOLLOW-UP, to a human.
                WHEN v_status = 'resolved'
                     AND v_resolved_at IS NOT NULL
                     AND v_resolved_at >= now() - INTERVAL '12 hours'
                  THEN 'waiting'
                -- Resolved longer ago, or at an unknown time → a NEW session.
                WHEN v_status = 'resolved' THEN 'bot_active'
                -- waiting / waiting_customer: already ours, stays ours.
                ELSE 'waiting'
              END;

    -- Only the resolved → bot_active hand-off.
    v_new_session := (v_status = 'resolved' AND v_next = 'bot_active');

    UPDATE public.conversations
       SET last_customer_message_at = NEW.created_at,
           status      = v_next,
           escalated   = CASE WHEN v_new_session THEN FALSE ELSE escalated END,
           resolved_at = NULL
     WHERE id = NEW.conversation_id;

  ELSIF NEW.sender_role = 'admin' THEN
    -- An admin replying IS the signal that we are waiting on the customer.
    UPDATE public.conversations
       SET first_response_at = COALESCE(first_response_at, NEW.created_at),
           status = 'waiting_customer'
     WHERE id = NEW.conversation_id;
  END IF;

  PERFORM set_config('app.conversation_service_write', 'off', true);
  RETURN NEW;
END;
$$;

-- ── 2. The customer write guard ─────────────────────────────────────────────
-- One line fewer. Everything a customer still may not write is still reverted;
-- there is simply no assignment left to point at an admin.
CREATE OR REPLACE FUNCTION public.guard_conversation_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
  NEW.first_response_at        := OLD.first_response_at;
  NEW.last_customer_message_at := OLD.last_customer_message_at;
  NEW.resolved_at              := OLD.resolved_at;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'waiting' THEN
    NEW.status := OLD.status;
  END IF;

  IF NEW.escalated IS DISTINCT FROM OLD.escalated AND NEW.escalated = FALSE THEN
    NEW.escalated := OLD.escalated;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Service reporting ────────────────────────────────────────────────────
-- `queue.unassigned` is removed rather than zeroed. A shared inbox has no
-- unassigned count — every open thread is everyone's — and reporting a
-- constant 0 would read as "nothing is unowned" instead of "the question no
-- longer applies". `inquiries.unassigned` stays: contact_inquiries keeps its
-- ownership model.
CREATE OR REPLACE FUNCTION public.get_service_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  WITH
  -- Every customer message paired with the next admin reply, if any.
  asked AS (
    SELECT m.id, m.conversation_id, m.created_at AS asked_at,
           (SELECT MIN(a.created_at)
              FROM public.chat_messages a
             WHERE a.conversation_id = m.conversation_id
               AND a.sender_role = 'admin'
               AND a.created_at > m.created_at) AS answered_at
      FROM public.chat_messages m
     WHERE m.sender_role = 'customer'
  ),
  waits AS (
    SELECT EXTRACT(EPOCH FROM (answered_at - asked_at)) / 60.0 AS minutes
      FROM asked
     WHERE answered_at IS NOT NULL
  ),
  response AS (
    SELECT jsonb_build_object(
      'customerMessages',   (SELECT COUNT(*) FROM asked),
      'answered',           (SELECT COUNT(*) FROM asked WHERE answered_at IS NOT NULL),
      'neverAnswered',      (SELECT COUNT(*) FROM asked WHERE answered_at IS NULL),
      'medianMinutes',      (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY minutes)::numeric, 1) FROM waits),
      'p90Minutes',         (SELECT ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY minutes)::numeric, 1) FROM waits),
      'worstMinutes',       (SELECT ROUND(MAX(minutes)::numeric, 1) FROM waits)
    ) AS value
  ),
  queue AS (
    SELECT jsonb_build_object(
      'total',            COUNT(*),
      'botActive',        COUNT(*) FILTER (WHERE status = 'bot_active'),
      'waiting',          COUNT(*) FILTER (WHERE status = 'waiting'),
      'waitingCustomer',  COUNT(*) FILTER (WHERE status = 'waiting_customer'),
      'resolved',         COUNT(*) FILTER (WHERE status = 'resolved'),
      'escalated',        COUNT(*) FILTER (WHERE escalated),
      'waitingOver24h',   COUNT(*) FILTER (
                            WHERE status = 'waiting'
                              AND COALESCE(last_customer_message_at, created_at) < now() - interval '24 hours'),
      'oldestWaitHours',  COALESCE(ROUND(MAX(
                            CASE WHEN status = 'waiting'
                                 THEN EXTRACT(EPOCH FROM (now() - COALESCE(last_customer_message_at, created_at))) / 3600.0
                            END)::numeric, 1), 0)
    ) AS value
    FROM public.conversations
  ),
  -- Bot deflection. NULL is reported as its own bucket rather than folded
  -- into a denominator: "we never asked" is not the same as "it failed".
  bot AS (
    SELECT jsonb_build_object(
      'helped',    COUNT(*) FILTER (WHERE bot_resolved IS TRUE),
      'notHelped', COUNT(*) FILTER (WHERE bot_resolved IS FALSE),
      'unknown',   COUNT(*) FILTER (WHERE bot_resolved IS NULL),
      'answered',  (SELECT COUNT(*) FROM public.chat_messages WHERE sender_role = 'bot')
    ) AS value
    FROM public.conversations
  ),
  inquiries AS (
    SELECT jsonb_build_object(
      'total',      COUNT(*),
      'new',        COUNT(*) FILTER (WHERE status = 'new'),
      'read',       COUNT(*) FILTER (WHERE status = 'read'),
      'resolved',   COUNT(*) FILTER (WHERE status = 'resolved'),
      'unassigned', COUNT(*) FILTER (WHERE status <> 'resolved' AND assigned_admin_id IS NULL),
      'measured',   COUNT(*) FILTER (WHERE first_response_at IS NOT NULL),
      'medianResponseMinutes', ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60.0
      ) FILTER (WHERE first_response_at IS NOT NULL)::numeric, 1)
    ) AS value
    FROM public.contact_inquiries
  ),
  volume AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.week), '[]'::jsonb) AS value
    FROM (
      SELECT TO_CHAR(DATE_TRUNC('week', created_at), 'YYYY-MM-DD') AS week,
             COUNT(*) FILTER (WHERE sender_role = 'customer') AS customer_msgs,
             COUNT(*) FILTER (WHERE sender_role = 'admin')    AS admin_msgs,
             COUNT(*) FILTER (WHERE sender_role = 'bot')      AS bot_msgs
        FROM public.chat_messages
       WHERE created_at > now() - interval '12 weeks'
       GROUP BY DATE_TRUNC('week', created_at)
    ) v
  ),
  -- Demand by hour, Asia/Manila. Staffing information: it says when
  -- customers actually write, which is not necessarily when anyone is
  -- looking.
  hourly AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.hour), '[]'::jsonb) AS value
    FROM (
      SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Manila')::int AS hour,
             COUNT(*) AS customer_msgs
        FROM public.chat_messages
       WHERE sender_role = 'customer'
       GROUP BY 1
    ) h
  )
  SELECT jsonb_build_object(
    'response',  response.value,
    'queue',     queue.value,
    'bot',       bot.value,
    'inquiries', inquiries.value,
    'volume',    volume.value,
    'hourly',    hourly.value,
    'generatedAt', to_jsonb(now())
  )
  INTO payload
  FROM response, queue, bot, inquiries, volume, hourly;

  RETURN payload;
END;
$$;

REVOKE ALL ON FUNCTION public.get_service_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_service_summary() TO authenticated;

-- ── 4. The column ───────────────────────────────────────────────────────────
-- No index or constraint depends on it beyond its own FK, which DROP COLUMN
-- removes with it. Support chat is a shared inbox from here.
ALTER TABLE public.conversations
  DROP COLUMN IF EXISTS assigned_admin_id;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'conversations' AND column_name = 'assigned_admin_id';
--   -- expect: 0 rows
--
--   -- The trigger still routes correctly with no assignment to carry:
--   INSERT INTO chat_messages (conversation_id, sender_id, sender_role, message)
--   VALUES (:cid, :customer_id, 'customer', 'follow-up');
--   SELECT status, resolved_at FROM conversations WHERE id = :cid;
--   -- expect: 'waiting' if resolved ≤12h ago, else 'bot_active'; resolved_at NULL
--
--   SELECT public.get_service_summary() -> 'queue';
--   -- expect: no 'unassigned' key, every other key present
