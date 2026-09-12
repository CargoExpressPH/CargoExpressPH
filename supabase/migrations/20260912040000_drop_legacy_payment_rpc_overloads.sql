-- ============================================================
-- F-008 — drop stale legacy payment RPC overloads.
--
-- Root cause (see audit_reports/F-008-legacy-payment-rpc-overload-cleanup-plan.md):
-- Postgres resolves overloads by full signature. Every hardening pass to
-- record_pickup_payment()/record_delivery_payment() added trailing
-- parameters via CREATE OR REPLACE, which Postgres treats as a NEW function
-- rather than a true replacement whenever the argument list changes. No
-- migration ever issued a matching DROP FUNCTION for the superseded
-- signatures, so three old record_pickup_payment overloads (12-arg, 14-arg)
-- and one old record_delivery_payment overload (10-arg) remain deployed,
-- SECURITY DEFINER, and GRANTed to `authenticated` alongside the current
-- signatures — reachable by any admin session via a direct RPC call that
-- bypasses the current frontend, skipping every protection added since:
-- discount-aware balance math (F-002/F-004), idempotency, manual-GCash
-- verification, and the cash-after-pickup restriction.
--
-- record_additional_payment is NOT touched here: both of its historical
-- definitions (20260909030000, 20260912010000) share the identical 9-arg
-- signature, so CREATE OR REPLACE genuinely replaced it each time — it has
-- never had this problem.
--
-- Signatures below are copied verbatim from each retiring migration's own
-- REVOKE/GRANT statement (the authoritative record of what was actually
-- created), not reconstructed from memory, to avoid the exact-signature
-- typo risk the original 20260911030000 migration cited as its reason for
-- deferring this cleanup:
--   - record_delivery_payment(10-arg): REVOKE/GRANT in 20260828120000
--   - record_pickup_payment(12-arg):  REVOKE/GRANT in 20260803100000
--   - record_pickup_payment(14-arg):  REVOKE/GRANT in 20260909030000
--
-- Confirmed via repo-wide grep before writing this migration that no current
-- frontend code, Edge Function, or script calls any of these three retired
-- signatures — src/lib/database.js only ever sends every parameter the
-- CURRENT signature defines (17-arg pickup, 12-arg delivery), so PostgREST
-- can only ever resolve those calls to the current functions.
-- ============================================================

-- record_delivery_payment — 10-arg legacy signature (20260828120000),
-- superseded by the 12-arg signature added in 20260909030000 and further
-- hardened in 20260912010000. Lacks idempotency, the cash-after-pickup
-- restriction, delivery-photo/lifecycle enforcement, and discount-aware
-- balance math.
DROP FUNCTION IF EXISTS public.record_delivery_payment(
  UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE
);

-- record_pickup_payment — 12-arg legacy signature (20260803100000),
-- superseded first by the 14-arg signature (20260909030000) and then the
-- current 17-arg signature (20260911030000). Lacks idempotency and manual
-- GCash-verification.
DROP FUNCTION IF EXISTS public.record_pickup_payment(
  UUID, NUMERIC, TEXT, TEXT, JSONB, DATE, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT
);

-- record_pickup_payment — 14-arg intermediate signature (20260909030000),
-- superseded by the current 17-arg signature (20260911030000). Lacks
-- discount handling.
DROP FUNCTION IF EXISTS public.record_pickup_payment(
  uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean
);

-- ============================================================
-- VERIFY (must return exactly 1 row each on any database):
--   SELECT COUNT(*) FROM pg_proc WHERE proname = 'record_pickup_payment';
--   SELECT COUNT(*) FROM pg_proc WHERE proname = 'record_delivery_payment';
-- ============================================================
