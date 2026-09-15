-- ============================================================
-- Migration: 20260915140000_separate_featured_shipments_from_feedback.sql
-- Purpose  : Stop get_public_feedback() from also acting as the data source
--            for a feedback card's photo, and stop get_featured_deliveries()
--            from publishing a shipment that was (re-)featured without a
--            title under the intermediate "Manage Feedback Photo" UI.
--
-- Background:
--   orders.featured_on_website / featured_image_type / featured_photo were
--   designed for exactly one purpose: publishing an admin-selected delivery
--   photo to a public "Featured Shipments" gallery (get_featured_deliveries).
--   get_public_feedback() separately joined the SAME columns onto customer
--   feedback rows, so featuring a shipment silently also attached its photo
--   to that booking's feedback card (if one existed) — the duplication this
--   migration removes. customer_feedback has never had its own photo column;
--   there is no genuine customer-submitted image to preserve here.
--
--   This does NOT touch orders.featured_on_website/featured_title/
--   featured_caption/featured_image_type/featured_at, get_featured_
--   deliveries()'s core shape, or is_featured_photo_path() — those remain
--   the sole, correct owners of "is this shipment featured, and with which
--   photo". No data is deleted or reassigned by this migration.
--
-- Changes:
--  1. get_public_feedback() — drop featured_on_website / featured_image_type
--     / featured_photo from the return columns. A feedback card now shows
--     only what a customer actually submitted (rating, message) plus
--     approved display details (masked name, receiver city/province).
--
--  2. get_featured_deliveries() — additionally require featured_title to be
--     set. Between the original "Feature This on Website" flow and this
--     migration, an intermediate admin UI briefly relabeled the same toggle
--     as a feedback-photo control and stopped collecting a title, so a
--     booking could have featured_on_website = true with no title. That
--     state is ambiguous — it doesn't tell us whether an admin actually
--     intended a public shipment showcase entry — so it is defensively
--     excluded from the public gallery until an admin explicitly reviews and
--     completes it via the restored "Feature Delivery on Website" modal
--     (which requires a title to save with the toggle on, same as before).
--     Any row that already had a title keeps publishing exactly as before.
-- ============================================================


-- ------------------------------------------------------------
-- 1.  get_public_feedback — feedback only, no shipment-feature fields
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_public_feedback();

CREATE OR REPLACE FUNCTION public.get_public_feedback()
RETURNS TABLE (
  id                  UUID,
  rating              INTEGER,
  message             TEXT,
  created_at          TIMESTAMPTZ,
  customer_name       TEXT,
  receiver_city       TEXT,
  receiver_province   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.id,
    f.rating,
    f.message,
    f.created_at,
    public.mask_name(p.name) AS customer_name,
    o.receiver_city,
    o.receiver_province
  FROM public.customer_feedback f
  LEFT JOIN public.profiles p ON p.id = f.customer_id
  LEFT JOIN public.orders   o ON o.id = f.order_id
  WHERE f.is_hidden = false
  ORDER BY f.rating DESC, f.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_feedback() TO anon, authenticated;


-- ------------------------------------------------------------
-- 2.  get_featured_deliveries — require a title before publishing publicly
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_featured_deliveries();

CREATE OR REPLACE FUNCTION public.get_featured_deliveries()
RETURNS TABLE (
  id                  UUID,
  featured_title      TEXT,
  featured_caption    TEXT,
  featured_image_type TEXT,
  featured_at         TIMESTAMPTZ,
  featured_photo      TEXT,   -- single admin-selected photo path
  receiver_city       TEXT,
  receiver_province   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    o.featured_title,
    o.featured_caption,
    o.featured_image_type,
    o.featured_at,
    CASE
      WHEN o.featured_image_type = 'delivery'
           AND jsonb_array_length(COALESCE(o.delivery_photos, '[]'::jsonb)) > 0
        THEN o.delivery_photos ->> 0
      WHEN jsonb_array_length(COALESCE(o.pickup_photos, '[]'::jsonb)) > 0
        THEN o.pickup_photos ->> 0
      ELSE NULL
    END AS featured_photo,
    o.receiver_city,
    o.receiver_province
  FROM public.orders o
  WHERE o.featured_on_website = true
    AND o.featured_title IS NOT NULL
    AND btrim(o.featured_title) <> ''
  ORDER BY o.featured_at DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_featured_deliveries() TO anon, authenticated;
