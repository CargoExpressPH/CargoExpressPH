-- Minimal harness schema for update_order_contact_details() (20260915120000),
-- run against a real embedded Postgres (PGlite). Same approach as the other
-- *-pgtest suites: a hand-built harness gives just enough of the real
-- orders/profiles/activity_logs/is_admin shape, then the REAL migration file
-- is applied verbatim on top, so what's tested is byte-for-byte the SQL that
-- ships.

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

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  tracking_number VARCHAR(50) NOT NULL UNIQUE,
  status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  sender_name TEXT, sender_phone TEXT, sender_province TEXT, sender_city TEXT,
  sender_barangay TEXT, sender_street TEXT, sender_landmark TEXT, sender_address TEXT,
  receiver_name TEXT, receiver_phone TEXT, receiver_province TEXT, receiver_city TEXT,
  receiver_barangay TEXT, receiver_street TEXT, receiver_landmark TEXT, receiver_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID,
  admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
  module TEXT NOT NULL CHECK (module = ANY (ARRAY['Orders','Trips','Payments','Chat','Authentication','System','Sales & Reports','Customers','Feedback'])),
  action TEXT NOT NULL,
  record_type TEXT,
  record_id UUID,
  record_ref TEXT,
  previous_value JSONB,
  new_value JSONB,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_event_id UUID
);
