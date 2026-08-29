-- ============================================================
-- 20260830000000_get_trips_load_rpc.sql
--
-- FIX — customer-facing "space left" / capacity showed near-0% booked.
--
-- getTrips(), getTripCurrentWeight() and getTripById() in src/lib/database.js
-- all aggregate a trip's current_weight by querying:
--   supabase.from('orders').select('trip_id, actual_weight')...
-- straight from the browser client. That query runs under RLS policy
-- "Users can view own orders" (20260524190000_production_hardening.sql):
--   FOR SELECT USING (user_id = auth.uid() OR public.is_admin())
-- A signed-in customer only gets back rows for their OWN orders, so the
-- SUM(actual_weight) computed client-side only ever counted that one
-- customer's cargo on the trip — never everyone else's. Every customer saw
-- the trip as far emptier than it really was (often 0% booked on trips that
-- were actually near or over capacity), which both misleads the UI and
-- undermines assertTripCapacity()'s client-side overbooking guard.
--
-- FIX: a SECURITY DEFINER RPC that aggregates SUM(actual_weight) per trip
-- server-side, bypassing RLS for the aggregation only. It returns nothing but
-- a trip_id + a numeric total per trip_id — no order id, no tracking number,
-- no names, no addresses, no per-order weight. A customer learns exactly what
-- the Trips/Home pages already show every other customer: how full a trip is.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_trips_load(trip_ids UUID[])
RETURNS TABLE (
  trip_id       UUID,
  current_weight NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.trip_id,
    COALESCE(SUM(o.actual_weight), 0) AS current_weight
  FROM public.orders o
  WHERE o.trip_id = ANY(trip_ids)
    AND o.status <> 'Cancelled'
  GROUP BY o.trip_id;
$$;

-- Only signed-in users need this (both getTrips paths run after auth); no
-- anon grant, unlike the public-page RPCs in 20260803120000_public_data_rpcs.sql.
GRANT EXECUTE ON FUNCTION public.get_trips_load(UUID[]) TO authenticated;


-- ============================================================
-- VERIFY (run manually after applying, as a non-admin customer JWT):
--
--   -- Previously under-counted to just this user's own orders:
--   select trip_id, sum(actual_weight) from orders
--     where trip_id = '<some trip with other customers'' orders>' group by trip_id;
--
--   -- Now returns the TRUE total across all customers on that trip:
--   select * from get_trips_load(array['<that trip id>']::uuid[]);
--
--   -- And still exposes nothing per-order:
--   -- (no id/tracking_number/user_id/weight-per-order in the return type)
-- ============================================================
