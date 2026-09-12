-- Announcements are shown only inside authenticated Customer/Admin routes.
-- The previous TO public policy exposed every column of every announcement to
-- the anon role, including inactive rows and comment author UUIDs, even though
-- no public page consumes this table.

BEGIN;

DROP POLICY IF EXISTS "Anyone can view announcements" ON public.announcements;
DROP POLICY IF EXISTS "Authenticated users can view announcements" ON public.announcements;

CREATE POLICY "Authenticated users can view announcements"
  ON public.announcements
  FOR SELECT
  TO authenticated
  USING (true);

COMMIT;
