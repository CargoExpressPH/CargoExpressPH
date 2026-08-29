-- ============================================================================
-- Fully revoke the anonymous INSERT on contact_inquiries.
--
-- 20260825140000 narrowed "Anyone can submit inquiry" so a direct anon
-- caller could only leave every server-owned column (ip, assigned_admin_id,
-- status, etc.) at its default -- but the policy still let the INSERT itself
-- through, which meant a direct POST to /rest/v1/contact_inquiries could
-- skip the submit-inquiry Edge Function entirely. Skipping it leaves the ip
-- column NULL, which drops guard_contact_inquiry_rate_limit into its
-- phone-based fallback (3/10min) -- and phone is attacker-supplied free
-- text, so a script can send a new value every request and defeat that
-- limit almost completely. What's left is the 15/minute global cap, which
-- the original migration already flagged as a self-inflicted denial of
-- service under a real flood, not real protection.
--
-- There is no legitimate reason for an anon/authenticated INSERT anymore --
-- every caller in this codebase reaches this table through submit-inquiry,
-- which uses the service_role key and therefore bypasses RLS outright (see
-- createContactInquiry in src/lib/database.js). Dropping the policy with
-- nothing to replace it makes RLS's default-deny the enforcement: INSERT
-- becomes impossible for anon/authenticated, full stop, and the Edge
-- Function is unaffected.
-- ============================================================================

DROP POLICY IF EXISTS "Anyone can submit inquiry" ON public.contact_inquiries;

COMMENT ON TABLE public.contact_inquiries IS
  'Public contact inquiries. No INSERT policy is granted to anon/authenticated by design -- every submission must go through the submit-inquiry Edge Function (service_role), which validates input server-side and stamps the server-owned ip column that guard_contact_inquiry_rate_limit depends on.';
