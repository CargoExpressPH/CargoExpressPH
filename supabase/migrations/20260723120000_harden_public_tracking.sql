-- ======================================================================
-- 20260723120000_harden_public_tracking.sql
--
-- Privacy hardening + ETA for the public tracking endpoint.
--
-- Why: a tracking number is not a secret (printed on the box, shared in
-- receipts, sequential/guessable). The previous track_order_public RPC
-- returned the FULL sender and receiver names to any anonymous visitor.
-- No major carrier does this. This migration:
--
--   1. Adds a reusable mask_name() helper that collapses a full name to
--      "First L." (first token + last-initial).
--   2. Rewrites track_order_public to mask both names and to LEFT JOIN
--      trips so the page can show an estimated delivery (arrival) date.
--
-- No data is destroyed — the underlying orders table is untouched; only
-- the public projection is narrowed.
-- ======================================================================

-- ----------------------------------------------------------------------
-- mask_name(full_name): "Juan Dela Cruz" -> "Juan D.", "Maria" -> "Maria"
-- NULL / blank-safe, IMMUTABLE so it can be indexed if ever needed.
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mask_name(full_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN full_name IS NULL OR btrim(full_name) = '' THEN NULL
    ELSE
      split_part(btrim(full_name), ' ', 1)
      || CASE
        WHEN array_length(string_to_array(btrim(full_name), ' '), 1) > 1
          THEN ' '
            || UPPER(LEFT(split_part(
                  btrim(full_name), ' ',
                  array_length(string_to_array(btrim(full_name), ' '), 1)
                ), 1))
            || '.'
        ELSE ''
      END
  END
$$;

-- ----------------------------------------------------------------------
-- track_order_public: narrowed projection.
--   * names masked via mask_name()
--   * phones / addresses / payment info never returned (unchanged)
--   * trip.arrival_date exposed as estimated_delivery
-- ----------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.track_order_public(TEXT);

CREATE OR REPLACE FUNCTION public.track_order_public(p_tracking_number TEXT)
RETURNS TABLE (
  tracking_number VARCHAR,
  status VARCHAR,
  sender_name TEXT,
  receiver_name TEXT,
  origin VARCHAR,
  destination VARCHAR,
  package_description TEXT,
  package_weight NUMERIC,
  actual_weight NUMERIC,
  shipping_cost NUMERIC,
  estimated_delivery TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
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
    o.package_description,
    o.package_weight,
    o.actual_weight,
    o.shipping_cost,
    t.arrival_date AS estimated_delivery,
    o.created_at,
    o.updated_at
  FROM public.orders o
  LEFT JOIN public.trips t ON t.id = o.trip_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$$;

-- Permissions are idempotent: GRANT is re-issued (harmless if present).
GRANT EXECUTE ON FUNCTION public.track_order_public(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mask_name(TEXT) TO anon, authenticated;
