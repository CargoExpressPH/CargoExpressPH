-- ============================================================
-- 20260804190000_function_privileges.sql
--
-- CRITICAL — revoke public EXECUTE on the payment reconciliation RPC.
--
-- ── THE HOLE ─────────────────────────────────────────────────────────────
--
-- schema.sql contains:
--
--     GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(...)
--       TO service_role;
--
-- and CLAUDE.md documents the RPC as "granted to service_role alone". That
-- was never true. PostgreSQL grants EXECUTE on every new function to PUBLIC
-- by default; adding a GRANT does not remove it. Verified on the live
-- database before this migration:
--
--     has_function_privilege('anon', 'public.reconcile_paymongo_payment_attempt(...)', 'EXECUTE')
--     => true
--
-- The function is SECURITY DEFINER. It writes payment_transactions, updates
-- orders, and sets the order status to 'Picked Up'. Reachable by `anon`, it
-- is a direct payment-forgery path: anyone holding a source id — which is
-- embedded in the GCash checkout URL the admin displays as a QR code at the
-- counter — could POST to /rest/v1/rpc/reconcile_paymongo_payment_attempt
-- with an amount of their choosing and have a shipment marked paid without
-- money ever moving.
--
-- This bypasses every control added to the edge functions, because it skips
-- the edge functions entirely. It is the single most severe finding of the
-- audit.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
--
--   1. Actually revoke it. Only service_role (the edge functions) may call it.
--   2. Same treatment for reassign_trip, which is admin-gated internally but
--      has no business being callable by anon.
--   3. Pin search_path on the SECURITY DEFINER functions that lack it. A
--      mutable search_path lets a caller who can create objects shadow an
--      unqualified reference inside a definer function and have it run with
--      the owner's privileges. ALTER FUNCTION sets this without touching the
--      bodies.
--
-- Trigger functions (prepare_order_insert, guard_*, handle_new_user, …) are
-- deliberately left alone. PostgreSQL checks EXECUTE on a trigger function
-- when the trigger is CREATED, not when it fires, and calling one directly
-- fails with "trigger functions can only be called as triggers" — so the
-- advisor warnings on those are noise, and revoking risks breaking a future
-- CREATE TRIGGER for no security gain.
-- ============================================================


-- ============================================================
-- 1. The payment reconciliation RPC — service_role only, for real this time
-- ============================================================

REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, NUMERIC, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, NUMERIC, TEXT)
  TO service_role;


-- ============================================================
-- 2. Admin trip reassignment — not for anonymous callers
-- ============================================================

REVOKE ALL ON FUNCTION public.reassign_trip(UUID, UUID, TEXT)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.reassign_trip(UUID, UUID, TEXT)
  TO authenticated;


-- ============================================================
-- 3. Pin search_path on SECURITY DEFINER functions that lack it
-- ============================================================

ALTER FUNCTION public.reassign_trip(UUID, UUID, TEXT)          SET search_path = public;
ALTER FUNCTION public.update_order_payment_totals()            SET search_path = public;

-- Not SECURITY DEFINER, so not an escalation vector — pinned anyway so the
-- advisor report stays empty and the next real finding is not lost in noise.
ALTER FUNCTION public.mask_name(TEXT)                          SET search_path = public;
ALTER FUNCTION public.safe_uuid(TEXT)                          SET search_path = public;
ALTER FUNCTION public.update_updated_at()                      SET search_path = public;


-- ============================================================
-- VERIFY (run manually — all three must be false):
--
--   SELECT
--     has_function_privilege('anon','public.reconcile_paymongo_payment_attempt(text,text,numeric,text)','EXECUTE'),
--     has_function_privilege('authenticated','public.reconcile_paymongo_payment_attempt(text,text,numeric,text)','EXECUTE'),
--     has_function_privilege('anon','public.reassign_trip(uuid,uuid,text)','EXECUTE');
--
-- Then confirm payments still reconcile end to end: the edge functions use
-- the service-role key and are unaffected.
-- ============================================================
