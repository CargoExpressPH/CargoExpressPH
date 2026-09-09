-- Minimal harness schema: just enough of the real CargoExpressPH schema for
-- payment_attempts / payment_transactions / orders logic to run unmodified.
-- Not a copy of production schema.sql (which depends on Supabase's auth.*
-- schema, extensions, and 135 migrations) — this hand-builds only the parts
-- the payment RPCs touch, then the REAL migration files are applied verbatim
-- on top so the tested function bodies are byte-for-byte what ships.

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

-- Session-local stand-ins for Supabase's auth.uid()/auth.role(), driven by
-- SET LOCAL app.uid / app.role in each test so we can act as a given user.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.uid', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'authenticated');
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

CREATE OR REPLACE FUNCTION public.derive_payment_status(p_shipping_cost numeric, p_amount_paid numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN COALESCE(p_amount_paid, 0) <= 0 THEN 'unpaid'
    WHEN COALESCE(p_amount_paid, 0) >= COALESCE(p_shipping_cost, 0) - 0.005 THEN 'paid'
    ELSE 'partial'
  END;
$function$;

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  tracking_number VARCHAR(50) NOT NULL UNIQUE,
  actual_weight DECIMAL(10,2),
  shipping_cost DECIMAL(10,2) DEFAULT 0,
  payer_type VARCHAR(20),
  payment_method VARCHAR(20),
  payment_status VARCHAR(20) DEFAULT 'unpaid' CHECK (payment_status = ANY (ARRAY['paid','partial','unpaid'])),
  amount_paid DECIMAL(10,2) DEFAULT 0.00 CHECK (amount_paid >= 0),
  remaining_balance DECIMAL(10,2) DEFAULT 0.00 CHECK (remaining_balance >= 0),
  promised_payment_date DATE,
  status VARCHAR(30) DEFAULT 'Pending',
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  delivery_photos JSONB DEFAULT '[]'::jsonb,
  payment_reference VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending','chargeable','reconciled','failed'])),
  payment_id TEXT UNIQUE,
  payment_status TEXT,
  actual_weight DECIMAL(10,2),
  payer_type VARCHAR(20) DEFAULT 'sender',
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  last_error TEXT,
  reconciled_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_type TEXT DEFAULT 'full' CHECK (payment_type = ANY (ARRAY['full','paylater'])),
  estimated_cost DECIMAL(10,2),
  promised_payment_date DATE
);

CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  payment_method TEXT NOT NULL,
  transaction_reference TEXT,
  payment_status TEXT NOT NULL,
  admin_id UUID,
  admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_type TEXT DEFAULT 'Additional Payment',
  payment_date DATE,
  receipt_url TEXT
);

CREATE UNIQUE INDEX unique_tx_ref ON public.payment_transactions USING btree (transaction_reference) WHERE (transaction_reference IS NOT NULL);

CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_paid    DECIMAL(10,2);
  v_shipping_cost DECIMAL(10,2);
  v_remaining     DECIMAL(10,2);
  v_order_id      UUID;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.payment_transactions
  WHERE order_id = v_order_id AND payment_status IN ('paid', 'partial');

  SELECT shipping_cost INTO v_shipping_cost
  FROM public.orders
  WHERE id = v_order_id;

  v_remaining := GREATEST(0, COALESCE(v_shipping_cost, 0) - v_total_paid);

  UPDATE public.orders
  SET amount_paid       = v_total_paid,
      remaining_balance = v_remaining,
      payment_status    = public.derive_payment_status(v_shipping_cost, v_total_paid)
  WHERE id = v_order_id;

  RETURN NULL;
END;
$function$;

CREATE TRIGGER trigger_update_totals_after_payment
AFTER INSERT OR UPDATE OR DELETE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION public.update_order_payment_totals();
