-- Email-only announcement rows exist solely to drive and audit subscriber
-- email delivery. Customer-facing reads must remain limited to public rows;
-- the existing admin management policy continues to grant admins full access.

BEGIN;

DROP POLICY IF EXISTS "Authenticated users can view announcements"
  ON public.announcements;

CREATE POLICY "Authenticated users can view announcements"
  ON public.announcements
  FOR SELECT
  TO authenticated
  USING (audience = 'public');

COMMENT ON POLICY "Authenticated users can view announcements"
  ON public.announcements IS
  'Authenticated customers can read public announcements; the separate admin policy grants admins access to all audiences.';

COMMIT;
