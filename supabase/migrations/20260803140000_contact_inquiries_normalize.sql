-- ============================================================
-- 20260803140000_contact_inquiries_normalize.sql
--
-- P2 — Split the polymorphic contact_inquiries.phone column.
--
-- BEFORE: one TEXT column holding a phone OR an email OR "phone | email",
-- written by AboutPage.jsx (which validates either shape) and decoded at read
-- time by a splitContact() helper in ContactInquiriesPage.jsx that splits on
-- '|' then sniffs for '@'. One column, two domains, no type tag — so
-- "email everyone who left a phone number" was a string parse, not a query.
--
-- AFTER: contact_phone + contact_email, each meaning one thing.
--
-- The old `phone` column is deliberately KEPT and still written by the app
-- this release (dual-write). It is renamed to _deprecated_phone in a later
-- migration, once this has been verified in production. That ordering means
-- this migration can be rolled back by simply ignoring the new columns.
-- ============================================================


ALTER TABLE public.contact_inquiries
  ADD COLUMN IF NOT EXISTS contact_phone TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS contact_email TEXT DEFAULT NULL;


-- ─── Backfill ───────────────────────────────────────────────
-- Mirrors splitContact() in ContactInquiriesPage.jsx exactly:
--   "0917… | a@b.com" → phone + email
--   "a@b.com"         → email
--   "0917…"           → phone
-- Idempotent: only touches rows where both new columns are still NULL.
UPDATE public.contact_inquiries
SET
  contact_phone = CASE
    WHEN position('|' in phone) > 0 THEN NULLIF(btrim(split_part(phone, '|', 1)), '')
    WHEN phone LIKE '%@%'           THEN NULL
    ELSE NULLIF(btrim(phone), '')
  END,
  contact_email = CASE
    WHEN position('|' in phone) > 0 THEN NULLIF(btrim(split_part(phone, '|', 2)), '')
    WHEN phone LIKE '%@%'           THEN NULLIF(btrim(phone), '')
    ELSE NULL
  END
WHERE phone IS NOT NULL
  AND btrim(phone) <> ''
  AND contact_phone IS NULL
  AND contact_email IS NULL;


-- ─── Missing admin DELETE policy ────────────────────────────
-- contact_inquiries had INSERT (anon), SELECT (admin) and UPDATE (admin) but
-- no DELETE policy at all, so spam submissions could never be removed.
DROP POLICY IF EXISTS "Admins can delete contact inquiries" ON public.contact_inquiries;
CREATE POLICY "Admins can delete contact inquiries" ON public.contact_inquiries
  FOR DELETE USING (public.is_admin());


-- ============================================================
-- VERIFY (run manually):
--
--   -- Every row should have at least one contact channel:
--   SELECT count(*) FROM contact_inquiries
--   WHERE contact_phone IS NULL AND contact_email IS NULL
--     AND phone IS NOT NULL AND btrim(phone) <> '';
--   -- expected: 0
--
--   -- Spot-check the split:
--   SELECT phone, contact_phone, contact_email
--   FROM contact_inquiries ORDER BY created_at DESC LIMIT 20;
-- ============================================================
