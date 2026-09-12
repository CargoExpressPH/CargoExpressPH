-- Minimal harness schema for the F-007 service-area mass-assignment fix —
-- enough of the real CargoExpressPH schema, AS IT STOOD IMMEDIATELY BEFORE
-- this fix, for the orders INSERT RLS policy and prepare_order_insert() to
-- run unmodified. The REAL new migration (20260912030000) is applied
-- verbatim on top by run.mjs, so what is tested is byte-for-byte what ships
-- — including the "before" behaviour the mass-assignment scenarios diff
-- against.
--
-- prepare_order_insert() below is copied verbatim from
-- 20260911020000_shipping_discount_guards.sql (the latest version prior to
-- this fix). The "Users can create own orders" policy below is copied
-- verbatim from 20260524190000_production_hardening.sql (never replaced
-- until this fix).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.uid', true), '')::uuid;
$$;

CREATE TABLE profiles (
  id UUID PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(20) DEFAULT 'customer' CHECK (role = ANY (ARRAY['admin','customer']))
);

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()),
    FALSE
  );
$function$;

CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_number TEXT,
  origin TEXT,
  destination TEXT,
  capacity NUMERIC DEFAULT 0,
  price_per_kg NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'scheduled'
);

CREATE OR REPLACE FUNCTION public.generate_order_tracking_number()
 RETURNS text
 LANGUAGE sql
AS $function$ SELECT 'CE-TEST-' || substr(gen_random_uuid()::text, 1, 8) $function$;

-- ── orders — the schema exactly as it stood before this fix ────────────────
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  trip_id UUID REFERENCES trips(id),
  origin TEXT,
  destination TEXT,
  tracking_number VARCHAR(50) NOT NULL UNIQUE,
  sender_name TEXT DEFAULT 'Sender',
  receiver_name TEXT DEFAULT 'Receiver',
  sender_province TEXT,
  actual_weight DECIMAL(10,2),
  shipping_cost DECIMAL(10,2) DEFAULT 0,
  payer_type VARCHAR(20) DEFAULT 'sender',
  payment_method VARCHAR(20),
  payment_status VARCHAR(20) DEFAULT 'unpaid' CHECK (payment_status = ANY (ARRAY['paid','partial','unpaid'])),
  amount_paid DECIMAL(10,2) DEFAULT 0.00 CHECK (amount_paid >= 0),
  remaining_balance DECIMAL(10,2) DEFAULT 0.00 CHECK (remaining_balance >= 0),
  promised_payment_date DATE,
  status VARCHAR(30) DEFAULT 'Pending',
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  delivery_photos JSONB DEFAULT '[]'::jsonb,
  payment_reference VARCHAR(255),
  cancellation_details JSONB,
  discount_amount NUMERIC DEFAULT 0,
  discount_reason TEXT,
  discount_notes TEXT,
  discount_applied_by UUID,
  discount_applied_at TIMESTAMPTZ,
  service_area_status TEXT DEFAULT 'standard' CHECK (service_area_status = ANY (ARRAY['standard','for_review','approved','rejected'])),
  service_area_remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── prepare_order_insert() — verbatim from 20260911020000 (pre-fix) ────────
CREATE OR REPLACE FUNCTION public.prepare_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row       public.trips%ROWTYPE;
  v_current_load NUMERIC;
  v_capacity_allowance CONSTANT NUMERIC := 200;
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Cannot create orders for another user';
  END IF;

  NEW.tracking_number := public.generate_order_tracking_number();
  NEW.actual_weight := NULL;
  NEW.payment_method := NULL;
  NEW.payment_status := 'unpaid';
  NEW.amount_paid := 0;
  NEW.promised_payment_date := NULL;
  NEW.payment_reference := NULL;
  NEW.pickup_photos := '[]'::jsonb;
  NEW.delivery_photos := '[]'::jsonb;

  NEW.cancellation_details := NULL;

  NEW.discount_amount     := 0;
  NEW.discount_reason     := NULL;
  NEW.discount_notes      := NULL;
  NEW.discount_applied_by := NULL;
  NEW.discount_applied_at := NULL;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    IF trip_row.capacity > 0 THEN
      SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0)
        INTO v_current_load
        FROM public.orders o
       WHERE o.trip_id = NEW.trip_id
         AND o.status <> 'Cancelled';

      IF v_current_load > (trip_row.capacity + v_capacity_allowance) THEN
        RAISE EXCEPTION
          'Cannot accept booking: exceeds maximum van capacity of % kg (% kg planned + % kg allowance). This trip is carrying % kg.',
          trip_row.capacity + v_capacity_allowance,
          trip_row.capacity,
          v_capacity_allowance,
          v_current_load;
      END IF;
    END IF;

    NEW.status := 'Assigned';
    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
  ELSE
    NEW.status := 'Pending';
  END IF;

  NEW.shipping_cost := 0;
  NEW.remaining_balance := 0;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER orders_prepare_insert
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION public.prepare_order_insert();

-- ── RLS — verbatim from 20260524190000 (pre-fix, never replaced until now) ─
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.orders TO authenticated;
GRANT SELECT, INSERT ON public.orders TO service_role;
GRANT USAGE ON SCHEMA public TO authenticated, service_role, anon;

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
