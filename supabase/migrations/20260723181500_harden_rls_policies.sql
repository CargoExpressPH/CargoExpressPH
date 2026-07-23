-- ======================================================================
-- 20260723181500_harden_rls_policies.sql
--
-- Security Hardening:
--   1. Restrict company_information ALL policy strictly to public.is_admin()
--      (previously checked auth.role() = 'authenticated', allowing customer updates).
--   2. Restrict activity_logs INSERT policy strictly to public.is_admin()
--      (previously allowed WITH CHECK (true) for authenticated users).
-- ======================================================================

-- 1. Fix company_information RLS policy
DROP POLICY IF EXISTS "Allow admin full access" ON public.company_information;

CREATE POLICY "Allow admin full access" ON public.company_information
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 2. Fix activity_logs RLS policy
DROP POLICY IF EXISTS "Authenticated users can insert activity logs" ON public.activity_logs;
DROP POLICY IF EXISTS "Admins can insert activity logs" ON public.activity_logs;

CREATE POLICY "Admins can insert activity logs" ON public.activity_logs
  FOR INSERT
  WITH CHECK (public.is_admin());
