-- =====================================================================
-- Migration: Create RPC function for admin notifications
-- Allows non-admin users (customers / guests) to trigger notifications for admins
-- Bypass RLS using SECURITY DEFINER
-- =====================================================================

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
