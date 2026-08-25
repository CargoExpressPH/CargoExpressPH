-- ============================================================================
-- Harden the anonymous contact-inquiry INSERT.
--
-- THE HOLE
--
-- "Anyone can submit inquiry" was `FOR INSERT TO public WITH CHECK (true)`,
-- which permits any value in any column. Since the anon key ships in the
-- browser bundle (by design — RLS is the actual gate), anyone can POST
-- straight to /rest/v1/contact_inquiries and skip the submit-inquiry Edge
-- Function entirely.
--
-- That matters because `guard_contact_inquiry_rate_limit` keys the per-IP
-- bucket on the `ip` COLUMN, which the Edge Function is supposed to be the
-- only writer of. A direct caller can send a fresh random `ip` on every
-- request and get a brand-new 5-per-10-minutes allowance each time — the
-- per-IP limit stops being a limit at all. What is left is the global
-- 15-per-minute cap, and that one is worse than nothing under attack: holding
-- the table at 15 inserts a minute makes the guard reject every REAL
-- customer's inquiry, turning our own flood protection into the denial of
-- service.
--
-- The same `WITH CHECK (true)` also let an anonymous caller set `status`,
-- `assigned_admin_id`, the `first_response_at` / `resolved_at` service
-- timestamps and the push-dispatch claim columns — writing rows that look like
-- they had already been handled by a named admin, or that suppress the push
-- that tells staff an inquiry arrived.
--
-- THE FIX
--
-- Anonymous inserts may carry the three fields the public form actually
-- collects and nothing else; every server-owned column must arrive NULL (or at
-- its default). `submit-inquiry` uses the service_role key, which bypasses RLS,
-- so it keeps setting `ip` exactly as before — the rate limit now genuinely
-- depends on an IP that only the server can write.
-- ============================================================================

DROP POLICY IF EXISTS "Anyone can submit inquiry" ON public.contact_inquiries;

CREATE POLICY "Anyone can submit inquiry" ON public.contact_inquiries
  FOR INSERT
  TO public
  WITH CHECK (
    -- Server-owned: only the Edge Function (service_role) may set these.
    ip IS NULL
    AND assigned_admin_id IS NULL
    AND first_response_at IS NULL
    AND resolved_at IS NULL
    AND push_dispatched_at IS NULL
    AND push_dispatch_started_at IS NULL
    AND push_dispatch_claim_id IS NULL
    -- A new inquiry is 'new'. Anything else is a claim about work already done.
    AND status = 'new'
  );

COMMENT ON POLICY "Anyone can submit inquiry" ON public.contact_inquiries IS
  'Public contact form. Client may supply name/phone/message/contact_* only; ip and all service-state columns are server-owned so the per-IP rate limit cannot be bypassed by forging an IP.';
