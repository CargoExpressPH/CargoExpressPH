-- ============================================================
-- 20260804180000_customer_photo_access.sql
--
-- Proof-photo visibility: fix the customer read policy, and lay the
-- groundwork for taking the bucket private.
--
-- ── WHAT THE AUDIT ACTUALLY FOUND ────────────────────────────────────────
--
-- The customer SELECT policy was dead code:
--
--     WHERE o.id = public.safe_uuid((storage.foldername(name))[2])
--
-- Segment [2] is the folder BELOW the top-level one. Under the current
-- naming scheme (storage.js -> makePhotoPath) that segment is a tracking
-- number:
--
--     pickup-proofs/CE-20260801-3261/pickup-1.jpg
--
-- safe_uuid('CE-20260801-3261') returns NULL, so the EXISTS never matched
-- and the policy granted nothing. It was written for the ORIGINAL scheme,
-- which did key on the order UUID and is still present in storage:
--
--     pickup/69488de9-4791-4176-bdab-390c53366ce8/1779747591561_....jpg
--
-- The policy silently stopped matching when the path scheme changed.
--
-- ── AND WHY NOBODY NOTICED ───────────────────────────────────────────────
--
-- Customers can nonetheless see their photos today — because the bucket is
-- PUBLIC on the live project (schema.sql says FALSE; the live value is
-- TRUE, so this drifted at some point, plausibly to work around the broken
-- policy). Reads bypass RLS entirely through /object/public/.
--
-- That is the real exposure, and it is worse than the bug it masks: every
-- proof photo and payment receipt is world-readable to anyone who can guess
-- a path — and the paths are guessable, since tracking numbers are
-- CE-YYYYMMDD-NNNN. 31 shipment-evidence objects are affected.
--
-- ── WHAT THIS MIGRATION DOES ─────────────────────────────────────────────
--
--   1. Repairs the customer policy so it matches BOTH path schemes.
--   2. Adds an explicit public-read policy for company website assets
--      (gallery / hero / timeline), so those keep working once the bucket
--      is private.
--   3. Creates a dedicated PUBLIC bucket for company assets, which is where
--      they belong — website decoration and cargo evidence should not share
--      a privacy setting.
--
-- It does NOT flip cargo-photos to private. company_information.hero_image_url
-- stores a hard-coded .../object/public/cargo-photos/hero/hero-image.jpg URL,
-- so flipping it right now would break the public homepage. The final step is
-- sequenced at the bottom of this file.
-- ============================================================


-- ============================================================
-- 1. Customer read access to their own shipment evidence
-- ============================================================

DROP POLICY IF EXISTS "Users read own cargo photos" ON storage.objects;

CREATE POLICY "Users read own cargo photos" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cargo-photos'
    -- Evidence folders only. Company assets are covered by the policy below;
    -- anything else in the bucket stays admin-only by omission.
    AND (storage.foldername(name))[1] IN (
      'pickup', 'delivery', 'receipts',
      'pickup-proofs', 'delivery-proofs'
    )
    AND EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.user_id = auth.uid()
        AND (
          -- current scheme: <folder>/<tracking-number>/<file>
          o.tracking_number = (storage.foldername(name))[2]
          -- legacy scheme:  <folder>/<order-uuid>/<file>
          OR o.id = public.safe_uuid((storage.foldername(name))[2])
        )
    )
  );


-- ============================================================
-- 2. Public website assets stay readable to everyone
--
-- Needed before the bucket can go private: the About page is rendered for
-- anonymous visitors, and anon cannot mint a signed URL without a SELECT
-- policy to authorise it.
-- ============================================================

DROP POLICY IF EXISTS "Public read company assets" ON storage.objects;

CREATE POLICY "Public read company assets" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id IN ('cargo-photos', 'company-assets')
    AND (storage.foldername(name))[1] IN ('gallery', 'hero', 'timeline')
  );


-- ============================================================
-- 3. A dedicated public bucket for website decoration
--
-- New company-asset uploads go here (see uploadPublicAsset in database.js).
-- Existing objects are left where they are; the policy above covers both
-- locations, so nothing breaks during the transition.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-assets',
  'company-assets',
  TRUE,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Admins manage company assets" ON storage.objects;

CREATE POLICY "Admins manage company assets" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'company-assets' AND public.is_admin())
  WITH CHECK (bucket_id = 'company-assets' AND public.is_admin());


-- ============================================================
-- REMAINING STEP — closing the exposure (NOT run here)
--
-- Once the three company assets (hero x1, gallery x2) have been re-uploaded
-- through Admin -> Company Information, they will live in company-assets and
-- company_information will hold the new URLs. At that point cargo-photos can
-- be taken private and every proof photo becomes signed-URL-only:
--
--     UPDATE storage.buckets SET public = FALSE WHERE id = 'cargo-photos';
--
-- resolvePhotoUrl() already issues signed URLs, so the app needs no further
-- change — verify by loading a customer order detail page and the public
-- About page after flipping.
--
-- To roll back if anything renders blank:
--     UPDATE storage.buckets SET public = TRUE WHERE id = 'cargo-photos';
-- ============================================================


-- ============================================================
-- VERIFY (run manually):
--
--   -- As a CUSTOMER: should list only their own orders' evidence
--   SELECT name FROM storage.objects
--   WHERE bucket_id = 'cargo-photos'
--     AND (storage.foldername(name))[1] LIKE '%proofs';
--
--   -- Policy inventory
--   SELECT policyname, roles FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects';
-- ============================================================
