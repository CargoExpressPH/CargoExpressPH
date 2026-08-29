-- ============================================================================
-- Enforce claim ownership on resolving a contact inquiry.
--
-- THE GAP
--
-- "Admins can update contact inquiries" gates every UPDATE to `is_admin()`
-- only. assignInquiry()/unassignInquiry() add their own WHERE clauses
-- (assigned_admin_id IS NULL / = auth.uid()) so claiming/releasing is race-
-- safe, but nothing stops any admin from moving ANY inquiry's status
-- straight to 'resolved' -- including one another admin has already
-- claimed. The whole point of claiming is that exactly one admin is
-- answerable for an inquiry; letting anyone resolve it out from under the
-- claimant defeats that.
--
-- THE FIX
--
-- A BEFORE UPDATE trigger, not a WITH CHECK rewrite. RLS's WITH CHECK only
-- sees the NEW row, so an expression like
-- "NEW.status = 'resolved' -> NEW.assigned_admin_id = auth.uid()" would also
-- forbid releasing a claim (assigned_admin_id -> NULL) on an inquiry that is
-- ALREADY resolved -- a legitimate, currently-working action with no
-- ownership concern of its own. A trigger sees both OLD and NEW, so it can
-- gate only the one moment that matters: the transition INTO 'resolved'.
-- Scoped to UPDATE OF status, same as stamp_inquiry_service_state, so a
-- plain claim/release (which never touches status) never fires it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_contact_inquiry_resolve_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN
    IF NEW.assigned_admin_id IS NULL THEN
      RAISE EXCEPTION 'Claim this inquiry before marking it resolved.' USING ERRCODE = '42501';
    ELSIF NEW.assigned_admin_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Only the admin who claimed this inquiry can mark it resolved.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_contact_inquiry_resolve_ownership() IS
  'Blocks moving a contact inquiry to status=resolved unless assigned_admin_id already equals the caller -- i.e. they claimed it first via assignInquiry() in src/lib/database.js.';

DROP TRIGGER IF EXISTS contact_inquiries_guard_resolve_ownership ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_guard_resolve_ownership
  BEFORE UPDATE OF status ON public.contact_inquiries
  FOR EACH ROW EXECUTE FUNCTION guard_contact_inquiry_resolve_ownership();
