-- ============================================================
-- 20260804220000_fix_chat_activity_log_guard.sql
--
-- REGRESSION FIX — customers could not send chat messages.
--
-- ── WHAT BROKE ───────────────────────────────────────────────────────────
--
-- 20260804160000_activity_log_guard.sql restricted non-admin writers to the
-- modules the customer app was believed to write: 'Orders' and
-- 'Authentication'.
--
-- That list was incomplete. `log_customer_chat_message()` is an existing
-- AFTER INSERT trigger on chat_messages that logs
--
--     module = 'Chat', action = 'Customer Sent Message'
--
-- on the customer's behalf. Being SECURITY DEFINER does not help it here:
-- the guard tests auth.uid(), which is still the customer. So the guard
-- raised, the raise propagated out of the trigger, and the customer's
-- INSERT into chat_messages was aborted:
--
--     ERROR P0001: Not allowed to write Chat activity logs
--     CONTEXT: guard_activity_log_insert() line 15
--              log_customer_chat_message() line 10
--              INSERT INTO chat_messages ...
--
-- Customer-side chat was therefore broken from the moment 20260804160000
-- was applied until this migration. It went unnoticed because chat support
-- is still pre-launch; it was caught by a rollback-wrapped trigger test
-- while verifying Phase 1a, not by a user report.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
--
-- Add 'Chat' to the modules a non-admin may write. This does not weaken the
-- guard's actual purpose. The forgery that mattered was a customer writing
-- a convincing STAFF entry — and admin_id/admin_name are still overwritten
-- from auth.uid() for every writer, so a customer-authored row always shows
-- the customer's own name. Restricting the module list was defence in
-- depth; identity forcing is the control.
--
-- ── LESSON RECORDED ──────────────────────────────────────────────────────
--
-- The allow-list was derived by grepping the CLIENT for logActivity calls.
-- It missed a writer that lives in a DATABASE TRIGGER. Any future narrowing
-- of this list must enumerate server-side writers too:
--
--     SELECT p.proname
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND pg_get_functiondef(p.oid) ILIKE '%activity_logs%';
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_activity_log_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_name     TEXT;
BEGIN
  -- Service role / trigger-internal writes: nothing to attribute, leave as-is.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.is_admin();

  -- 'Chat' is written by the log_customer_chat_message() trigger on the
  -- customer's behalf — see the header. Omitting it broke customer chat.
  IF NOT v_is_admin AND NEW.module NOT IN ('Orders', 'Authentication', 'Chat') THEN
    RAISE EXCEPTION 'Not allowed to write % activity logs', NEW.module;
  END IF;

  SELECT name INTO v_name FROM public.profiles WHERE id = v_uid;

  -- The control that actually matters: a customer-authored row can never
  -- carry a staff identity, whatever module it claims.
  NEW.admin_id   := v_uid;
  NEW.admin_name := COALESCE(NULLIF(btrim(v_name), ''), 'Unknown Admin');

  RETURN NEW;
END;
$$;


-- ============================================================
-- VERIFY — as a CUSTOMER session, this must now succeed:
--
--   INSERT INTO chat_messages (conversation_id, sender_id, sender_role, message)
--   VALUES ('<own conversation>', auth.uid(), 'customer', 'test');
--
-- And this must still be rejected:
--
--   INSERT INTO activity_logs (admin_id, admin_name, module, action)
--   VALUES (auth.uid(), 'System Administrator', 'Payments', 'Balance Settled');
--   -- ERROR: Not allowed to write Payments activity logs
-- ============================================================
