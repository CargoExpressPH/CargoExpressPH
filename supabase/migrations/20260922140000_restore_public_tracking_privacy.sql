-- ============================================================
-- Migration: 20260922140000_restore_public_tracking_privacy.sql
-- Purpose  : Restore the anonymous tracking projection hardened by
--            20260806000000_harden_public_rpcs.sql, which
--            20260922120000_trip_start_dates_and_actual_arrival.sql
--            silently widened when it dropped and recreated
--            track_order_public() to add the four trip-timing columns.
--
-- WHAT REGRESSED (audit F-01)
--   The recreated function returned o.shipping_cost and the COMPLETE
--   o.package_description to the `anon` role. 20260806000000 had removed
--   shipping_cost from the return type and truncated the description to 40
--   characters on purpose: tracking numbers are CE-YYYYMMDD-XXXX, i.e. ~10k
--   guesses per shipping day, so anything this function returns is
--   effectively enumerable without a session. The /track page never read
--   shipping_cost — the field was pure exposure.
--
-- WHAT THIS MIGRATION DOES
--   * DROPS shipping_cost from the return type entirely. It is not masked,
--     not rounded, not bucketed — it is absent from the anonymous response.
--   * Re-truncates package_description to 40 characters + '…'.
--   * KEEPS everything the tracking UI genuinely renders: masked sender and
--     receiver names, status, origin/destination, actual_weight, and the four
--     trip timing columns (scheduled departure, actual departure, estimated
--     arrival, actual arrival) that drive the trip timeline added in
--     20260922120000.
--   * Does NOT grant anonymous SELECT on public.orders. This remains a
--     SECURITY DEFINER allowlist projection, revoked from PUBLIC and granted
--     only to anon and authenticated, exactly as before.
--
-- HONEST LIMITATION — TRUNCATION IS NOT ANONYMISATION
--   left(package_description, 40) is a DISCLOSURE-REDUCTION measure, not a
--   privacy guarantee. For short descriptions ("Laptop and documents",
--   "Cash on delivery envelope") the first 40 characters ARE the whole
--   description, so truncation removes nothing at all. Likewise
--   public.mask_name() reduces, but does not eliminate, identifiability, and
--   actual_weight plus origin/destination remain visible by design because
--   the tracking page shows them. The only real control over bulk
--   enumeration is a rate limit at the API/edge boundary; the /track page's
--   45-second client cooldown is a UX behaviour and is NOT a security
--   boundary — a direct PostgREST RPC call ignores it entirely.
--   Anyone relying on this projection for confidentiality should assume a
--   determined enumerator can read every field it returns.
--
-- FULL DETAIL IS UNCHANGED FOR AUTHORISED CALLERS
--   Customers and admins do not use this RPC. They read public.orders
--   directly through the owner-or-admin RLS SELECT policy (getOrders /
--   getOrderById in src/lib/database.js), which still returns the exact
--   shipping_cost and the untruncated description. Nothing in this migration
--   narrows an authenticated path.
--
-- CONSUMERS OF THE CHANGED SIGNATURE (checked before writing this)
--   * src/lib/database.js :: getPublicTrackingResult — thin .rpc() wrapper,
--     returns whatever columns come back; no positional/typed binding.
--   * src/pages/public/TrackingPage.jsx — reads package_description,
--     actual_weight, trip_departure_date, trip_departure_at,
--     trip_estimated_arrival_at, trip_arrived_at. It does NOT read
--     shipping_cost anywhere (verified by grep), so removing it changes
--     nothing it renders.
--   * scripts/trip-start-dates-pgtest/run.mjs — selects only the four
--     trip_* columns from the function; unaffected.
--   * scripts/smoke-check.mjs — name-only reference; unaffected.
--
-- SIBLING ANONYMOUS ENDPOINTS INSPECTED (no change needed)
--   * get_public_order_events(TEXT)      -> (status, changed_at) only.
--   * get_trips_load(UUID[])             -> aggregate kg per trip; no
--                                           per-order or per-customer data.
--   * get_featured_deliveries()          -> admin-curated marketing rows.
--   * get_public_feedback()              -> masked name + admin-moderated.
--   * get_public_business_profile()      -> company's own public details.
--   None of these returns a money value or free-text cargo description.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.track_order_public(TEXT);

CREATE FUNCTION public.track_order_public(p_tracking_number TEXT)
RETURNS TABLE (
  tracking_number           VARCHAR,
  status                    VARCHAR,
  sender_name               TEXT,
  receiver_name             TEXT,
  origin                    VARCHAR,
  destination               VARCHAR,
  package_description       TEXT,
  actual_weight             NUMERIC,
  estimated_delivery        TIMESTAMPTZ,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ,
  trip_departure_date       TIMESTAMPTZ,
  trip_departure_at         TIMESTAMPTZ,
  trip_estimated_arrival_at TIMESTAMPTZ,
  trip_arrived_at           TIMESTAMPTZ
  -- shipping_cost is intentionally ABSENT. Do not re-add it here; a caller
  -- that needs the fee is an authenticated caller and must read the order.
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
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
    o.updated_at,
    t.departure_date                  AS trip_departure_date,
    t.departure_at                    AS trip_departure_at,
    t.estimated_arrival_at            AS trip_estimated_arrival_at,
    t.arrived_at                      AS trip_arrived_at
  FROM public.orders AS o
  LEFT JOIN public.trips AS t ON t.id = o.trip_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.track_order_public(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_order_public(TEXT) TO anon, authenticated;

COMMIT;

-- ============================================================
-- VERIFY (anonymous response must not carry a fee column):
--   SELECT COUNT(*) FROM information_schema.parameters
--    WHERE specific_schema = 'public'
--      AND parameter_name  = 'shipping_cost'
--      AND specific_name LIKE 'track_order_public%';   -- expect 0
-- ============================================================
