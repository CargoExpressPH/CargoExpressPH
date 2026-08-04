-- ============================================================
-- 20260804200000_lock_cargo_photos.sql
--
-- Close the proof-photo exposure: take `cargo-photos` private.
--
-- Completes the transition staged in 20260804180000. After this migration
-- the only ways to read shipment evidence are:
--   * an admin session          (Admins manage cargo photos)
--   * the owning customer       (Users read own cargo photos)
--   * a signed URL minted for a photo the business chose to feature publicly
--
-- The /object/public/ endpoint stops serving the bucket entirely, which is
-- the point: paths are guessable (the tracking number is in the path, and
-- tracking numbers run CE-YYYYMMDD-NNNN), so a public bucket meant every
-- proof photo and receipt was enumerable by anyone.
--
--
-- ── WHY THE FEATURED-PHOTO CARVE-OUT IS REQUIRED ─────────────────────────
--
-- get_featured_deliveries() deliberately returns pickup_photos and
-- delivery_photos to ANONYMOUS visitors — that is the About page's delivery
-- gallery, and one order is featured with photos today
-- (CE-20260702-9627). Flipping the bucket without this policy would have
-- broken that gallery: anon would be unable to sign a URL, and the public
-- fallback would 400.
--
-- ── WHY IT NEEDS A SECURITY DEFINER HELPER ───────────────────────────────
--
-- A subquery inside a storage policy runs as the CALLING role. `anon` has no
-- table-level access to public.orders (that policy was removed deliberately
-- in 20260803120000), so an inline EXISTS against orders would always be
-- false for anonymous visitors and the carve-out would never match. The
-- helper below runs as its owner, reads exactly one boolean, and leaks
-- nothing else about the order.
-- ============================================================


-- ============================================================
-- 1. Helper — "does this path segment belong to a featured order?"
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_featured_order_ref(p_ref TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.featured_on_website = TRUE
      AND (
        o.tracking_number = p_ref
        OR o.id = public.safe_uuid(p_ref)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_featured_order_ref(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_featured_order_ref(TEXT) TO anon, authenticated;


-- ============================================================
-- 2. Public read for featured delivery photos only
-- ============================================================

DROP POLICY IF EXISTS "Public read featured delivery photos" ON storage.objects;

CREATE POLICY "Public read featured delivery photos" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id = 'cargo-photos'
    AND (storage.foldername(name))[1] IN (
      'pickup', 'delivery', 'pickup-proofs', 'delivery-proofs'
    )
    AND public.is_featured_order_ref((storage.foldername(name))[2])
  );


-- ============================================================
-- 3. Lock the bucket
-- ============================================================

UPDATE storage.buckets SET public = FALSE WHERE id = 'cargo-photos';


-- ============================================================
-- ROLLBACK, if any image renders blank:
--   UPDATE storage.buckets SET public = TRUE WHERE id = 'cargo-photos';
--
-- VERIFY:
--   -- must be false / true
--   SELECT id, public FROM storage.buckets WHERE id IN ('cargo-photos','company-assets');
--
--   -- 400 expected: the public endpoint no longer serves proof photos
--   curl -so /dev/null -w '%{http_code}' \
--     "$SUPABASE_URL/storage/v1/object/public/cargo-photos/pickup-proofs/<tracking>/pickup-1.jpg"
--
--   -- 200 expected: anon may still sign a FEATURED photo
--   curl -s -X POST -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
--     -d '{"expiresIn":60}' \
--     "$SUPABASE_URL/storage/v1/object/sign/cargo-photos/delivery-proofs/<featured>/delivery-1.jpg"
-- ============================================================
