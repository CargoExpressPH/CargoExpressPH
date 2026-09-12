-- Server-side customer directory for the Admin Customers page.
--
-- Aggregates are calculated once for the requested page/query instead of
-- issuing one orders request per customer. The function is deliberately
-- admin-only and returns only fields used by the directory UI.

BEGIN;

-- PostgreSQL does not automatically index foreign-key columns. This supports
-- the directory rollup and the existing per-customer order lookups.
CREATE INDEX IF NOT EXISTS idx_orders_user_id
  ON public.orders(user_id);

CREATE OR REPLACE FUNCTION public.get_admin_customers(
  p_page INTEGER DEFAULT 1,
  p_per_page INTEGER DEFAULT 15,
  p_search TEXT DEFAULT '',
  p_status_filter TEXT DEFAULT 'all',
  p_province TEXT DEFAULT NULL,
  p_sort TEXT DEFAULT 'newest'
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  email TEXT,
  phone TEXT,
  address_city TEXT,
  address_province TEXT,
  created_at TIMESTAMPTZ,
  total_bookings BIGINT,
  outstanding_balance NUMERIC,
  last_booking_at TIMESTAMPTZ,
  pending_bookings BIGINT,
  active_bookings BIGINT,
  directory_status TEXT,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_page INTEGER := GREATEST(COALESCE(p_page, 1), 1);
  v_per_page INTEGER := LEAST(GREATEST(COALESCE(p_per_page, 15), 1), 100);
  v_search TEXT := btrim(COALESCE(p_search, ''));
  v_filter TEXT := lower(btrim(COALESCE(p_status_filter, 'all')));
  v_province TEXT := NULLIF(btrim(COALESCE(p_province, '')), '');
  v_sort TEXT := lower(btrim(COALESCE(p_sort, 'newest')));
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_search) > 100 THEN
    RAISE EXCEPTION 'Search must be 100 characters or less' USING ERRCODE = '22023';
  END IF;

  IF v_province IS NOT NULL AND char_length(v_province) > 255 THEN
    RAISE EXCEPTION 'Province filter is too long' USING ERRCODE = '22023';
  END IF;

  IF v_filter NOT IN ('all', 'with_balance', 'pending', 'active', 'no_bookings') THEN
    RAISE EXCEPTION 'Unsupported customer filter' USING ERRCODE = '22023';
  END IF;

  IF v_sort NOT IN ('name_asc', 'newest', 'oldest', 'most_bookings', 'highest_balance', 'recent_booking') THEN
    RAISE EXCEPTION 'Unsupported customer sort' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH rollup AS (
    SELECT
      p.id,
      p.name::TEXT,
      p.email::TEXT,
      p.phone::TEXT,
      p.address_city::TEXT,
      p.address_province::TEXT,
      p.created_at,
      count(o.id)::BIGINT AS total_bookings,
      round(COALESCE(sum(
        CASE
          WHEN o.id IS NULL OR o.status = 'Cancelled' THEN 0::NUMERIC
          ELSE greatest(
            COALESCE(o.shipping_cost, 0)
              - COALESCE(o.discount_amount, 0)
              - COALESCE(o.amount_paid, 0),
            0::NUMERIC
          )
        END
      ), 0::NUMERIC), 2) AS outstanding_balance,
      max(o.created_at) AS last_booking_at,
      count(o.id) FILTER (
        WHERE o.status IN ('Pending Review', 'Pending', 'Pending Cancellation')
      )::BIGINT AS pending_bookings,
      count(o.id) FILTER (
        WHERE o.status IN ('Assigned', 'Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery')
      )::BIGINT AS active_bookings
    FROM public.profiles p
    LEFT JOIN public.orders o ON o.user_id = p.id
    WHERE p.role = 'customer'
    GROUP BY p.id, p.name, p.email, p.phone, p.address_city, p.address_province, p.created_at
  ), filtered AS (
    SELECT
      r.*,
      CASE
        WHEN r.outstanding_balance > 0 THEN 'with_balance'
        WHEN r.pending_bookings > 0 THEN 'pending'
        WHEN r.active_bookings > 0 THEN 'active'
        ELSE 'inactive'
      END AS directory_status
    FROM rollup r
    WHERE (
      v_search = ''
      OR r.name ILIKE '%' || v_search || '%'
      OR r.email ILIKE '%' || v_search || '%'
      OR COALESCE(r.phone, '') ILIKE '%' || v_search || '%'
      OR COALESCE(r.address_city, '') ILIKE '%' || v_search || '%'
      OR COALESCE(r.address_province, '') ILIKE '%' || v_search || '%'
    )
    AND (v_province IS NULL OR lower(btrim(COALESCE(r.address_province, ''))) = lower(v_province))
    AND CASE v_filter
      WHEN 'with_balance' THEN r.outstanding_balance > 0
      WHEN 'pending' THEN r.pending_bookings > 0
      WHEN 'active' THEN r.active_bookings > 0
      WHEN 'no_bookings' THEN r.total_bookings = 0
      ELSE true
    END
  )
  SELECT
    f.id,
    f.name,
    f.email,
    f.phone,
    f.address_city,
    f.address_province,
    f.created_at,
    f.total_bookings,
    f.outstanding_balance,
    f.last_booking_at,
    f.pending_bookings,
    f.active_bookings,
    f.directory_status,
    count(*) OVER()::BIGINT AS total_count
  FROM filtered f
  ORDER BY
    CASE WHEN v_sort = 'name_asc' THEN lower(f.name) END ASC NULLS LAST,
    CASE WHEN v_sort = 'newest' THEN f.created_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'oldest' THEN f.created_at END ASC NULLS LAST,
    CASE WHEN v_sort = 'most_bookings' THEN f.total_bookings END DESC NULLS LAST,
    CASE WHEN v_sort = 'highest_balance' THEN f.outstanding_balance END DESC NULLS LAST,
    CASE WHEN v_sort = 'recent_booking' THEN f.last_booking_at END DESC NULLS LAST,
    lower(f.name) ASC,
    f.id ASC
  LIMIT v_per_page
  OFFSET (v_page - 1) * v_per_page;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_customer_provinces()
RETURNS TABLE (province TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT DISTINCT btrim(p.address_province)::TEXT
  FROM public.profiles p
  WHERE p.role = 'customer'
    AND NULLIF(btrim(p.address_province), '') IS NOT NULL
  ORDER BY 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_customers(INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_customers(INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_admin_customer_provinces()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_customer_provinces()
  TO authenticated;

COMMIT;
