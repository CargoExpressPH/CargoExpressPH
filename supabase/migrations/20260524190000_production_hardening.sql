-- CargoExpress PH production hardening migration
-- Generated from supabase/schema.sql production hardening section.

-- PRODUCTION HARDENING
-- Apply after the base schema. This replaces permissive MVP policies
-- and adds server-side guards for roles, orders, storage, and reports.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()),
    FALSE
  );
$$;

CREATE OR REPLACE FUNCTION public.safe_uuid(value TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN value::UUID;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.safe_uuid(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_profile_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
      NEW.role := 'customer';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    NEW.id := OLD.id;
    NEW.email := OLD.email;
    NEW.role := OLD.role;
    NEW.created_at := OLD.created_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_write ON profiles;
CREATE TRIGGER profiles_guard_write
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_write();

CREATE OR REPLACE FUNCTION public.generate_order_tracking_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  candidate TEXT;
BEGIN
  LOOP
    candidate := 'CE-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || FLOOR(1000 + RANDOM() * 9000)::INT;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.orders WHERE tracking_number = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_trip_weight(p_trip_id UUID, p_exclude_order_id UUID DEFAULT NULL)
RETURNS NUMERIC
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(COALESCE(actual_weight, package_weight, 0)), 0)
  FROM public.orders
  WHERE trip_id = p_trip_id
    AND status <> 'Cancelled'
    AND (p_exclude_order_id IS NULL OR id <> p_exclude_order_id);
$$;

CREATE OR REPLACE FUNCTION public.global_price_per_kilo()
RETURNS NUMERIC
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT setting_value::NUMERIC FROM public.global_settings WHERE setting_key = 'price_per_kilo' LIMIT 1),
    70
  );
$$;

CREATE OR REPLACE FUNCTION public.effective_trip_price(p_trip_id UUID)
RETURNS NUMERIC
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT NULLIF(price_per_kg, 0) FROM public.trips WHERE id = p_trip_id),
    public.global_price_per_kilo()
  );
$$;

CREATE OR REPLACE FUNCTION public.prepare_order_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  trip_row public.trips%ROWTYPE;
  weight NUMERIC;
  price NUMERIC;
  next_weight NUMERIC;
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Cannot create orders for another user';
  END IF;

  weight := COALESCE(NEW.package_weight, 0);
  IF weight <= 0 THEN
    RAISE EXCEPTION 'Package weight must be greater than zero';
  END IF;

  price := public.global_price_per_kilo();
  NEW.tracking_number := public.generate_order_tracking_number();
  NEW.actual_weight := NULL;
  NEW.payment_method := NULL;
  NEW.payment_status := 'unpaid';
  NEW.amount_paid := 0;
  NEW.promised_payment_date := NULL;
  NEW.payment_reference := NULL;
  NEW.pickup_photos := '[]'::jsonb;
  NEW.delivery_photos := '[]'::jsonb;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    next_weight := public.current_trip_weight(NEW.trip_id) + weight;
    -- Capacity check removed to allow administrators to manually exceed limits.

    price := COALESCE(NULLIF(trip_row.price_per_kg, 0), price);
    NEW.status := 'Assigned';
    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
  ELSE
    NEW.status := 'Pending';
  END IF;

  NEW.shipping_cost := ROUND(weight * price, 2);
  NEW.remaining_balance := NEW.shipping_cost;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_order_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  trip_row public.trips%ROWTYPE;
  weight NUMERIC;
  price NUMERIC;
  next_weight NUMERIC;
BEGIN
  IF NEW.trip_id IS NOT NULL AND NEW.status <> 'Cancelled' THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
    weight := COALESCE(NEW.actual_weight, NEW.package_weight, 0);
    next_weight := public.current_trip_weight(NEW.trip_id, NEW.id) + weight;
    -- Capacity check removed to allow administrators to manually exceed limits.

    IF OLD.trip_id IS DISTINCT FROM NEW.trip_id AND NEW.status = 'Pending' THEN
      NEW.status := 'Assigned';
    END IF;
  END IF;

  IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN
    weight := COALESCE(NEW.actual_weight, NEW.package_weight, 0);
    price := CASE
      WHEN NEW.trip_id IS NOT NULL THEN public.effective_trip_price(NEW.trip_id)
      ELSE public.global_price_per_kilo()
    END;
    NEW.shipping_cost := ROUND(weight * price, 2);
    NEW.remaining_balance := GREATEST(0, NEW.shipping_cost - COALESCE(NEW.amount_paid, 0));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_prepare_insert ON orders;
CREATE TRIGGER orders_prepare_insert
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION public.prepare_order_insert();

DROP TRIGGER IF EXISTS orders_guard_update ON orders;
CREATE TRIGGER orders_guard_update
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_update();

CREATE OR REPLACE FUNCTION public.cancel_own_pending_order(p_order_id UUID)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_order public.orders;
BEGIN
  UPDATE public.orders
  SET status = 'Cancelled'
  WHERE id = p_order_id
    AND user_id = auth.uid()
    AND status = 'Pending'
  RETURNING * INTO updated_order;

  IF updated_order.id IS NULL THEN
    RAISE EXCEPTION 'Only your own pending orders can be cancelled';
  END IF;

  RETURN updated_order;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_own_pending_order(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.track_order_public(p_tracking_number TEXT)
RETURNS TABLE (
  tracking_number VARCHAR,
  status VARCHAR,
  sender_name VARCHAR,
  receiver_name VARCHAR,
  origin VARCHAR,
  destination VARCHAR,
  package_description TEXT,
  package_weight NUMERIC,
  actual_weight NUMERIC,
  shipping_cost NUMERIC,
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
    o.sender_name,
    o.receiver_name,
    o.origin,
    o.destination,
    o.package_description,
    o.package_weight,
    o.actual_weight,
    o.shipping_cost,
    o.created_at,
    o.updated_at
  FROM public.orders o
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.track_order_public(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_public_business_profile()
RETURNS TABLE (
  name VARCHAR,
  smart_phone TEXT,
  globe_phone TEXT,
  facebook_link TEXT,
  manila_address TEXT,
  bohol_address TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.name,
    p.smart_phone,
    p.globe_phone,
    p.facebook_link,
    p.manila_address,
    p.bohol_address
  FROM public.profiles p
  WHERE p.role = 'admin'
  ORDER BY p.created_at ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_business_profile() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_sales_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  WITH active_orders AS (
    SELECT *
    FROM public.orders
    WHERE status <> 'Cancelled'
  ),
  summary AS (
    SELECT jsonb_build_object(
      'totalRevenue', COALESCE(SUM(shipping_cost), 0),
      'cashTotal', COALESCE(SUM(amount_paid) FILTER (WHERE payment_method = 'cash'), 0),
      'gcashTotal', COALESCE(SUM(amount_paid) FILTER (WHERE payment_method = 'gcash'), 0),
      'paylaterTotal', COALESCE(SUM(amount_paid) FILTER (WHERE payment_method = 'paylater'), 0),
      'paidTotal', COALESCE(SUM(amount_paid), 0),
      'unpaidTotal', COALESCE(SUM(remaining_balance), 0),
      'unpaidCount', COUNT(*) FILTER (WHERE payment_status IS NULL OR payment_status IN ('unpaid', 'partial'))
    ) AS value
    FROM active_orders
  ),
  monthly AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.month DESC), '[]'::jsonb) AS value
    FROM (
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COALESCE(SUM(shipping_cost), 0) AS total_revenue,
        COALESCE(SUM(amount_paid), 0) AS collected,
        COALESCE(SUM(remaining_balance), 0) AS outstanding
      FROM active_orders
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
      LIMIT 24
    ) m
  ),
  unpaid AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.created_at DESC), '[]'::jsonb) AS value
    FROM (
      SELECT id, tracking_number, created_at, shipping_cost, amount_paid, remaining_balance, payment_status
      FROM active_orders
      WHERE payment_status IS NULL OR payment_status IN ('unpaid', 'partial')
      ORDER BY created_at DESC
      LIMIT 100
    ) u
  )
  SELECT jsonb_build_object(
    'summary', summary.value,
    'monthlySales', monthly.value,
    'unpaidOrders', unpaid.value
  )
  INTO payload
  FROM summary, monthly, unpaid;

  RETURN payload;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_summary() TO authenticated;

-- Replace permissive profile policies.
DROP POLICY IF EXISTS "Anyone can view profiles" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Admins can view profiles" ON profiles;
DROP POLICY IF EXISTS "Admins can update profiles" ON profiles;

CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (id = auth.uid());

CREATE POLICY "Admins can view profiles" ON profiles
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY "Admins can update profiles" ON profiles
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (id = auth.uid());

-- Replace order policies with stricter insert rules. Admin update/delete remains server-side.
DROP POLICY IF EXISTS "Users can view own orders" ON orders;
DROP POLICY IF EXISTS "Users can create own orders" ON orders;
DROP POLICY IF EXISTS "Admins can update orders" ON orders;
DROP POLICY IF EXISTS "Admins can delete orders" ON orders;

CREATE POLICY "Users can view own orders" ON orders
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "Users can create own orders" ON orders
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND status IN ('Pending', 'Assigned')
    AND actual_weight IS NULL
    AND payment_method IS NULL
    AND payment_status = 'unpaid'
    AND amount_paid = 0
    AND pickup_photos = '[]'::jsonb
    AND delivery_photos = '[]'::jsonb
  );

CREATE POLICY "Admins can update orders" ON orders
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete orders" ON orders
  FOR DELETE USING (public.is_admin());

-- Replace permissive notification insert policy.
DROP POLICY IF EXISTS "Users can view own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;
DROP POLICY IF EXISTS "System can insert notifications" ON notifications;
DROP POLICY IF EXISTS "Users can insert own notifications" ON notifications;
DROP POLICY IF EXISTS "Admins can insert notifications" ON notifications;

CREATE POLICY "Users can view own notifications" ON notifications
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can update own notifications" ON notifications
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can insert own notifications" ON notifications
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins can insert notifications" ON notifications
  FOR INSERT WITH CHECK (public.is_admin());

-- Supabase Storage bucket for proof photos. Private bucket; app reads signed URLs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cargo-photos',
  'cargo-photos',
  FALSE,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Admins manage cargo photos" ON storage.objects;
DROP POLICY IF EXISTS "Users read own cargo photos" ON storage.objects;

CREATE POLICY "Admins manage cargo photos" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'cargo-photos' AND public.is_admin())
  WITH CHECK (bucket_id = 'cargo-photos' AND public.is_admin());

CREATE POLICY "Users read own cargo photos" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cargo-photos'
    AND EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = public.safe_uuid((storage.foldername(name))[2])
        AND o.user_id = auth.uid()
    )
  );

