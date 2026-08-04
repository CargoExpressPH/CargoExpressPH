-- ============================================================
-- 20260804160000_activity_log_guard.sql
--
-- Security audit fix — make activity_logs unforgeable.
--
-- THE HOLE:
--   RLS policy "Users can insert their own activity logs" allows any
--   authenticated user to INSERT with WITH CHECK (admin_id = auth.uid()).
--   That constrains WHO the row is attributed to and nothing else. Every
--   other column was free text, so a customer could POST:
--
--     { admin_id: <self>, admin_name: 'System Administrator',
--       module: 'Payments', action: 'Balance Settled',
--       details: 'Collected ₱12,000 cash' }
--
--   …and it would land in the admin's Activity Logs page looking exactly
--   like a genuine staff action. An audit trail that the audited party can
--   write to is not an audit trail.
--
-- THE FIX — same pattern as guard_chat_message_insert, which already does
-- this for chat: the server overwrites identity rather than trusting it.
--
--   * admin_id / admin_name are ALWAYS taken from auth.uid(), for everyone.
--     A forged display name is the part that makes a fake entry convincing.
--   * Non-admins are restricted to the two modules the customer app actually
--     writes: 'Orders' (booking created) and 'Authentication' (login).
--     Everything else is staff-only activity and is rejected outright.
--
-- Admin-authored rows are unaffected in every respect except that admin_name
-- is now derived rather than client-supplied — which is what it already was
-- in practice (activityLog.js reads it from the caller's own profile).
--
-- Service-role writes (auth.uid() IS NULL) pass through untouched so backend
-- jobs and RPCs can still log.
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

  IF NOT v_is_admin AND NEW.module NOT IN ('Orders', 'Authentication') THEN
    RAISE EXCEPTION 'Not allowed to write % activity logs', NEW.module;
  END IF;

  SELECT name INTO v_name FROM public.profiles WHERE id = v_uid;

  NEW.admin_id   := v_uid;
  NEW.admin_name := COALESCE(NULLIF(btrim(v_name), ''), 'Unknown Admin');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS activity_logs_guard_insert ON public.activity_logs;
CREATE TRIGGER activity_logs_guard_insert
  BEFORE INSERT ON public.activity_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_activity_log_insert();


-- ============================================================
-- 2. create_admin_notifications_rpc — close it to anonymous callers
--
-- THE HOLE:
--   The function is SECURITY DEFINER and was created with no GRANT/REVOKE, so
--   it kept PostgreSQL's default of EXECUTE TO PUBLIC — which in Supabase
--   includes the `anon` role backing the public website. It inserts a
--   caller-supplied title and message into EVERY admin's notification feed.
--
--   An unauthenticated visitor could therefore push arbitrary text to all
--   staff, in the app's own voice, as fast as they could send requests:
--   notification spam at best, a convincing internal-looking phishing lure
--   ("Payment failed — re-enter GCash credentials at …") at worst.
--
-- THE FIX:
--   Authenticated callers only. Customers legitimately trigger this when they
--   create a booking (see database.js), so `authenticated` must keep it; anon
--   has no business calling it. The auth.uid() check inside the function makes
--   that hold even if the grants are widened again later.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_admin_notifications_rpc(
  p_title TEXT,
  p_message TEXT,
  p_type TEXT,
  p_reference_id UUID DEFAULT NULL
)
RETURNS TABLE (admin_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    SELECT id, p_title, p_message, p_type, p_reference_id
    FROM public.profiles
    WHERE role = 'admin'
    RETURNING user_id
  )
  SELECT user_id FROM inserted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_admin_notifications_rpc(TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_admin_notifications_rpc(TEXT, TEXT, TEXT, UUID) TO authenticated;


-- ============================================================
-- VERIFY (run manually, as a CUSTOMER session):
--
--   -- Rejected: module is staff-only
--   INSERT INTO activity_logs (admin_id, admin_name, module, action)
--   VALUES (auth.uid(), 'System Administrator', 'Payments', 'Balance Settled');
--   -- ERROR: Not allowed to write Payments activity logs
--
--   -- Accepted, but attributed to the real person:
--   INSERT INTO activity_logs (admin_id, admin_name, module, action)
--   VALUES (auth.uid(), 'System Administrator', 'Orders', 'Booking Created')
--   RETURNING admin_name;   -- → the caller's own profile name
--
--   -- Rejected from an ANONYMOUS (logged-out) session:
--   SELECT * FROM create_admin_notifications_rpc('x', 'y', 'general');
--   -- ERROR: permission denied for function create_admin_notifications_rpc
-- ============================================================
