-- ============================================================
-- 20260807140000_reopen_grace_window.sql
--
-- Adds a 12-HOUR GRACE WINDOW to the reopen rule from 20260807120000.
--
-- A customer writing into a RESOLVED thread now splits two ways:
--
--   resolved ≤12h ago              → 'waiting'     a FOLLOW-UP, to a human
--   resolved >12h ago, or NULL     → 'bot_active'  a NEW session, unassigned
--
-- ── WHY THIS IS A SEPARATE MIGRATION ─────────────────────────────────────
--
-- 20260807120000 is already applied. Editing it in place would not reach any
-- database that has recorded that version — `supabase db push` skips versions
-- present in supabase_migrations.schema_migrations — so the change would look
-- committed and silently never ship. New behaviour, new file.
--
-- ── WHY A WINDOW AT ALL ──────────────────────────────────────────────────
--
-- conversations has a UNIQUE constraint on customer_id: one row per customer,
-- forever. So the resolved thread is not a ticket that ages out — it is the
-- ONLY thread that customer will ever have, and 20260807120000 reopened it
-- unconditionally. A customer coming back three weeks later to ask "magkano
-- per kilo?" therefore landed in the admin queue because of a ticket closed
-- weeks earlier that has nothing to do with the question. That is a question
-- the bot answers in one second, and the bot had become unreachable for the
-- rest of that customer's life.
--
-- The window separates the two cases the single row conflates:
--
--   within 12h  → almost certainly a FOLLOW-UP to what was just resolved. The
--                 admin who handled it still has the context; the bot does not.
--   after 12h   → almost certainly a NEW question. Bot first, exactly as for
--                 any new conversation, with the escalation patterns handing
--                 over if it cannot help.
--
-- This keeps what E2E caught — a follow-up is never answered by a contextless
-- bot while the admin hears nothing — without stranding the bot.
--
-- NULL resolved_at routes with the >12h case, and that is the honest reading
-- rather than a fallback: stamp_conversation_resolved_at has stamped every
-- transition into 'resolved' since 20260804240000, so a NULL here belongs to a
-- row resolved before that trigger existed — old by definition. A missing
-- timestamp is never read as "just now".
--
-- ── WHAT EACH BRANCH DOES TO THE REST OF THE ROW ─────────────────────────
--
-- REOPEN (≤12h): `assigned_admin_id` untouched, so the follow-up returns to the
-- admin who resolved it rather than to an unassigned queue slot.
--
-- NEW SESSION (>12h): `assigned_admin_id` cleared — the old assignee owned a
-- closed issue, and leaving them on it parks an unrelated question in their
-- name while claiming a human is already handling a thread the bot now holds.
-- `escalated` is cleared for the same reason: it is a live urgency flag, and
-- carrying "urgent" over from an issue closed days ago mis-sorts the queue the
-- moment this session escalates for real. Nothing is lost — the transcript
-- keeps the history, and an escalation pattern in the new message re-raises it.
--
-- The clearing is confined to the resolved → bot_active hand-off. A thread
-- ALREADY in 'bot_active' keeps its assignment: if an admin has claimed it,
-- silently dropping that is not this trigger's business.
--
-- BOTH: `resolved_at` cleared — the thread is no longer resolved, so a
-- resolution timestamp on it would be a lie. (stamp_conversation_resolved_at
-- would do this anyway; explicit keeps the branch readable.)
--
-- `bot_resolved` is deliberately NOT cleared. It records whether the bot
-- deflected the LAST question and it feeds the customer-service report;
-- nulling it would delete a real measurement to make room for one that has not
-- happened yet.
-- ============================================================

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
                -- Resolved within the grace window: a FOLLOW-UP. It belongs to
                -- the admin who just handled it, not to a bot that cannot see
                -- the thread it is continuing.
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

    -- True only for the resolved → bot_active hand-off. A thread ALREADY in
    -- bot_active is left alone: if an admin has claimed it, silently dropping
    -- their assignment is not this trigger's business.
    v_new_session := (v_status = 'resolved' AND v_next = 'bot_active');

    UPDATE public.conversations
       SET last_customer_message_at = NEW.created_at,
           status            = v_next,
           assigned_admin_id = CASE WHEN v_new_session THEN NULL ELSE assigned_admin_id END,
           escalated         = CASE WHEN v_new_session THEN FALSE ELSE escalated END,
           resolved_at       = NULL
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
-- VERIFY — both sides of the window, as the customer owning :cid.
-- Set the status as a NON-customer role first: guard_conversation_update
-- correctly refuses a customer setting 'resolved', so a test that impersonates
-- them too early silently never resolves the thread and every case returns
-- 'waiting'.
--
-- A. FOLLOW-UP (resolved 1 hour ago):
--
--   UPDATE conversations SET status = 'resolved' WHERE id = :cid;
--   UPDATE conversations SET resolved_at = now() - interval '1 hour' WHERE id = :cid;
--   -- then, as the customer:
--   INSERT INTO chat_messages (conversation_id, sender_id, sender_role, message)
--   VALUES (:cid, :customer_id, 'customer', 'I have one more question');
--
--   SELECT status, resolved_at, assigned_admin_id FROM conversations WHERE id = :cid;
--   -- expect: 'waiting', resolved_at NULL, assigned_admin_id UNCHANGED
--
-- B. NEW SESSION (resolved 3 days ago, same shape, resolved_at = now() - '3 days'):
--   -- expect: 'bot_active', resolved_at NULL, assigned_admin_id NULL,
--   --         escalated FALSE
--
-- C. Boundary: now() - interval '11 hours 59 minutes' → 'waiting'
--              now() - interval '12 hours  1 minute'  → 'bot_active'
--              resolved_at IS NULL                    → 'bot_active'
-- ============================================================
