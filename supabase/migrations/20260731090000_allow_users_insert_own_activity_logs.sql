-- ======================================================================
-- 20260731090000_allow_users_insert_own_activity_logs.sql
--
-- Allow any authenticated user (customers included) to insert activity
-- log rows for themselves. The client always sets admin_id = auth.uid(),
-- so this policy prevents spoofing logs on behalf of other users while
-- letting customer actions (login, booking) be recorded.
-- Admin-only SELECT remains unchanged; logs stay immutable (no UPDATE/DELETE).
-- ======================================================================

CREATE POLICY "Users can insert their own activity logs" ON public.activity_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (admin_id = auth.uid());
