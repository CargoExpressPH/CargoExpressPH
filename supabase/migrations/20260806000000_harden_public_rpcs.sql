-- ============================================================
-- Migration: 20260806000000_harden_public_rpcs.sql
-- Purpose  : Harden public-facing RPCs to limit data exposure
--
-- Changes:
--  1. get_featured_deliveries() – return a single `featured_photo TEXT`
--     (the admin-selected path) instead of both pickup_photos and
--     delivery_photos JSONB arrays. Callers received both arrays but only
--     ever rendered one; any caller with the anon key could enumerate all
--     proof photos for every featured order.
--
--  2. get_public_feedback() – same fix; replace the two photo JSONB arrays
--     with a single `featured_photo TEXT` field.
--
--  3. track_order_public() – remove shipping_cost from the return type.
--     The tracking-number format is CE-YYYYMMDD-XXXX (~10k guesses/day),
--     making shipment values enumerable without authentication. Also
--     truncate package_description to 40 chars so bulk enumeration reveals
--     only a partial description.
-- ============================================================


-- ------------------------------------------------------------
-- 1.  get_featured_deliveries — single photo path
-- ------------------------------------------------------------
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
  ORDER BY o.featured_at DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_featured_deliveries() TO anon, authenticated;


-- ------------------------------------------------------------
-- 2.  get_public_feedback — single photo path
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_feedback()
RETURNS TABLE (
  id                  UUID,
  rating              INTEGER,
  message             TEXT,
  created_at          TIMESTAMPTZ,
  customer_name       TEXT,
  featured_on_website BOOLEAN,
  featured_image_type TEXT,
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
    f.id,
    f.rating,
    f.message,
    f.created_at,
    public.mask_name(p.name)              AS customer_name,
    COALESCE(o.featured_on_website, false) AS featured_on_website,
    o.featured_image_type,
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
  FROM public.customer_feedback f
  LEFT JOIN public.profiles p ON p.id = f.customer_id
  LEFT JOIN public.orders   o ON o.id = f.order_id
  WHERE f.is_hidden = false
  ORDER BY f.rating DESC, f.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_feedback() TO anon, authenticated;


-- ------------------------------------------------------------
-- 3.  track_order_public — remove shipping_cost, truncate description
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.track_order_public(TEXT);

CREATE OR REPLACE FUNCTION public.track_order_public(p_tracking_number TEXT)
RETURNS TABLE (
  tracking_number     VARCHAR,
  status              VARCHAR,
  sender_name         TEXT,
  receiver_name       TEXT,
  origin              VARCHAR,
  destination         VARCHAR,
  package_description TEXT,
  actual_weight       NUMERIC,
  estimated_delivery  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.tracking_number,
    o.status,
    public.mask_name(o.sender_name)   AS sender_name,
    public.mask_name(o.receiver_name) AS receiver_name,
    o.origin,
    o.destination,
    CASE
      WHEN length(o.package_description) > 40
        THEN left(o.package_description, 40) || '…'
      ELSE o.package_description
    END                               AS package_description,
    o.actual_weight,
    t.arrival_date                    AS estimated_delivery,
    o.created_at,
    o.updated_at
  FROM public.orders o
  LEFT JOIN public.trips t ON t.id = o.trip_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.track_order_public(TEXT) TO anon, authenticated;
