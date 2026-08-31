-- Complete the photo fallback lifecycle and restrict anonymous proof access to
-- the single image an administrator explicitly selected for the public site.
BEGIN;

CREATE OR REPLACE FUNCTION public.is_featured_photo_path(p_path TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.orders o
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN o.featured_image_type = 'delivery'
             AND jsonb_array_length(COALESCE(o.delivery_photos, '[]'::jsonb)) > 0
          THEN o.delivery_photos -> 0
        WHEN jsonb_array_length(COALESCE(o.pickup_photos, '[]'::jsonb)) > 0
          THEN o.pickup_photos -> 0
        ELSE NULL
      END AS photo
    ) selected
    CROSS JOIN LATERAL (
      SELECT CASE jsonb_typeof(selected.photo)
        WHEN 'object' THEN selected.photo ->> 'path'
        WHEN 'string' THEN selected.photo #>> '{}'
        ELSE NULL
      END AS raw_path
    ) photo_ref
    WHERE o.featured_on_website = TRUE
      AND (
        CASE
          WHEN photo_ref.raw_path LIKE '%/cargo-photos/%'
            THEN split_part(regexp_replace(photo_ref.raw_path, '^.*/cargo-photos/', ''), '?', 1)
          ELSE photo_ref.raw_path
        END
      ) = p_path
  );
$$;

REVOKE ALL ON FUNCTION public.is_featured_photo_path(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_featured_photo_path(TEXT) TO anon, authenticated;

DROP POLICY IF EXISTS "Public read featured delivery photos" ON storage.objects;
CREATE POLICY "Public read featured delivery photos" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id = 'cargo-photos'
    AND public.is_featured_photo_path(name)
  );

DROP FUNCTION IF EXISTS public.is_featured_order_ref(TEXT);

COMMIT;
