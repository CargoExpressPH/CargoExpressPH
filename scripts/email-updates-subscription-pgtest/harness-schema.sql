-- Minimal harness schema for the "Email Updates" subscription feature
-- (20260916150000_email_updates_subscription.sql), run against a real
-- embedded Postgres (PGlite). Same approach as the other *-pgtest suites: a
-- hand-built harness gives just enough of the real
-- profiles/contact_inquiries/is_admin shape, then the REAL migration file
-- is applied verbatim on top, so what's tested is byte-for-byte the SQL
-- that ships.

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
  email TEXT,
  role VARCHAR(20) DEFAULT 'customer' CHECK (role = ANY (ARRAY['admin','customer'])),
  wants_announcements BOOLEAN NOT NULL DEFAULT false
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

CREATE TABLE contact_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '09171234567',
  message TEXT NOT NULL DEFAULT 'Test inquiry message, long enough.',
  status TEXT NOT NULL DEFAULT 'new',
  contact_phone TEXT,
  contact_email TEXT,
  wants_announcements BOOLEAN NOT NULL DEFAULT false,
  assigned_admin_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
