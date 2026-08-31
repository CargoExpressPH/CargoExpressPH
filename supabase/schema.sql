-- ============================================================
-- CargoExpress PH — Complete Supabase PostgreSQL Schema
-- Single source-of-truth for the entire database.
-- Synced from LIVE database on 2026-08-25
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================


-- ===================== EXTENSIONS =====================
CREATE EXTENSION IF NOT EXISTS "pg_cron";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "supabase_vault";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ===================== 1. ACTIVITY_LOGS =====================
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  admin_name TEXT NOT NULL DEFAULT 'Unknown Admin'::text,
  module TEXT NOT NULL CHECK (module = ANY (ARRAY['Orders'::text, 'Trips'::text, 'Payments'::text, 'Chat'::text, 'Authentication'::text, 'System'::text, 'Sales & Reports'::text, 'Customers'::text, 'Feedback'::text])),
  action TEXT NOT NULL,
  record_type TEXT,
  record_id UUID,
  record_ref TEXT,
  previous_value JSONB,
  new_value JSONB,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ===================== 2. ANNOUNCEMENTS =====================
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  author_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  comments JSONB DEFAULT '[]'::jsonb
);


-- ===================== 3. CHAT_MESSAGES =====================
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_role VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);


-- ===================== 4. COMPANY_INFORMATION =====================
CREATE TABLE IF NOT EXISTS company_information (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4() CHECK (id = '00000000-0000-0000-0000-000000000001'::uuid),
  name TEXT,
  short_description TEXT,
  long_description TEXT,
  banner_image_url TEXT,
  banner_title TEXT,
  banner_description TEXT,
  banner_button_text TEXT,
  banner_button_link TEXT,
  email TEXT,
  facebook TEXT,
  messenger TEXT,
  website TEXT,
  smart_phone TEXT,
  globe_phone TEXT,
  manila_address TEXT,
  bohol_address TEXT,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  default_price_per_kg NUMERIC DEFAULT 0,
  features JSONB DEFAULT '[]'::jsonb,
  coverage JSONB DEFAULT '[]'::jsonb
);


-- ===================== 5. CONTACT_INQUIRIES =====================
CREATE TABLE IF NOT EXISTS contact_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) >= 2 AND char_length(btrim(name)) <= 100),
  phone TEXT NOT NULL CHECK (char_length(btrim(phone)) >= 6 AND char_length(btrim(phone)) <= 100),
  message TEXT NOT NULL CHECK (char_length(btrim(message)) >= 10 AND char_length(btrim(message)) <= 2000),
  status TEXT NOT NULL DEFAULT 'new'::text CHECK (status = ANY (ARRAY['new'::text, 'read'::text, 'resolved'::text])),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  contact_phone TEXT,
  contact_email TEXT,
  assigned_admin_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  first_response_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  push_dispatched_at TIMESTAMPTZ,
  push_dispatch_started_at TIMESTAMPTZ,
  push_dispatch_claim_id UUID,
  ip TEXT
);


-- ===================== 6. CONVERSATIONS =====================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'bot_active'::text CHECK (status = ANY (ARRAY['bot_active'::text, 'waiting'::text, 'waiting_customer'::text, 'resolved'::text])),
  escalated BOOLEAN NOT NULL DEFAULT false,
  first_response_at TIMESTAMPTZ,
  last_customer_message_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  bot_resolved BOOLEAN
);


-- ===================== 7. CUSTOMER_FEEDBACK =====================
CREATE TABLE IF NOT EXISTS customer_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  message TEXT NOT NULL,
  is_hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);


-- ===================== 8. LEGAL_CONSENTS =====================
CREATE TABLE IF NOT EXISTS legal_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type = ANY (ARRAY['terms_of_service'::text, 'privacy_policy'::text])),
  document_version TEXT NOT NULL CHECK (length(TRIM(BOTH FROM document_version)) > 0),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'registration'::text CHECK (source = ANY (ARRAY['registration'::text, 'account_update'::text])),
  FOREIGN KEY (document_type, document_version) REFERENCES legal_documents(document_type, version),
  UNIQUE (user_id, document_type, document_version)
);


-- ===================== 9. LEGAL_DOCUMENTS =====================
CREATE TABLE IF NOT EXISTS legal_documents (
  document_type TEXT CHECK (document_type = ANY (ARRAY['terms_of_service'::text, 'privacy_policy'::text])),
  version TEXT CHECK (length(TRIM(BOTH FROM version)) > 0),
  url_path TEXT NOT NULL CHECK (url_path = ANY (ARRAY['/terms'::text, '/privacy'::text])),
  effective_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_current BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (document_type, version)
);


-- ===================== 10. NOTIFICATION_DELIVERY_ATTEMPTS =====================
CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_token_id UUID REFERENCES user_device_tokens(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL CHECK (status::text = ANY (ARRAY['sent'::character varying, 'failed'::character varying, 'skipped'::character varying]::text[])),
  provider_message_id TEXT,
  error_message TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ===================== 11. NOTIFICATIONS =====================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(30) DEFAULT 'general'::character varying CHECK (type::text = ANY (ARRAY['order_update'::character varying, 'trip_update'::character varying, 'announcement'::character varying, 'general'::character varying, 'inquiry'::character varying, 'feedback'::character varying, 'chat_message'::character varying]::text[])),
  reference_id UUID,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);


-- ===================== 12. ORDER_STATUS_EVENTS =====================
CREATE TABLE IF NOT EXISTS order_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  note TEXT
);


-- ===================== 13. ORDERS =====================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id UUID REFERENCES trips(id) ON DELETE SET NULL,
  origin VARCHAR(100) DEFAULT NULL::character varying,
  destination VARCHAR(100) DEFAULT NULL::character varying,
  tracking_number VARCHAR(50) NOT NULL UNIQUE,
  sender_name VARCHAR(100) NOT NULL,
  sender_phone VARCHAR(20) NOT NULL,
  sender_address TEXT NOT NULL,
  receiver_name VARCHAR(100) NOT NULL,
  receiver_phone VARCHAR(20) NOT NULL,
  receiver_address TEXT NOT NULL,
  package_description TEXT,
  actual_weight DECIMAL(10,2) DEFAULT NULL::numeric CHECK (actual_weight IS NULL OR actual_weight <= 10000::numeric),
  shipping_cost DECIMAL(10,2) DEFAULT 0,
  payer_type VARCHAR(20) DEFAULT NULL::character varying CHECK (payer_type::text = ANY (ARRAY['sender'::character varying, 'receiver'::character varying]::text[])),
  payment_method VARCHAR(20) DEFAULT NULL::character varying CHECK (payment_method::text = ANY (ARRAY['cash'::character varying, 'gcash'::character varying, 'paylater'::character varying]::text[])),
  payment_status VARCHAR(20) DEFAULT 'unpaid'::character varying CHECK (payment_status::text = ANY (ARRAY['paid'::character varying, 'partial'::character varying, 'unpaid'::character varying]::text[])),
  amount_paid DECIMAL(10,2) DEFAULT 0.00 CHECK (amount_paid >= 0::numeric),
  remaining_balance DECIMAL(10,2) DEFAULT 0.00 CHECK (remaining_balance >= 0::numeric),
  promised_payment_date DATE,
  status VARCHAR(30) DEFAULT 'Pending'::character varying CHECK (status::text = ANY (ARRAY['Pending Review'::text, 'Pending'::text, 'Assigned'::text, 'Picked Up'::text, 'Pending Cancellation'::text, 'In Transit'::text, 'Arrived at Hub'::text, 'Out for Delivery'::text, 'Delivered'::text, 'Cancelled'::text])),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  sender_facebook TEXT,
  sender_city TEXT,
  receiver_facebook TEXT,
  receiver_city TEXT,
  receiver_province TEXT,
  sender_province TEXT,
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  delivery_photos JSONB DEFAULT '[]'::jsonb,
  payment_reference VARCHAR(255) DEFAULT NULL::character varying,
  service_area_status TEXT DEFAULT 'standard'::text CHECK (service_area_status = ANY (ARRAY['standard'::text, 'for_review'::text, 'approved'::text, 'rejected'::text])),
  service_area_remarks TEXT,
  featured_on_website BOOLEAN DEFAULT false,
  featured_title TEXT,
  featured_caption TEXT,
  featured_image_type TEXT,
  featured_at TIMESTAMPTZ,
  reassignment_history JSONB DEFAULT '[]'::jsonb,
  payment_preference TEXT DEFAULT 'unspecified'::text,
  cancellation_details JSONB,
  CONSTRAINT orders_trip_required_for_active_status CHECK ((status::text = ANY (ARRAY['Pending Review'::character varying, 'Pending'::character varying, 'Pending Cancellation'::character varying, 'Cancelled'::character varying]::text[])) OR trip_id IS NOT NULL)
);


-- ===================== 14. PAYMENT_ATTEMPTS =====================
CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0::numeric),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'chargeable'::text, 'reconciled'::text, 'failed'::text])),
  payment_id TEXT UNIQUE,
  payment_status TEXT,
  actual_weight DECIMAL(10,2) DEFAULT NULL::numeric,
  payer_type VARCHAR(20) DEFAULT 'sender'::character varying CHECK (payer_type::text = ANY (ARRAY['sender'::character varying, 'receiver'::character varying]::text[])),
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  last_error TEXT,
  reconciled_at TIMESTAMPTZ,
  created_by UUID DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_type TEXT DEFAULT 'full'::text CHECK (payment_type = ANY (ARRAY['full'::text, 'paylater'::text])),
  estimated_cost DECIMAL(10,2) DEFAULT NULL::numeric,
  promised_payment_date DATE
);


-- ===================== 15. PAYMENT_TRANSACTIONS =====================
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  payment_method TEXT NOT NULL,
  transaction_reference TEXT,
  payment_status TEXT NOT NULL,
  admin_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  admin_name TEXT NOT NULL DEFAULT 'Unknown Admin'::text,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_type TEXT DEFAULT 'Additional Payment'::text,
  payment_date DATE,
  receipt_url TEXT
);


-- ===================== 16. PROFILES =====================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  phone VARCHAR(20) DEFAULT NULL::character varying,
  address_lot_block VARCHAR(255) DEFAULT NULL::character varying,
  address_street VARCHAR(255) DEFAULT NULL::character varying,
  address_barangay VARCHAR(255) DEFAULT NULL::character varying,
  address_city VARCHAR(255) DEFAULT NULL::character varying,
  address_province VARCHAR(255) DEFAULT NULL::character varying,
  role VARCHAR(20) DEFAULT 'customer'::character varying CHECK (role::text = ANY (ARRAY['admin'::character varying, 'customer'::character varying]::text[])),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  facebook_name TEXT,
  address_landmark TEXT
);


-- ===================== 17. TRIPS =====================
CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_number VARCHAR(50) NOT NULL UNIQUE,
  origin VARCHAR(100) NOT NULL,
  destination VARCHAR(100) NOT NULL,
  departure_date TIMESTAMPTZ NOT NULL,
  arrival_date TIMESTAMPTZ,
  capacity INTEGER DEFAULT 0,
  price_per_kg DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'scheduled'::character varying CHECK (status::text = ANY (ARRAY['scheduled'::character varying, 'in_progress'::character varying, 'arrived'::character varying, 'completed'::character varying, 'cancelled'::character varying]::text[])),
  notes TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  -- Actual departure instant, stamped by guard_trip_status_transition() the
  -- moment status moves to in_progress (Start Trip). NULL until then, never
  -- accepted from the client. departure_date above is the admin-scheduled
  -- DATE (date-only as of 20260829160000); this is server-truth for when
  -- the trip actually left.
  departure_at TIMESTAMPTZ,
  CONSTRAINT trips_arrival_after_departure CHECK (arrival_date IS NULL OR arrival_date >= departure_date)
);


-- ===================== 18. USER_DEVICE_TOKENS =====================
CREATE TABLE IF NOT EXISTS user_device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  device_id TEXT
);


-- ============================================================
-- FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION public.add_announcement_comment(p_announcement_id uuid, p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id  UUID := auth.uid();
  v_name     TEXT;
  v_text     TEXT := btrim(COALESCE(p_text, ''));
  v_comment  JSONB;
  v_comments JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to comment.' USING ERRCODE = '42501';
  END IF;

  IF v_text = '' THEN
    RAISE EXCEPTION 'Comment cannot be empty.' USING ERRCODE = '22023';
  END IF;

  IF length(v_text) > 500 THEN
    RAISE EXCEPTION 'Comment must be 500 characters or less.' USING ERRCODE = '22023';
  END IF;

  -- The display name is read here, not passed in, for the same reason the id
  -- is: it is the author's identity and the client does not get to assert it.
  -- A profile with no name is left as the honest placeholder rather than
  -- backfilled with an email or an id.
  SELECT name INTO v_name FROM profiles WHERE id = v_user_id;

  v_comment := jsonb_build_object(
    'id',         gen_random_uuid(),
    'user_id',    v_user_id,
    'name',       COALESCE(NULLIF(btrim(v_name), ''), 'Customer'),
    'text',       v_text,
    'created_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  -- Concurrent appends are safe: UPDATE locks the row and, under READ
  -- COMMITTED, the second writer re-reads the freshly committed array before
  -- concatenating. A read-then-write from the client could not make that
  -- promise — it would lose whichever comment landed first.
  UPDATE announcements
     SET comments = COALESCE(comments, '[]'::jsonb) || jsonb_build_array(v_comment)
   WHERE id = p_announcement_id
   RETURNING comments INTO v_comments;

  IF v_comments IS NULL THEN
    RAISE EXCEPTION 'Announcement not found.' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_comments;
END;
$function$



CREATE OR REPLACE FUNCTION public.auto_resolve_stale_conversations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH swept AS (
    UPDATE public.conversations
       SET status = 'resolved'
     WHERE status = 'waiting_customer'
       AND COALESCE(last_customer_message_at, created_at) < now() - interval '7 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM swept;
  RETURN v_count;
END;
$function$



CREATE OR REPLACE FUNCTION public.cancel_own_pending_order(p_order_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'Bookings are no longer cancelled instantly. Submit a cancellation request with a reason — an admin reviews it before the booking is cancelled.';
END;
$function$



CREATE OR REPLACE FUNCTION public.claim_contact_inquiry_push(p_inquiry_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_dispatched_at TIMESTAMPTZ;
  v_started_at TIMESTAMPTZ;
  v_claim_id UUID := gen_random_uuid();
BEGIN
  SELECT push_dispatched_at, push_dispatch_started_at
    INTO v_dispatched_at, v_started_at
    FROM public.contact_inquiries
   WHERE id = p_inquiry_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inquiry not found';
  END IF;

  IF v_dispatched_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF v_started_at IS NOT NULL AND v_started_at > now() - INTERVAL '5 minutes' THEN
    RETURN NULL;
  END IF;

  UPDATE public.contact_inquiries
     SET push_dispatch_started_at = now(),
         push_dispatch_claim_id = v_claim_id
   WHERE id = p_inquiry_id;

  RETURN v_claim_id;
END;
$function$



CREATE OR REPLACE FUNCTION public.claim_push_device_registration(p_device_id text, p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_device_id TEXT := NULLIF(btrim(p_device_id), '');
  v_token TEXT := NULLIF(btrim(p_token), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF v_device_id IS NULL OR v_token IS NULL THEN
    RAISE EXCEPTION 'A device ID and push token are required';
  END IF;
  IF char_length(v_device_id) > 200 OR char_length(v_token) > 20000 THEN
    RAISE EXCEPTION 'Push registration value is too long';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_device_id));
  DELETE FROM public.user_device_tokens
   WHERE device_id = v_device_id
      OR token = v_token;
  INSERT INTO public.user_device_tokens (user_id, device_id, token)
  VALUES (auth.uid(), v_device_id, v_token);
END;
$function$



CREATE OR REPLACE FUNCTION public.complete_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.contact_inquiries
     SET push_dispatched_at = now(),
         push_dispatch_started_at = NULL,
         push_dispatch_claim_id = NULL
   WHERE id = p_inquiry_id
     AND push_dispatch_claim_id = p_claim_id
     AND push_dispatched_at IS NULL;
END;
$function$



CREATE OR REPLACE FUNCTION public.create_admin_notifications_rpc(p_title text, p_message text, p_type text, p_reference_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(admin_id uuid, notification_id uuid, notification_title text, notification_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_title TEXT;
  v_message TEXT;
  v_tracking_number TEXT;
  v_sender_name TEXT;
  v_rating INTEGER;
  v_feedback_message TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_type = 'order_update' THEN
    SELECT o.tracking_number, o.sender_name
      INTO v_tracking_number, v_sender_name
      FROM public.orders AS o
     WHERE o.id = p_reference_id
       AND o.user_id = auth.uid();

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Notification reference is not owned by the caller';
    END IF;

    v_title := 'New Booking';
    v_message := format(
      'New order %s from %s',
      v_tracking_number,
      COALESCE(NULLIF(btrim(v_sender_name), ''), 'Customer')
    );
  ELSIF p_type = 'feedback' THEN
    SELECT f.rating, f.message
      INTO v_rating, v_feedback_message
      FROM public.customer_feedback AS f
      JOIN public.orders AS o ON o.id = f.order_id
     WHERE f.order_id = p_reference_id
       AND f.customer_id = auth.uid()
       AND o.user_id = auth.uid()
       AND o.status = 'Delivered';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Notification reference is not an owned delivered-order feedback';
    END IF;

    v_title := 'New Customer Feedback';
    v_message := format(
      '%s★ rating%s',
      v_rating,
      CASE
        WHEN NULLIF(btrim(v_feedback_message), '') IS NULL THEN ''
        ELSE ': ' || left(btrim(v_feedback_message), 60)
      END
    );
  ELSE
    RAISE EXCEPTION 'Unsupported customer notification event';
  END IF;

  -- One notification fan-out per event key. The advisory lock closes the
  -- race where two browser callbacks arrive in the same millisecond.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_type || ':' || COALESCE(p_reference_id::TEXT, ''), 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.notifications AS n
     WHERE n.type = p_type
       AND n.reference_id = p_reference_id
       AND n.created_at > now() - INTERVAL '10 minutes'
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    SELECT p.id, v_title, v_message, p_type, p_reference_id
      FROM public.profiles AS p
     WHERE p.role = 'admin'
    RETURNING id, user_id
  )
  SELECT user_id, id, v_title, v_message FROM inserted;
END;
$function$



CREATE OR REPLACE FUNCTION public.current_trip_weight(p_trip_id uuid, p_exclude_order_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- actual_weight only: a booking that has not been weighed contributes
  -- nothing, because nothing is known about it.
  SELECT COALESCE(SUM(COALESCE(actual_weight, 0)), 0)
    FROM public.orders
   WHERE trip_id = p_trip_id
     AND status <> 'Cancelled'
     AND (p_exclude_order_id IS NULL OR id <> p_exclude_order_id);
$function$



CREATE OR REPLACE FUNCTION public.derive_payment_status(p_shipping_cost numeric, p_amount_paid numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    -- Nothing collected. Also covers an unpriced booking (cost 0, paid 0),
    -- which the old `remaining <= 0` test wrongly called 'paid'.
    WHEN COALESCE(p_amount_paid, 0) <= 0 THEN 'unpaid'
    -- Settled. The half-centavo tolerance absorbs DECIMAL(10,2) rounding so
    -- a fully paid order is never left one centavo short of 'paid'.
    WHEN COALESCE(p_amount_paid, 0) >= COALESCE(p_shipping_cost, 0) - 0.005 THEN 'paid'
    ELSE 'partial'
  END;
$function$



CREATE OR REPLACE FUNCTION public.effective_trip_price(p_trip_id uuid)
 RETURNS numeric
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT NULLIF(price_per_kg, 0) FROM public.trips WHERE id = p_trip_id),
    public.global_price_per_kilo()
  );
$function$



CREATE OR REPLACE FUNCTION public.generate_order_tracking_number()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  candidate TEXT;
BEGIN
  LOOP
    candidate := 'CE-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || FLOOR(1000 + RANDOM() * 9000)::INT;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.orders WHERE tracking_number = candidate);
  END LOOP;
  RETURN candidate;
END;
$function$



CREATE OR REPLACE FUNCTION public.get_featured_deliveries()
 RETURNS TABLE(id uuid, featured_title text, featured_caption text, featured_image_type text, featured_at timestamp with time zone, featured_photo text, receiver_city text, receiver_province text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$



CREATE OR REPLACE FUNCTION public.get_order_status_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT COALESCE(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
    INTO payload
  FROM (
    SELECT status, COUNT(*) AS n
      FROM public.orders
     GROUP BY status
  ) s;

  -- A status with no orders is simply absent; the client reads a missing key
  -- as 0. Padding every known status with a zero here would invent rows the
  -- table does not have.
  RETURN payload;
END;
$function$



CREATE OR REPLACE FUNCTION public.get_public_business_profile()
 RETURNS TABLE(name text, smart_phone text, globe_phone text, facebook_link text, manila_address text, bohol_address text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    c.name,
    c.smart_phone,
    c.globe_phone,
    c.facebook AS facebook_link,
    c.manila_address,
    c.bohol_address
  FROM public.company_information c
  WHERE c.id = '00000000-0000-0000-0000-000000000001'
  LIMIT 1;
$function$



CREATE OR REPLACE FUNCTION public.get_public_feedback()
 RETURNS TABLE(id uuid, rating integer, message text, created_at timestamp with time zone, customer_name text, featured_on_website boolean, featured_image_type text, featured_photo text, receiver_city text, receiver_province text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$



CREATE OR REPLACE FUNCTION public.get_public_order_events(p_tracking_number text)
 RETURNS TABLE(status character varying, changed_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT e.status, MIN(e.changed_at) AS changed_at
  FROM public.order_status_events e
  JOIN public.orders o ON o.id = e.order_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  GROUP BY e.status
  ORDER BY MIN(e.changed_at);
$function$



CREATE OR REPLACE FUNCTION public.get_sales_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  WITH active_orders AS (
    SELECT
      o.*,
      -- THE definition of what an order owes. Derived, so it cannot lag the
      -- payment ledger the way the stored remaining_balance column can.
      GREATEST(COALESCE(o.shipping_cost, 0) - COALESCE(o.amount_paid, 0), 0) AS outstanding,
      -- Weighed = priced. An unweighed parcel owes nothing only because it has
      -- not been billed yet; that is not the same as settled.
      (COALESCE(o.actual_weight, 0) > 0) AS is_priced,
      (o.status IN ('Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered')) AS is_tracked
    FROM public.orders o
    WHERE o.status <> 'Cancelled'
  ),
  ledger AS (
    SELECT
      LOWER(COALESCE(NULLIF(TRIM(pt.payment_method), ''), 'unspecified')) AS method,
      COALESCE(SUM(pt.amount), 0) AS total,
      COUNT(*) AS payment_count
    FROM public.payment_transactions pt
    JOIN active_orders o ON o.id = pt.order_id
    WHERE pt.payment_status IN ('paid', 'partial')
    GROUP BY 1
  ),
  ledger_rollup AS (
    SELECT
      COALESCE(SUM(total) FILTER (WHERE method = 'cash'), 0)     AS cash_total,
      COALESCE(SUM(total) FILTER (WHERE method = 'gcash'), 0)    AS gcash_total,
      COALESCE(SUM(total) FILTER (WHERE method = 'paylater'), 0) AS paylater_total,
      COALESCE(SUM(total), 0)                                    AS ledger_total,
      COALESCE(
        jsonb_agg(
          jsonb_build_object('method', method, 'total', total, 'count', payment_count)
          ORDER BY total DESC
        ),
        '[]'::jsonb
      ) AS method_totals
    FROM ledger
  ),
  order_rollup AS (
    SELECT
      COALESCE(SUM(shipping_cost), 0) AS total_revenue,
      COALESCE(SUM(amount_paid), 0)   AS paid_total,
      COALESCE(SUM(outstanding) FILTER (WHERE is_tracked), 0) AS outstanding_tracked,
      COALESCE(SUM(outstanding), 0)                           AS outstanding_all,
      COALESCE(SUM(remaining_balance) FILTER (WHERE is_tracked), 0) AS outstanding_stored,
      COUNT(*) FILTER (WHERE is_tracked AND outstanding > 0.005)    AS unpaid_count,
      COUNT(*) FILTER (WHERE NOT is_priced)                         AS unpriced_count
    FROM active_orders
  ),
  summary AS (
    SELECT jsonb_build_object(
      'totalRevenue',         o.total_revenue,
      'cashTotal',            l.cash_total,
      'gcashTotal',           l.gcash_total,
      'paylaterTotal',        l.paylater_total,
      'methodTotals',         l.method_totals,
      'ledgerTotal',          l.ledger_total,
      'unattributedTotal',    GREATEST(o.paid_total - l.ledger_total, 0),
      'paidTotal',            o.paid_total,
      'outstandingTotal',     o.outstanding_tracked,
      'outstandingAllOrders', o.outstanding_all,
      'outstandingStored',    o.outstanding_stored,
      -- Legacy alias. Kept so a stale bundle mid-deploy still renders.
      'unpaidTotal',          o.outstanding_all,
      'unpaidCount',          o.unpaid_count,
      'unpricedCount',        o.unpriced_count
    ) AS value
    FROM order_rollup o, ledger_rollup l
  ),
  monthly AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.month DESC), '[]'::jsonb) AS value
    FROM (
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COALESCE(SUM(shipping_cost), 0) AS total_revenue,
        COALESCE(SUM(amount_paid), 0) AS collected,
        COALESCE(SUM(outstanding), 0) AS outstanding
      FROM active_orders
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
      LIMIT 24
    ) m
  ),
  unpaid AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.created_at DESC), '[]'::jsonb) AS value
    FROM (
      SELECT id, tracking_number, created_at, status, shipping_cost, amount_paid,
             outstanding AS remaining_balance, payment_status
      FROM active_orders
      WHERE is_tracked AND outstanding > 0.005
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
$function$



CREATE OR REPLACE FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_extract_query_trgm$function$



CREATE OR REPLACE FUNCTION public.gin_extract_value_trgm(text, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_extract_value_trgm$function$



CREATE OR REPLACE FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_trgm_consistent$function$



CREATE OR REPLACE FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal)
 RETURNS "char"
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_trgm_triconsistent$function$



CREATE OR REPLACE FUNCTION public.global_price_per_kilo()
 RETURNS numeric
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT default_price_per_kg FROM public.company_information WHERE id = '00000000-0000-0000-0000-000000000001' LIMIT 1), 70);
$function$



CREATE OR REPLACE FUNCTION public.gtrgm_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_compress$function$



CREATE OR REPLACE FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_consistent$function$



CREATE OR REPLACE FUNCTION public.gtrgm_decompress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_decompress$function$



CREATE OR REPLACE FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_distance$function$



CREATE OR REPLACE FUNCTION public.gtrgm_in(cstring)
 RETURNS gtrgm
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_in$function$



CREATE OR REPLACE FUNCTION public.gtrgm_options(internal)
 RETURNS void
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE
AS '$libdir/pg_trgm', $function$gtrgm_options$function$



CREATE OR REPLACE FUNCTION public.gtrgm_out(gtrgm)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_out$function$



CREATE OR REPLACE FUNCTION public.gtrgm_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_penalty$function$



CREATE OR REPLACE FUNCTION public.gtrgm_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_picksplit$function$



CREATE OR REPLACE FUNCTION public.gtrgm_same(gtrgm, gtrgm, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_same$function$



CREATE OR REPLACE FUNCTION public.gtrgm_union(internal, internal)
 RETURNS gtrgm
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_union$function$



CREATE OR REPLACE FUNCTION public.guard_activity_log_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_name     TEXT;
BEGIN
  -- Service role / trigger-internal writes: nothing to attribute, leave as-is.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.is_admin();

  IF NOT v_is_admin AND NEW.module NOT IN ('Orders', 'Authentication', 'Chat') THEN
    RAISE EXCEPTION 'Not allowed to write % activity logs', NEW.module;
  END IF;

  SELECT name INTO v_name FROM public.profiles WHERE id = v_uid;

  -- The control that actually matters: a customer-authored row can never
  -- carry a staff identity, whatever module it claims.
  NEW.admin_id   := v_uid;
  NEW.admin_name := COALESCE(NULLIF(btrim(v_name), ''), 'Unknown Admin');

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.guard_chat_message_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  actual_role TEXT;
BEGIN
  SELECT role INTO actual_role FROM public.profiles WHERE id = auth.uid();
  IF actual_role IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  
  NEW.sender_id := auth.uid();
  
  -- If a customer session inserts a bot message, preserve the bot role
  IF actual_role = 'customer' AND NEW.sender_role = 'bot' THEN
    NEW.sender_role := 'bot';
  ELSE
    NEW.sender_role := actual_role;
  END IF;
  
  RETURN NEW;
END;
$function$


CREATE OR REPLACE FUNCTION public.guard_chat_message_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Service work has no end-user JWT. Admins retain their existing full
  -- UPDATE policy. The remaining path is a customer read acknowledgement.
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF OLD.sender_role IS DISTINCT FROM 'admin'
     OR NOT EXISTS (
       SELECT 1
       FROM public.conversations
       WHERE id = OLD.conversation_id
         AND customer_id = auth.uid()
     )
  THEN
    RAISE EXCEPTION 'Customers may update only admin messages in their own conversations'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.sender_role IS DISTINCT FROM OLD.sender_role
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Customers may change only the read state of a chat message'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_read IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Customers may only mark admin messages as read'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.guard_contact_inquiry_rate_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ 
BEGIN
  IF NEW.ip IS NOT NULL AND btrim(NEW.ip) <> '' THEN
    IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE ip = NEW.ip AND created_at > now() - interval '10 minutes') >= 5 THEN
      RAISE EXCEPTION 'Too many inquiries from your network. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE phone = NEW.phone AND created_at > now() - interval '10 minutes') >= 3 THEN
      RAISE EXCEPTION 'Too many inquiries from this phone number. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE created_at > now() - interval '1 minute') >= 15 THEN
    RAISE EXCEPTION 'Too many inquiries right now. Please try again in a minute.' USING ERRCODE = '42501';
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.phone := btrim(NEW.phone);
  NEW.message := btrim(NEW.message);
  IF NEW.ip IS NOT NULL THEN NEW.ip := btrim(NEW.ip); END IF;
  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.guard_contact_inquiry_resolve_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN
    IF NEW.assigned_admin_id IS NULL THEN
      RAISE EXCEPTION 'Claim this inquiry before marking it resolved.' USING ERRCODE = '42501';
    ELSIF NEW.assigned_admin_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Only the admin who claimed this inquiry can mark it resolved.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.guard_conversation_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL
     OR public.is_admin()
     OR COALESCE(current_setting('app.conversation_service_write', true), 'off') = 'on'
  THEN
    RETURN NEW;
  END IF;

  IF OLD.customer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cannot modify another customer''s conversation';
  END IF;

  NEW.id                       := OLD.id;
  NEW.customer_id              := OLD.customer_id;
  NEW.created_at               := OLD.created_at;
  NEW.first_response_at        := OLD.first_response_at;
  NEW.last_customer_message_at := OLD.last_customer_message_at;
  NEW.resolved_at              := OLD.resolved_at;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'waiting' THEN
    NEW.status := OLD.status;
  END IF;

  IF NEW.escalated IS DISTINCT FROM OLD.escalated AND NEW.escalated = FALSE THEN
    NEW.escalated := OLD.escalated;
  END IF;

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.guard_customer_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip_status TEXT;
  v_departure_date TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  NEW.featured_on_website := false;
  NEW.featured_title := NULL;
  NEW.featured_caption := NULL;
  NEW.featured_image_type := NULL;
  NEW.featured_at := NULL;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT t.status, t.departure_date
      INTO v_trip_status, v_departure_date
      FROM public.trips AS t
     WHERE t.id = NEW.trip_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    -- Date-only cutoff: blocks once the PH calendar day has moved past the
    -- scheduled departure date, OR the moment status leaves 'scheduled' --
    -- whichever comes first. A same-day booking stays open all day no
    -- matter what time it currently is. See 20260829160000.
    IF v_trip_status <> 'scheduled'
       OR public.ph_calendar_day(now()) > public.ph_calendar_day(v_departure_date) THEN
      RAISE EXCEPTION 'This trip is no longer accepting bookings';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.guard_order_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row public.trips%ROWTYPE;
  weight NUMERIC;
  price NUMERIC;
BEGIN
  -- ── Cancellation review hold ──────────────────────────────────────────────
  IF OLD.status = 'Pending Cancellation'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('Cancelled', COALESCE(OLD.cancellation_details->>'previous_status', 'Pending'))
  THEN
    RAISE EXCEPTION
      'Order % has a cancellation request awaiting review. Approve or reject it before changing its status.',
      NEW.tracking_number;
  END IF;

  IF NEW.trip_id IS NOT NULL AND NEW.status <> 'Cancelled' THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
    -- Capacity check removed to allow administrators to manually exceed limits.

    IF OLD.trip_id IS DISTINCT FROM NEW.trip_id AND NEW.status = 'Pending' THEN
      NEW.status := 'Assigned';
    END IF;
  END IF;

  IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN
    weight := COALESCE(NEW.actual_weight, 0);
    price := CASE
      WHEN NEW.trip_id IS NOT NULL THEN public.effective_trip_price(NEW.trip_id)
      ELSE public.global_price_per_kilo()
    END;
    NEW.shipping_cost := ROUND(weight * price, 2);
    NEW.remaining_balance := GREATEST(0, NEW.shipping_cost - COALESCE(NEW.amount_paid, 0));
    -- The badge follows the balance. Without this a re-weighed order kept a
    -- stale 'Paid' label while money was owing (20260805120000).
    NEW.payment_status := public.derive_payment_status(NEW.shipping_cost, NEW.amount_paid);
  END IF;

  -- ── Warehouse dispatch gate (20260804100000, 20260806030000) ─────────────
  -- Placed last so it sees the recomputed weight and remaining_balance above.
  IF NEW.status = 'Out for Delivery' AND OLD.status IS DISTINCT FROM NEW.status THEN

    -- (a) Priced? An unweighed parcel has no cost, so its ₱0.00 balance must
    -- not be read as "paid". Applies to every payer type.
    IF COALESCE(NEW.actual_weight, 0) <= 0 THEN
      RAISE EXCEPTION
        'Cannot dispatch order % — it has not been weighed, so it has no price yet. Record the actual weight first.',
        NEW.tracking_number;
    END IF;

    -- (b) Paid? Unpaid cargo is held at the destination warehouse and not
    -- dispatched for doorstep delivery. Freight Collect is exempt (payment is
    -- due at the door); a recorded Promise Date is the explicit override.
    IF COALESCE(NEW.payer_type, 'sender') <> 'receiver'
       AND COALESCE(NEW.remaining_balance, 0) > 0
       AND NEW.promised_payment_date IS NULL
    THEN
      RAISE EXCEPTION
        'Cannot dispatch order % — ₱% is still owing. Settle the balance, or record a Promise Date to dispatch anyway.',
        NEW.tracking_number,
        TO_CHAR(COALESCE(NEW.remaining_balance, 0), 'FM999999990.00');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.guard_profile_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$



CREATE OR REPLACE FUNCTION public.guard_trip_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count     INT;
  v_unsettled TEXT;
BEGIN
  -- Start Trip: stamp the real departure instant server-side. This is the
  -- ONLY writer of departure_at -- whatever the client sent in NEW is
  -- discarded and replaced with the server's own clock, exactly once, on
  -- the transition INTO 'in_progress'. See 20260829160000.
  IF NEW.status = 'in_progress' AND OLD.status IS DISTINCT FROM 'in_progress' THEN
    NEW.departure_at := now();
  END IF;

  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    SELECT COUNT(*)
      INTO v_count
      FROM public.orders
     WHERE trip_id = NEW.id
       AND status <> 'Cancelled'
       AND COALESCE(remaining_balance, 0) > 0;

    IF v_count > 0 THEN
      SELECT STRING_AGG(tracking_number, ', ')
        INTO v_unsettled
        FROM (
          SELECT tracking_number
            FROM public.orders
           WHERE trip_id = NEW.id
             AND status <> 'Cancelled'
             AND COALESCE(remaining_balance, 0) > 0
           ORDER BY tracking_number
           LIMIT 5
        ) t;

      -- The truncation marker is appended to the string, NOT passed as another
      -- RAISE argument: '%%' in a RAISE format string is an escaped literal '%',
      -- not two placeholders, so the earlier version passed 4 arguments to a
      -- 2-placeholder format and failed to compile with
      --   ERROR 42601: too many parameters specified for RAISE
      IF v_count > 5 THEN
        v_unsettled := v_unsettled || ' …';
      END IF;

      RAISE EXCEPTION
        'Cannot complete trip % — % order(s) still have an unpaid balance: %',
        NEW.trip_number,
        v_count,
        v_unsettled;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terms_version TEXT;
  v_privacy_version TEXT;
  v_requested_version TEXT;
BEGIN
  SELECT version INTO v_terms_version
  FROM public.legal_documents
  WHERE document_type = 'terms_of_service' AND is_current = true;

  SELECT version INTO v_privacy_version
  FROM public.legal_documents
  WHERE document_type = 'privacy_policy' AND is_current = true;

  v_requested_version := NULLIF(trim(NEW.raw_user_meta_data->>'legal_policy_version'), '');

  IF v_terms_version IS NULL OR v_privacy_version IS NULL THEN
    RAISE EXCEPTION 'Account creation is temporarily unavailable because legal documents are not published.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(NEW.raw_user_meta_data->>'legal_terms_accepted', 'false') <> 'true'
     OR COALESCE(NEW.raw_user_meta_data->>'legal_privacy_accepted', 'false') <> 'true'
     OR v_requested_version IS DISTINCT FROM v_terms_version
     OR v_requested_version IS DISTINCT FROM v_privacy_version THEN
    RAISE EXCEPTION 'The current Terms of Service and Privacy Policy must be accepted to create an account.'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.profiles (id, email, name, role, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'name', ''), initcap(split_part(NEW.email, '@', 1))),
    'customer',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.legal_consents (user_id, document_type, document_version, source)
  VALUES
    (NEW.id, 'terms_of_service', v_terms_version, 'registration'),
    (NEW.id, 'privacy_policy', v_privacy_version, 'registration');

  RETURN NEW;
END;
$function$



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
$function$



CREATE OR REPLACE FUNCTION public.is_featured_photo_path(p_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.orders o
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN o.featured_image_type = 'delivery'
             AND jsonb_array_length(COALESCE(o.delivery_photos, '[]'::jsonb)) > 0
          THEN o.delivery_photos -> 0
        WHEN jsonb_array_length(COALESCE(o.pickup_photos, '[]'::jsonb)) > 0
          THEN o.pickup_photos -> 0
        ELSE NULL
      END AS photo
    ) selected
    CROSS JOIN LATERAL (
      SELECT CASE jsonb_typeof(selected.photo)
        WHEN 'object' THEN selected.photo ->> 'path'
        WHEN 'string' THEN selected.photo #>> '{}'
        ELSE NULL
      END AS raw_path
    ) photo_ref
    WHERE o.featured_on_website = TRUE
      AND (
        CASE
          WHEN photo_ref.raw_path LIKE '%/cargo-photos/%'
            THEN split_part(regexp_replace(photo_ref.raw_path, '^.*/cargo-photos/', ''), '?', 1)
          ELSE photo_ref.raw_path
        END
      ) = p_path
  );
$function$



CREATE OR REPLACE FUNCTION public.log_customer_chat_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.sender_role = 'customer' THEN
    IF (SELECT count(*) FROM chat_messages WHERE conversation_id = NEW.conversation_id) = 1 THEN
      INSERT INTO activity_logs (admin_name, module, action, record_type, record_id, record_ref, details, created_at)
      SELECT profiles.name, 'Chat', 'Customer Started Conversation', 'conversation', NEW.conversation_id, profiles.name, 'Customer initiated a new support conversation.', NOW()
      FROM conversations JOIN profiles ON conversations.customer_id = profiles.id
      WHERE conversations.id = NEW.conversation_id;
    ELSE
      INSERT INTO activity_logs (admin_name, module, action, record_type, record_id, record_ref, details, created_at)
      SELECT profiles.name, 'Chat', 'Customer Sent Message', 'conversation', NEW.conversation_id, profiles.name, 'Customer replied.', NOW()
      FROM conversations JOIN profiles ON conversations.customer_id = profiles.id
      WHERE conversations.id = NEW.conversation_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.log_order_status_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_status_events (order_id, status, changed_at, changed_by)
    VALUES (NEW.id, NEW.status, COALESCE(NEW.created_at, NOW()), auth.uid());
    RETURN NEW;
  END IF;

  -- UPDATE: only when the status actually moved.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.order_status_events (order_id, status, changed_at, changed_by)
    VALUES (NEW.id, NEW.status, NOW(), auth.uid());
  END IF;

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.maintain_conversation_service_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status      TEXT;
  v_resolved_at TIMESTAMPTZ;
  v_next        TEXT;
  v_new_session BOOLEAN;
BEGIN
  SELECT status, resolved_at
    INTO v_status, v_resolved_at
    FROM public.conversations
   WHERE id = NEW.conversation_id;

  -- Marks this as a SERVER decision so guard_conversation_update lets the
  -- status move through. Transaction-local and cleared immediately; a client
  -- cannot set it, since inserting a message is its own transaction.
  PERFORM set_config('app.conversation_service_write', 'on', true);

  IF NEW.sender_role = 'customer' THEN
    v_next := CASE
                -- The bot keeps the thread it is already handling.
                WHEN v_status = 'bot_active' THEN 'bot_active'
                -- Resolved within the grace window: a FOLLOW-UP, straight back
                -- to the humans who just handled it.
                WHEN v_status = 'resolved'
                     AND v_resolved_at IS NOT NULL
                     AND v_resolved_at >= now() - INTERVAL '12 hours'
                  THEN 'waiting'
                -- Resolved longer ago, or at an unknown time: a NEW question on
                -- the customer's one and only conversation row. Bot first, same
                -- as any new chat.
                WHEN v_status = 'resolved' THEN 'bot_active'
                -- waiting / waiting_customer: already ours, stays ours.
                ELSE 'waiting'
              END;

    v_new_session := (v_status = 'resolved' AND v_next = 'bot_active');

    UPDATE public.conversations
       SET last_customer_message_at = NEW.created_at,
           status      = v_next,
           escalated   = CASE WHEN v_new_session THEN FALSE ELSE escalated END,
           resolved_at = NULL
     WHERE id = NEW.conversation_id;

  ELSIF NEW.sender_role = 'admin' THEN
    -- An admin replying IS the signal that we are now waiting on the customer.
    UPDATE public.conversations
       SET first_response_at = COALESCE(first_response_at, NEW.created_at),
           status = 'waiting_customer'
     WHERE id = NEW.conversation_id;
  END IF;

  -- sender_role = 'bot' changes nothing: a bot reply is not a response for
  -- service purposes and must never clear the queue.

  PERFORM set_config('app.conversation_service_write', 'off', true);
  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.mask_name(full_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
$function$



CREATE OR REPLACE FUNCTION public.notify_admins_of_contact_inquiry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'New Contact Inquiry',
    format(
      'Inquiry from %s: %s',
      COALESCE(NULLIF(btrim(NEW.name), ''), 'Visitor'),
      left(COALESCE(btrim(NEW.message), ''), 80)
    ),
    'inquiry',
    NEW.id
  FROM public.profiles AS p
  WHERE p.role = 'admin';

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.ph_calendar_day(ts timestamp with time zone)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  SELECT ((ts + INTERVAL '8 hours') AT TIME ZONE 'UTC')::date;
$function$



CREATE OR REPLACE FUNCTION public.prepare_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row public.trips%ROWTYPE;
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

  -- A booking cannot be born already asking to be cancelled.
  NEW.cancellation_details         := NULL;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;
    NEW.status := 'Assigned';
    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
  ELSE
    NEW.status := 'Pending';
  END IF;

  -- No weight, no price. Both are set by guard_order_update the moment an
  -- admin records actual_weight at pickup.
  NEW.shipping_cost := 0;
  NEW.remaining_balance := 0;

  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.purge_old_activity_logs()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.activity_logs
  WHERE created_at < now() - interval '7 days';
END;
$function$



CREATE OR REPLACE FUNCTION public.reassign_trip(p_order_id uuid, p_new_trip_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_trip_id UUID;
  v_admin_id UUID;
  v_reassignment_history JSONB;
BEGIN
  v_admin_id := auth.uid();
  IF v_admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only administrators can reassign trips';
  END IF;

  -- Get current trip
  SELECT trip_id INTO v_old_trip_id
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_old_trip_id = p_new_trip_id THEN
    RAISE EXCEPTION 'The new trip must be different from the current trip';
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Update the order's trip_id and append to JSONB reassignment_history
  UPDATE public.orders
  SET 
    trip_id = p_new_trip_id,
    reassignment_history = COALESCE(reassignment_history, '[]'::jsonb) || jsonb_build_object(
      'id', gen_random_uuid(),
      'previous_trip_id', v_old_trip_id,
      'new_trip_id', p_new_trip_id,
      'reason', p_reason,
      'admin_id', v_admin_id,
      'created_at', now()
    )
  WHERE id = p_order_id;
END;
$function$



CREATE OR REPLACE FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text DEFAULT 'paid'::text)
 RETURNS TABLE(order_reconciled boolean, order_id uuid, payment_id text, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  attempt_row public.payment_attempts%ROWTYPE;
  order_row   public.orders%ROWTYPE;
  paid_amount DECIMAL(10,2);
  final_payment_status TEXT;
BEGIN
  SELECT *
    INTO attempt_row
    FROM public.payment_attempts
   WHERE source_id = p_source_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, p_payment_id, 'No payment attempt found for source';
    RETURN;
  END IF;

  paid_amount := COALESCE(NULLIF(p_payment_amount, 0), attempt_row.amount);

  SELECT *
    INTO order_row
    FROM public.orders
   WHERE id = attempt_row.order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.payment_attempts
       SET status         = 'failed',
           payment_id     = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status,
           last_error     = 'Order no longer exists'
     WHERE source_id = p_source_id;

    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order no longer exists';
    RETURN;
  END IF;

  IF attempt_row.payment_type = 'paylater' THEN
    final_payment_status := 'partial';
  ELSE
    final_payment_status := 'paid';
  END IF;

  -- Only record money when the payment was actually captured.
  IF p_payment_id IS NOT NULL THEN
    -- The ledger is the source of truth; trigger_update_totals_after_payment
    -- recomputes orders.amount_paid / remaining_balance / payment_status.
    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, admin_name, notes
    ) VALUES (
      attempt_row.order_id, paid_amount, 'gcash', final_payment_status,
      p_payment_id, 'System Webhook', 'Captured via PayMongo Webhook'
    )
    -- ↓↓↓ THE FIX: the index predicate is required to infer a PARTIAL index ↓↓↓
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;

    -- Order metadata only. amount_paid is deliberately NOT written here —
    -- the ledger trigger owns it.
    UPDATE public.orders
       SET payment_method        = 'gcash',
           payer_type            = COALESCE(attempt_row.payer_type, order_row.payer_type, 'sender'),
           payment_reference     = COALESCE(p_payment_id, order_row.payment_reference),
           actual_weight         = COALESCE(attempt_row.actual_weight, order_row.actual_weight),
           pickup_photos         = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos),
           promised_payment_date = COALESCE(attempt_row.promised_payment_date, order_row.promised_payment_date)
     WHERE id = attempt_row.order_id;
  END IF;

  UPDATE public.payment_attempts
     SET status         = 'reconciled',
         payment_id     = COALESCE(p_payment_id, payment_attempts.payment_id),
         payment_status = final_payment_status,
         amount         = paid_amount,
         last_error     = NULL,
         reconciled_at  = COALESCE(payment_attempts.reconciled_at, NOW())
   WHERE source_id = p_source_id;

  RETURN QUERY SELECT true, attempt_row.order_id, p_payment_id, 'Order reconciled via payment_transactions insert';
END;
$function$



CREATE OR REPLACE FUNCTION public.record_delivery_payment(p_order_id uuid, p_delivery_photos jsonb DEFAULT '[]'::jsonb, p_payment_method text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_reference text DEFAULT NULL::text, p_payment_date date DEFAULT NULL::date, p_receipt_url text DEFAULT NULL::text, p_payment_type text DEFAULT 'Balance Settlement'::text, p_notes text DEFAULT 'Balance settlement upon delivery'::text, p_promised_payment_date date DEFAULT NULL::date)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order      public.orders;
  v_admin_name TEXT;
  v_paid_after NUMERIC;
  v_label      TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Step 1 — order metadata ONLY. The ledger owns the totals.
  UPDATE public.orders
     SET delivery_photos       = COALESCE(p_delivery_photos, delivery_photos),
         payment_method        = COALESCE(p_payment_method, payment_method),
         payment_reference     = COALESCE(p_reference, payment_reference),
         promised_payment_date = COALESCE(p_promised_payment_date, promised_payment_date),
         status                = 'Delivered'
   WHERE id = p_order_id;

  -- Step 2 — the ledger, only when money actually changed hands.
  IF COALESCE(p_amount, 0) > 0 THEN
    SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

    SELECT COALESCE(SUM(amount), 0) + p_amount
      INTO v_paid_after
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial');

    SELECT CASE
             WHEN v_paid_after >= COALESCE(shipping_cost, 0) THEN 'paid'
             ELSE 'partial'
           END
      INTO v_label
      FROM public.orders
     WHERE id = p_order_id;

    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, admin_id, admin_name, notes,
      payment_type, payment_date, receipt_url
    ) VALUES (
      p_order_id, p_amount, COALESCE(p_payment_method, 'cash'), v_label,
      p_reference, auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
      p_payment_type, p_payment_date, p_receipt_url
    )
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$



CREATE OR REPLACE FUNCTION public.record_pickup_payment(p_order_id uuid, p_actual_weight numeric, p_payment_method text, p_payer_type text DEFAULT 'sender'::text, p_pickup_photos jsonb DEFAULT '[]'::jsonb, p_promised_payment_date date DEFAULT NULL::date, p_amount numeric DEFAULT NULL::numeric, p_reference text DEFAULT NULL::text, p_payment_date date DEFAULT NULL::date, p_receipt_url text DEFAULT NULL::text, p_payment_type text DEFAULT 'Initial Payment'::text, p_notes text DEFAULT 'Initial pickup payment'::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order      public.orders;
  v_admin_name TEXT;
  v_paid_after NUMERIC;
  v_label      TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF COALESCE(p_actual_weight, 0) <= 0 THEN
    RAISE EXCEPTION 'Actual weight must be greater than zero';
  END IF;

  -- Step 1 — order metadata ONLY.
  -- amount_paid / remaining_balance / payment_status are deliberately absent:
  -- the ledger trigger owns them.
  UPDATE public.orders
     SET actual_weight         = p_actual_weight,
         payment_method        = p_payment_method,
         payer_type            = COALESCE(p_payer_type, payer_type, 'sender'),
         pickup_photos         = COALESCE(p_pickup_photos, pickup_photos),
         promised_payment_date = p_promised_payment_date,
         payment_reference     = COALESCE(p_reference, payment_reference),
         status                = 'Picked Up'
   WHERE id = p_order_id;

  -- Step 2 — the ledger, only when money actually changed hands.
  IF COALESCE(p_amount, 0) > 0 THEN
    SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

    SELECT COALESCE(SUM(amount), 0) + p_amount
      INTO v_paid_after
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial');

    -- Per-transaction label. Must be 'paid' or 'partial' — those are the only
    -- two values update_order_payment_totals counts toward amount_paid.
    SELECT CASE
             WHEN v_paid_after >= COALESCE(shipping_cost, 0) THEN 'paid'
             ELSE 'partial'
           END
      INTO v_label
      FROM public.orders
     WHERE id = p_order_id;

    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, admin_id, admin_name, notes,
      payment_type, payment_date, receipt_url
    ) VALUES (
      p_order_id, p_amount, p_payment_method, v_label,
      p_reference, auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
      p_payment_type, p_payment_date, p_receipt_url
    )
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;
  END IF;

  -- Re-read AFTER the ledger trigger has recomputed the totals.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$



CREATE OR REPLACE FUNCTION public.release_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.contact_inquiries
     SET push_dispatch_started_at = NULL,
         push_dispatch_claim_id = NULL
   WHERE id = p_inquiry_id
     AND push_dispatch_claim_id = p_claim_id
     AND push_dispatched_at IS NULL;
END;
$function$



CREATE OR REPLACE FUNCTION public.remove_push_device_registration(p_device_id text DEFAULT NULL::text, p_token text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_device_id TEXT := NULLIF(btrim(p_device_id), '');
  v_token TEXT := NULLIF(btrim(p_token), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  DELETE FROM public.user_device_tokens
   WHERE user_id = auth.uid()
     AND (
       (v_device_id IS NOT NULL AND device_id = v_device_id)
       OR (v_token IS NOT NULL AND token = v_token)
     );
END;
$function$



CREATE OR REPLACE FUNCTION public.request_order_cancellation(p_order_id uuid, p_reason text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order  public.orders;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF char_length(v_reason) < 5 THEN
    RAISE EXCEPTION 'Please tell us why you are cancelling (at least 5 characters).';
  END IF;

  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id AND user_id = auth.uid()
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only your own bookings can be cancelled';
  END IF;

  IF v_order.status = 'Pending Cancellation' THEN
    RAISE EXCEPTION 'A cancellation request for this booking is already awaiting review.';
  END IF;

  IF v_order.status = 'Cancelled' THEN
    RAISE EXCEPTION 'This booking is already cancelled.';
  END IF;

  -- Mirrors IN_NETWORK_STATUSES in src/constants/status.js. Past this line the
  -- parcel is on a vehicle or in a hub, and "cancel" no longer describes
  -- anything that can physically happen — that is a return, not a cancellation.
  IF v_order.status IN ('In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered') THEN
    RAISE EXCEPTION
      'This shipment is already "%" and is on its way. Please contact support instead.',
      v_order.status;
  END IF;

  UPDATE public.orders
     SET status                       = 'Pending Cancellation',
         cancellation_details = jsonb_build_object(
           'reason', v_reason,
           'requested_at', now(),
           'previous_status', v_order.status
         )
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  -- Every admin is told. A request nobody sees is a booking frozen forever.
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT p.id,
         'Cancellation Requested',
         'Order ' || v_order.tracking_number || ': the customer asked to cancel. Reason: ' || v_reason,
         'order_update',
         v_order.id
    FROM public.profiles p
   WHERE p.role = 'admin';

  INSERT INTO public.activity_logs (module, action, record_type, record_id, record_ref, previous_value, new_value, details)
  VALUES ('Orders',
          'Cancellation Requested',
          'order',
          v_order.id,
          v_order.tracking_number,
          jsonb_build_object('status', v_order.cancellation_details->>'previous_status'),
          jsonb_build_object('status', 'Pending Cancellation'),
          'Customer requested cancellation. Reason: ' || v_reason);

  RETURN v_order;
END;
$function$



CREATE OR REPLACE FUNCTION public.review_order_cancellation(p_order_id uuid, p_approve boolean, p_notes text DEFAULT NULL::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.orders;
  v_restore TEXT;
  v_notes   TEXT := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status <> 'Pending Cancellation' THEN
    RAISE EXCEPTION 'Order % has no cancellation request awaiting review.', v_order.tracking_number;
  END IF;

  -- 'Pending' is the fallback only for rows that predate this migration and so
  -- have no recorded previous status. It is a guess, and it is confined to the
  -- one case where nothing better is knowable.
  v_restore := COALESCE(v_order.cancellation_details->>'previous_status', 'Pending');

  UPDATE public.orders
     SET status                    = CASE WHEN p_approve THEN 'Cancelled' ELSE v_restore END,
         cancellation_details      = COALESCE(v_order.cancellation_details, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'reviewed_at', now(),
           'reviewed_by', auth.uid(),
           'review_notes', v_notes
         ))
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  VALUES (v_order.user_id,
          CASE WHEN p_approve THEN 'Cancellation Approved' ELSE 'Cancellation Declined' END,
          CASE WHEN p_approve
               THEN 'Order ' || v_order.tracking_number || ' has been cancelled as you requested.'
               ELSE 'Order ' || v_order.tracking_number || ' was not cancelled and is back to "' || v_restore || '".'
          END
          || COALESCE(' Note from our team: ' || v_notes, ''),
          'order_update',
          v_order.id);

  INSERT INTO public.activity_logs (module, action, record_type, record_id, record_ref, previous_value, new_value, details)
  VALUES ('Orders',
          CASE WHEN p_approve THEN 'Cancellation Approved' ELSE 'Cancellation Rejected' END,
          'order',
          v_order.id,
          v_order.tracking_number,
          jsonb_build_object('status', 'Pending Cancellation'),
          jsonb_build_object('status', v_order.status),
          CASE WHEN p_approve
               THEN 'Approved the customer''s cancellation request; order cancelled.'
               ELSE 'Rejected the customer''s cancellation request; order restored to "' || v_restore || '".'
          END
          || COALESCE(' Note: ' || v_notes, '')
          || COALESCE(' Customer''s stated reason: ' || (v_order.cancellation_details->>'reason'), ''));

  RETURN v_order;
END;
$function$



CREATE OR REPLACE FUNCTION public.safe_uuid(value text)
 RETURNS uuid
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN value::UUID;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$function$



CREATE OR REPLACE FUNCTION public.search_conversation_messages(p_query text)
 RETURNS TABLE(conversation_id uuid, match_count integer, snippet text, matched_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_term TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  v_term := btrim(COALESCE(p_query, ''));
  IF length(v_term) < 2 THEN
    RETURN;   -- one character matches everything; not a search
  END IF;

  -- Treat the input as literal text: escape the LIKE metacharacters, and the
  -- escape character itself first so it is not double-processed.
  v_term := replace(v_term, '\', '\\');
  v_term := replace(v_term, '%', '\%');
  v_term := replace(v_term, '_', '\_');

  RETURN QUERY
  WITH hits AS (
    SELECT m.conversation_id AS conv_id,
           m.message,
           m.created_at,
           ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC) AS rn,
           COUNT(*)     OVER (PARTITION BY m.conversation_id) AS total
      FROM public.chat_messages m
     WHERE m.message ILIKE '%' || v_term || '%' ESCAPE '\'
  )
  SELECT h.conv_id,
         h.total::INTEGER,
         -- The most recent matching line, trimmed for a one-line preview.
         CASE WHEN length(h.message) > 140
              THEN left(h.message, 140) || '…'
              ELSE h.message
         END,
         h.created_at
    FROM hits h
   WHERE h.rn = 1
   ORDER BY h.created_at DESC
   LIMIT 50;
END;
$function$



CREATE OR REPLACE FUNCTION public.set_limit(real)
 RETURNS real
 LANGUAGE c
 STRICT
AS '$libdir/pg_trgm', $function$set_limit$function$



CREATE OR REPLACE FUNCTION public.show_limit()
 RETURNS real
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$show_limit$function$



CREATE OR REPLACE FUNCTION public.show_trgm(text)
 RETURNS text[]
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$show_trgm$function$



CREATE OR REPLACE FUNCTION public.similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity$function$



CREATE OR REPLACE FUNCTION public.similarity_dist(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity_dist$function$



CREATE OR REPLACE FUNCTION public.similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity_op$function$



CREATE OR REPLACE FUNCTION public.stamp_conversation_resolved_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN NEW.resolved_at := COALESCE(NEW.resolved_at, now()); ELSIF NEW.status <> 'resolved' THEN NEW.resolved_at := NULL; END IF; RETURN NEW; END; $function$



CREATE OR REPLACE FUNCTION public.stamp_inquiry_service_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN IF NEW.status IS DISTINCT FROM OLD.status THEN IF NEW.status <> 'new' THEN NEW.first_response_at := COALESCE(NEW.first_response_at, now()); END IF; IF NEW.status = 'resolved' THEN NEW.resolved_at := COALESCE(NEW.resolved_at, now()); ELSE NEW.resolved_at := NULL; END IF; END IF; RETURN NEW; END; $function$



CREATE OR REPLACE FUNCTION public.strict_word_similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity$function$



CREATE OR REPLACE FUNCTION public.strict_word_similarity_commutator_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_commutator_op$function$



CREATE OR REPLACE FUNCTION public.strict_word_similarity_dist_commutator_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_dist_commutator_op$function$



CREATE OR REPLACE FUNCTION public.strict_word_similarity_dist_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_dist_op$function$



CREATE OR REPLACE FUNCTION public.strict_word_similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_op$function$



CREATE OR REPLACE FUNCTION public.sync_auth_email_to_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles
    SET email = NEW.email,
        updated_at = NOW()
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$



CREATE OR REPLACE FUNCTION public.track_order_public(p_tracking_number text)
 RETURNS TABLE(tracking_number character varying, status character varying, sender_name text, receiver_name text, origin character varying, destination character varying, package_description text, actual_weight numeric, estimated_delivery timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
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
    o.updated_at
  FROM public.orders o
  LEFT JOIN public.trips t ON t.id = o.trip_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$function$



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
$function$



CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $function$



CREATE OR REPLACE FUNCTION public.word_similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity$function$



CREATE OR REPLACE FUNCTION public.word_similarity_commutator_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_commutator_op$function$



CREATE OR REPLACE FUNCTION public.word_similarity_dist_commutator_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_dist_commutator_op$function$



CREATE OR REPLACE FUNCTION public.word_similarity_dist_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_dist_op$function$



CREATE OR REPLACE FUNCTION public.word_similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_op$function$



-- ============================================================
-- FUNCTION PRIVILEGES
-- (Only emitted for functions with non-default access.)
-- (Default: anon, authenticated, service_role all have EXECUTE)
-- ============================================================

REVOKE ALL ON FUNCTION public.auto_resolve_stale_conversations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_resolve_stale_conversations() FROM anon;
REVOKE ALL ON FUNCTION public.auto_resolve_stale_conversations() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.auto_resolve_stale_conversations() TO service_role;

REVOKE ALL ON FUNCTION public.cancel_own_pending_order(p_order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_own_pending_order(p_order_id uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_own_pending_order(p_order_id uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_own_pending_order(p_order_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.claim_contact_inquiry_push(p_inquiry_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_contact_inquiry_push(p_inquiry_id uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_contact_inquiry_push(p_inquiry_id uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contact_inquiry_push(p_inquiry_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.claim_push_device_registration(p_device_id text, p_token text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_push_device_registration(p_device_id text, p_token text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_push_device_registration(p_device_id text, p_token text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_push_device_registration(p_device_id text, p_token text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_push_device_registration(p_device_id text, p_token text) TO authenticated;

REVOKE ALL ON FUNCTION public.complete_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid) FROM anon;
REVOKE ALL ON FUNCTION public.complete_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.create_admin_notifications_rpc(p_title text, p_message text, p_type text, p_reference_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_admin_notifications_rpc(p_title text, p_message text, p_type text, p_reference_id uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_admin_notifications_rpc(p_title text, p_message text, p_type text, p_reference_id uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_admin_notifications_rpc(p_title text, p_message text, p_type text, p_reference_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_admin_notifications_rpc(p_title text, p_message text, p_type text, p_reference_id uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.derive_payment_status(p_shipping_cost numeric, p_amount_paid numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.derive_payment_status(p_shipping_cost numeric, p_amount_paid numeric) FROM anon;
REVOKE ALL ON FUNCTION public.derive_payment_status(p_shipping_cost numeric, p_amount_paid numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.derive_payment_status(p_shipping_cost numeric, p_amount_paid numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.derive_payment_status(p_shipping_cost numeric, p_amount_paid numeric) TO authenticated;

REVOKE ALL ON FUNCTION public.get_order_status_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_status_counts() FROM anon;
REVOKE ALL ON FUNCTION public.get_order_status_counts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_status_counts() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_status_counts() TO authenticated;

REVOKE ALL ON FUNCTION public.is_featured_photo_path(p_path text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_featured_photo_path(p_path text) TO anon;
GRANT EXECUTE ON FUNCTION public.is_featured_photo_path(p_path text) TO authenticated;

REVOKE ALL ON FUNCTION public.purge_old_activity_logs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_old_activity_logs() FROM anon;
REVOKE ALL ON FUNCTION public.purge_old_activity_logs() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_activity_logs() TO service_role;

REVOKE ALL ON FUNCTION public.reassign_trip(p_order_id uuid, p_new_trip_id uuid, p_reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reassign_trip(p_order_id uuid, p_new_trip_id uuid, p_reason text) FROM anon;
REVOKE ALL ON FUNCTION public.reassign_trip(p_order_id uuid, p_new_trip_id uuid, p_reason text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_trip(p_order_id uuid, p_new_trip_id uuid, p_reason text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reassign_trip(p_order_id uuid, p_new_trip_id uuid, p_reason text) TO authenticated;

REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(p_source_id text, p_payment_id text, p_payment_amount numeric, p_payment_status text) TO service_role;

REVOKE ALL ON FUNCTION public.record_delivery_payment(p_order_id uuid, p_delivery_photos jsonb, p_payment_method text, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text, p_promised_payment_date date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_delivery_payment(p_order_id uuid, p_delivery_photos jsonb, p_payment_method text, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text, p_promised_payment_date date) FROM anon;
REVOKE ALL ON FUNCTION public.record_delivery_payment(p_order_id uuid, p_delivery_photos jsonb, p_payment_method text, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text, p_promised_payment_date date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_delivery_payment(p_order_id uuid, p_delivery_photos jsonb, p_payment_method text, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text, p_promised_payment_date date) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_delivery_payment(p_order_id uuid, p_delivery_photos jsonb, p_payment_method text, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text, p_promised_payment_date date) TO authenticated;

REVOKE ALL ON FUNCTION public.record_pickup_payment(p_order_id uuid, p_actual_weight numeric, p_payment_method text, p_payer_type text, p_pickup_photos jsonb, p_promised_payment_date date, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_pickup_payment(p_order_id uuid, p_actual_weight numeric, p_payment_method text, p_payer_type text, p_pickup_photos jsonb, p_promised_payment_date date, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text) FROM anon;
REVOKE ALL ON FUNCTION public.record_pickup_payment(p_order_id uuid, p_actual_weight numeric, p_payment_method text, p_payer_type text, p_pickup_photos jsonb, p_promised_payment_date date, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_pickup_payment(p_order_id uuid, p_actual_weight numeric, p_payment_method text, p_payer_type text, p_pickup_photos jsonb, p_promised_payment_date date, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_pickup_payment(p_order_id uuid, p_actual_weight numeric, p_payment_method text, p_payer_type text, p_pickup_photos jsonb, p_promised_payment_date date, p_amount numeric, p_reference text, p_payment_date date, p_receipt_url text, p_payment_type text, p_notes text) TO authenticated;

REVOKE ALL ON FUNCTION public.release_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid) FROM anon;
REVOKE ALL ON FUNCTION public.release_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_contact_inquiry_push(p_inquiry_id uuid, p_claim_id uuid) TO service_role;

REVOKE ALL ON FUNCTION public.remove_push_device_registration(p_device_id text, p_token text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_push_device_registration(p_device_id text, p_token text) FROM anon;
REVOKE ALL ON FUNCTION public.remove_push_device_registration(p_device_id text, p_token text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.remove_push_device_registration(p_device_id text, p_token text) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_push_device_registration(p_device_id text, p_token text) TO authenticated;

REVOKE ALL ON FUNCTION public.request_order_cancellation(p_order_id uuid, p_reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_order_cancellation(p_order_id uuid, p_reason text) FROM anon;
REVOKE ALL ON FUNCTION public.request_order_cancellation(p_order_id uuid, p_reason text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_order_cancellation(p_order_id uuid, p_reason text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_order_cancellation(p_order_id uuid, p_reason text) TO authenticated;

REVOKE ALL ON FUNCTION public.review_order_cancellation(p_order_id uuid, p_approve boolean, p_notes text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_order_cancellation(p_order_id uuid, p_approve boolean, p_notes text) FROM anon;
REVOKE ALL ON FUNCTION public.review_order_cancellation(p_order_id uuid, p_approve boolean, p_notes text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.review_order_cancellation(p_order_id uuid, p_approve boolean, p_notes text) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_order_cancellation(p_order_id uuid, p_approve boolean, p_notes text) TO authenticated;

REVOKE ALL ON FUNCTION public.guard_chat_message_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_chat_message_update() FROM anon;
REVOKE ALL ON FUNCTION public.guard_chat_message_update() FROM authenticated;

REVOKE ALL ON FUNCTION public.search_conversation_messages(p_query text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_conversation_messages(p_query text) FROM anon;
REVOKE ALL ON FUNCTION public.search_conversation_messages(p_query text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.search_conversation_messages(p_query text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_conversation_messages(p_query text) TO authenticated;


-- ============================================================
-- TRIGGERS
-- ============================================================

DROP TRIGGER IF EXISTS activity_logs_guard_insert ON public.activity_logs;
CREATE TRIGGER activity_logs_guard_insert BEFORE INSERT ON activity_logs FOR EACH ROW EXECUTE FUNCTION guard_activity_log_insert();

DROP TRIGGER IF EXISTS announcements_updated_at ON public.announcements;
CREATE TRIGGER announcements_updated_at BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS chat_messages_guard_insert ON public.chat_messages;
CREATE TRIGGER chat_messages_guard_insert BEFORE INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION guard_chat_message_insert();

DROP TRIGGER IF EXISTS chat_messages_guard_customer_update ON public.chat_messages;
CREATE TRIGGER chat_messages_guard_customer_update BEFORE UPDATE ON chat_messages FOR EACH ROW EXECUTE FUNCTION guard_chat_message_update();

DROP TRIGGER IF EXISTS chat_messages_maintain_service_state ON public.chat_messages;
CREATE TRIGGER chat_messages_maintain_service_state AFTER INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION maintain_conversation_service_state();

DROP TRIGGER IF EXISTS trigger_log_customer_chat ON public.chat_messages;
CREATE TRIGGER trigger_log_customer_chat AFTER INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION log_customer_chat_message();

DROP TRIGGER IF EXISTS contact_inquiries_guard_rate_limit ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_guard_rate_limit BEFORE INSERT ON contact_inquiries FOR EACH ROW EXECUTE FUNCTION guard_contact_inquiry_rate_limit();

DROP TRIGGER IF EXISTS contact_inquiries_guard_resolve_ownership ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_guard_resolve_ownership BEFORE UPDATE OF status ON contact_inquiries FOR EACH ROW EXECUTE FUNCTION guard_contact_inquiry_resolve_ownership();

DROP TRIGGER IF EXISTS contact_inquiries_notify_admins ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_notify_admins AFTER INSERT ON contact_inquiries FOR EACH ROW EXECUTE FUNCTION notify_admins_of_contact_inquiry();

DROP TRIGGER IF EXISTS contact_inquiries_stamp_service_state ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_stamp_service_state BEFORE UPDATE OF status ON contact_inquiries FOR EACH ROW EXECUTE FUNCTION stamp_inquiry_service_state();

DROP TRIGGER IF EXISTS conversations_guard_update ON public.conversations;
CREATE TRIGGER conversations_guard_update BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION guard_conversation_update();

DROP TRIGGER IF EXISTS conversations_stamp_resolved_at ON public.conversations;
CREATE TRIGGER conversations_stamp_resolved_at BEFORE UPDATE OF status ON conversations FOR EACH ROW EXECUTE FUNCTION stamp_conversation_resolved_at();

DROP TRIGGER IF EXISTS orders_guard_customer_insert ON public.orders;
CREATE TRIGGER orders_guard_customer_insert BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION guard_customer_order_insert();

DROP TRIGGER IF EXISTS orders_guard_update ON public.orders;
CREATE TRIGGER orders_guard_update BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_update();

DROP TRIGGER IF EXISTS orders_log_status_event ON public.orders;
CREATE TRIGGER orders_log_status_event AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION log_order_status_event();

DROP TRIGGER IF EXISTS orders_prepare_insert ON public.orders;
CREATE TRIGGER orders_prepare_insert BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION prepare_order_insert();

DROP TRIGGER IF EXISTS orders_updated_at ON public.orders;
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS payment_attempts_updated_at ON public.payment_attempts;
CREATE TRIGGER payment_attempts_updated_at BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trigger_update_totals_after_payment ON public.payment_transactions;
CREATE TRIGGER trigger_update_totals_after_payment AFTER INSERT OR DELETE OR UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION update_order_payment_totals();

DROP TRIGGER IF EXISTS profiles_guard_write ON public.profiles;
CREATE TRIGGER profiles_guard_write BEFORE INSERT OR UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_write();

DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trips_guard_completion ON public.trips;
DROP TRIGGER IF EXISTS trips_guard_status_transition ON public.trips;
CREATE TRIGGER trips_guard_status_transition BEFORE UPDATE OF status ON trips FOR EACH ROW EXECUTE FUNCTION guard_trip_status_transition();

DROP TRIGGER IF EXISTS trips_updated_at ON public.trips;
CREATE TRIGGER trips_updated_at BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_activity_logs_admin_id ON public.activity_logs USING btree (admin_id);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON public.activity_logs USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_module ON public.activity_logs USING btree (module);

CREATE INDEX IF NOT EXISTS idx_activity_logs_record_id ON public.activity_logs USING btree (record_id);

CREATE INDEX IF NOT EXISTS chat_messages_message_trgm_idx ON public.chat_messages USING gin (message gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conv_id ON public.chat_messages USING btree (conversation_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON public.chat_messages USING btree (created_at);

CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON public.chat_messages USING btree (conversation_id, sender_role, is_read);

CREATE INDEX IF NOT EXISTS idx_contact_inquiries_created_at ON public.contact_inquiries USING btree (created_at);

CREATE INDEX IF NOT EXISTS idx_contact_inquiries_ip ON public.contact_inquiries USING btree (ip) WHERE (ip IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_contact_inquiries_status ON public.contact_inquiries USING btree (status);

CREATE INDEX IF NOT EXISTS idx_customer_feedback_customer_id ON public.customer_feedback USING btree (customer_id);

CREATE INDEX IF NOT EXISTS idx_legal_consents_user_accepted ON public.legal_consents USING btree (user_id, accepted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_one_current_version ON public.legal_documents USING btree (document_type) WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notification_id ON public.notification_delivery_attempts USING btree (notification_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications USING btree (user_id, is_read);

CREATE INDEX IF NOT EXISTS idx_order_status_events_order_id ON public.order_status_events USING btree (order_id, changed_at);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_featured ON public.orders USING btree (featured_at DESC) WHERE (featured_on_website = true);

CREATE INDEX IF NOT EXISTS idx_orders_pending_cancellation ON public.orders USING btree (updated_at) WHERE ((status)::text = 'Pending Cancellation'::text);

CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders USING btree (status);

CREATE INDEX IF NOT EXISTS idx_orders_trip_id ON public.orders USING btree (trip_id);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_created_at ON public.payment_attempts USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order_id ON public.payment_attempts USING btree (order_id);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON public.payment_attempts USING btree (status);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_id ON public.payment_transactions USING btree (order_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_method ON public.payment_transactions USING btree (order_id, payment_method);

CREATE UNIQUE INDEX IF NOT EXISTS unique_tx_ref ON public.payment_transactions USING btree (transaction_reference) WHERE (transaction_reference IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles USING btree (role);

CREATE INDEX IF NOT EXISTS idx_trips_departure_date ON public.trips USING btree (departure_date);

CREATE INDEX IF NOT EXISTS idx_trips_status ON public.trips USING btree (status);

CREATE UNIQUE INDEX IF NOT EXISTS trips_unique_route_departure_day ON public.trips USING btree (origin, destination, ph_calendar_day(departure_date)) WHERE ((status)::text <> 'cancelled'::text);

CREATE INDEX IF NOT EXISTS idx_user_device_tokens_user_id ON public.user_device_tokens USING btree (user_id);

CREATE INDEX IF NOT EXISTS user_device_tokens_device_id_idx ON public.user_device_tokens USING btree (device_id) WHERE (device_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS user_device_tokens_user_device_key ON public.user_device_tokens USING btree (user_id, device_id) WHERE (device_id IS NOT NULL);


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can insert activity logs" ON public.activity_logs;
CREATE POLICY "Admins can insert activity logs" ON public.activity_logs
  FOR INSERT
  TO public
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins can view activity logs" ON public.activity_logs;
CREATE POLICY "Admins can view activity logs" ON public.activity_logs
  FOR SELECT
  TO public
  USING (is_admin());

DROP POLICY IF EXISTS "Users can insert their own activity logs" ON public.activity_logs;
CREATE POLICY "Users can insert their own activity logs" ON public.activity_logs
  FOR INSERT
  TO authenticated
  WITH CHECK ((admin_id = auth.uid()));

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage announcements" ON public.announcements;
CREATE POLICY "Admins can manage announcements" ON public.announcements
  FOR ALL
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

DROP POLICY IF EXISTS "Anyone can view announcements" ON public.announcements;
CREATE POLICY "Anyone can view announcements" ON public.announcements
  FOR SELECT
  TO public
  USING (true);

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins update messages" ON public.chat_messages;
CREATE POLICY "Admins update messages" ON public.chat_messages
  FOR UPDATE
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

DROP POLICY IF EXISTS "Customers mark admin messages read" ON public.chat_messages;
CREATE POLICY "Customers mark admin messages read" ON public.chat_messages
  FOR UPDATE
  TO authenticated
  USING ((((sender_role)::text = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = chat_messages.conversation_id) AND (conversations.customer_id = auth.uid()))))))
  WITH CHECK ((((sender_role)::text = 'admin'::text) AND (is_read = true) AND (EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = chat_messages.conversation_id) AND (conversations.customer_id = auth.uid()))))));

DROP POLICY IF EXISTS "Users insert messages in allowed conversations" ON public.chat_messages;
CREATE POLICY "Users insert messages in allowed conversations" ON public.chat_messages
  FOR INSERT
  TO public
  WITH CHECK (((sender_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = chat_messages.conversation_id) AND ((conversations.customer_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM profiles
          WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text))))))))));

DROP POLICY IF EXISTS "Users view messages in allowed conversations" ON public.chat_messages;
CREATE POLICY "Users view messages in allowed conversations" ON public.chat_messages
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = chat_messages.conversation_id) AND ((conversations.customer_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM profiles
          WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))))))));

ALTER TABLE public.company_information ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow admin full access" ON public.company_information;
CREATE POLICY "Allow admin full access" ON public.company_information
  FOR ALL
  TO public
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Allow public read access" ON public.company_information;
CREATE POLICY "Allow public read access" ON public.company_information
  FOR SELECT
  TO public
  USING (true);

ALTER TABLE public.contact_inquiries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can delete contact inquiries" ON public.contact_inquiries;
CREATE POLICY "Admins can delete contact inquiries" ON public.contact_inquiries
  FOR DELETE
  TO public
  USING (is_admin());

DROP POLICY IF EXISTS "Admins can update contact inquiries" ON public.contact_inquiries;
CREATE POLICY "Admins can update contact inquiries" ON public.contact_inquiries
  FOR UPDATE
  TO public
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins can view inquiries" ON public.contact_inquiries;
CREATE POLICY "Admins can view inquiries" ON public.contact_inquiries
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

-- No INSERT policy: anon/authenticated get RLS's default-deny. Every
-- submission goes through the submit-inquiry Edge Function's service_role
-- client, which bypasses RLS. See 20260829150000_revoke_public_inquiry_insert.sql.

COMMENT ON TABLE public.contact_inquiries IS
  'Public contact inquiries. No INSERT policy is granted to anon/authenticated by design -- every submission must go through the submit-inquiry Edge Function (service_role), which validates input server-side and stamps the server-owned ip column that guard_contact_inquiry_rate_limit depends on.';

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can update conversations" ON public.conversations;
CREATE POLICY "Admins can update conversations" ON public.conversations
  FOR UPDATE
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

DROP POLICY IF EXISTS "Admins insert conversations" ON public.conversations;
CREATE POLICY "Admins insert conversations" ON public.conversations
  FOR INSERT
  TO public
  WITH CHECK ((is_admin() AND (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = conversations.customer_id) AND ((profiles.role)::text = 'customer'::text))))));

DROP POLICY IF EXISTS "Customers can update own conversations" ON public.conversations;
CREATE POLICY "Customers can update own conversations" ON public.conversations
  FOR UPDATE
  TO public
  USING ((customer_id = auth.uid()));

DROP POLICY IF EXISTS "Customers insert own conversations" ON public.conversations;
CREATE POLICY "Customers insert own conversations" ON public.conversations
  FOR INSERT
  TO public
  WITH CHECK ((customer_id = auth.uid()));

DROP POLICY IF EXISTS "Customers view own conversations" ON public.conversations;
CREATE POLICY "Customers view own conversations" ON public.conversations
  FOR SELECT
  TO public
  USING (((customer_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text))))));

ALTER TABLE public.customer_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage all feedback" ON public.customer_feedback;
CREATE POLICY "Admins can manage all feedback" ON public.customer_feedback
  FOR ALL
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

DROP POLICY IF EXISTS "Customers can insert own delivered-order feedback" ON public.customer_feedback;
CREATE POLICY "Customers can insert own delivered-order feedback" ON public.customer_feedback
  FOR INSERT
  TO authenticated
  WITH CHECK (((auth.uid() = customer_id) AND (EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = customer_feedback.order_id) AND (o.user_id = auth.uid()) AND ((o.status)::text = 'Delivered'::text))))));

DROP POLICY IF EXISTS "Customers can read own feedback" ON public.customer_feedback;
CREATE POLICY "Customers can read own feedback" ON public.customer_feedback
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = customer_id));

ALTER TABLE public.legal_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view legal consents" ON public.legal_consents;
CREATE POLICY "Admins can view legal consents" ON public.legal_consents
  FOR SELECT
  TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS "Users can view own legal consents" ON public.legal_consents;
CREATE POLICY "Users can view own legal consents" ON public.legal_consents
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));

ALTER TABLE public.legal_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Published legal documents are public" ON public.legal_documents;
CREATE POLICY "Published legal documents are public" ON public.legal_documents
  FOR SELECT
  TO anon,authenticated
  USING (is_current);

ALTER TABLE public.notification_delivery_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view delivery attempts" ON public.notification_delivery_attempts;
CREATE POLICY "Admins can view delivery attempts" ON public.notification_delivery_attempts
  FOR SELECT
  TO authenticated
  USING (is_admin());

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can insert notifications" ON public.notifications;
CREATE POLICY "Admins can insert notifications" ON public.notifications
  FOR INSERT
  TO public
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins can view notifications" ON public.notifications;
CREATE POLICY "Admins can view notifications" ON public.notifications
  FOR SELECT
  TO public
  USING (is_admin());

DROP POLICY IF EXISTS "Users can delete own notifications" ON public.notifications;
CREATE POLICY "Users can delete own notifications" ON public.notifications
  FOR DELETE
  TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert own notifications" ON public.notifications;
CREATE POLICY "Users can insert own notifications" ON public.notifications
  FOR INSERT
  TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications" ON public.notifications
  FOR UPDATE
  TO public
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own notifications" ON public.notifications;
CREATE POLICY "Users can view own notifications" ON public.notifications
  FOR SELECT
  TO public
  USING ((user_id = auth.uid()));

ALTER TABLE public.order_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own order status events" ON public.order_status_events;
CREATE POLICY "Users view own order status events" ON public.order_status_events
  FOR SELECT
  TO public
  USING ((is_admin() OR (EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = order_status_events.order_id) AND (o.user_id = auth.uid()))))));

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can delete orders" ON public.orders;
CREATE POLICY "Admins can delete orders" ON public.orders
  FOR DELETE
  TO public
  USING (is_admin());

DROP POLICY IF EXISTS "Admins can update orders" ON public.orders;
CREATE POLICY "Admins can update orders" ON public.orders
  FOR UPDATE
  TO public
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Users can create own orders" ON public.orders;
CREATE POLICY "Users can create own orders" ON public.orders
  FOR INSERT
  TO public
  WITH CHECK (((user_id = auth.uid()) AND ((status)::text = ANY ((ARRAY['Pending'::character varying, 'Assigned'::character varying])::text[])) AND (actual_weight IS NULL) AND (payment_method IS NULL) AND ((payment_status)::text = 'unpaid'::text) AND (amount_paid = (0)::numeric) AND (pickup_photos = '[]'::jsonb) AND (delivery_photos = '[]'::jsonb)));

DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
CREATE POLICY "Users can view own orders" ON public.orders
  FOR SELECT
  TO public
  USING (((user_id = auth.uid()) OR is_admin()));

ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage payment attempts" ON public.payment_attempts;
CREATE POLICY "Admins can manage payment attempts" ON public.payment_attempts
  FOR ALL
  TO public
  USING (is_admin())
  WITH CHECK (is_admin());

ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can insert and select payment transactions" ON public.payment_transactions;
CREATE POLICY "Admins can insert and select payment transactions" ON public.payment_transactions
  FOR ALL
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

DROP POLICY IF EXISTS "Customers can view their own payment transactions" ON public.payment_transactions;
CREATE POLICY "Customers can view their own payment transactions" ON public.payment_transactions
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM orders
  WHERE ((orders.id = payment_transactions.order_id) AND (orders.user_id = auth.uid())))));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can update profiles" ON public.profiles;
CREATE POLICY "Admins can update profiles" ON public.profiles
  FOR UPDATE
  TO public
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins can view profiles" ON public.profiles;
CREATE POLICY "Admins can view profiles" ON public.profiles
  FOR SELECT
  TO public
  USING (is_admin());

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT
  TO public
  WITH CHECK ((id = auth.uid()));

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE
  TO public
  USING ((id = auth.uid()))
  WITH CHECK ((id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT
  TO public
  USING ((id = auth.uid()));

ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage trips" ON public.trips;
CREATE POLICY "Admins can manage trips" ON public.trips
  FOR ALL
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

DROP POLICY IF EXISTS "Anyone can view trips" ON public.trips;
CREATE POLICY "Anyone can view trips" ON public.trips
  FOR SELECT
  TO public
  USING (true);

ALTER TABLE public.user_device_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can insert device tokens" ON public.user_device_tokens;
CREATE POLICY "Admins can insert device tokens" ON public.user_device_tokens
  FOR INSERT
  TO public
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Users can delete own device tokens" ON public.user_device_tokens;
CREATE POLICY "Users can delete own device tokens" ON public.user_device_tokens
  FOR DELETE
  TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert own device tokens" ON public.user_device_tokens;
CREATE POLICY "Users can insert own device tokens" ON public.user_device_tokens
  FOR INSERT
  TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update own device tokens" ON public.user_device_tokens;
CREATE POLICY "Users can update own device tokens" ON public.user_device_tokens
  FOR UPDATE
  TO public
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own device tokens" ON public.user_device_tokens;
CREATE POLICY "Users can view own device tokens" ON public.user_device_tokens
  FOR SELECT
  TO public
  USING ((user_id = auth.uid()));


-- ============================================================
-- STORAGE BUCKETS
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('cargo-photos', 'cargo-photos', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('company-assets', 'company-assets', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('public_assets', 'public_assets', true, NULL, NULL)
  ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ============================================================
-- STORAGE POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Admins manage cargo photos" ON storage.objects;
CREATE POLICY "Admins manage cargo photos" ON storage.objects
  FOR ALL
  TO authenticated
  USING (((bucket_id = 'cargo-photos'::text) AND is_admin()))
  WITH CHECK (((bucket_id = 'cargo-photos'::text) AND is_admin()));

DROP POLICY IF EXISTS "Admins manage company assets" ON storage.objects;
CREATE POLICY "Admins manage company assets" ON storage.objects
  FOR ALL
  TO authenticated
  USING (((bucket_id = 'company-assets'::text) AND is_admin()))
  WITH CHECK (((bucket_id = 'company-assets'::text) AND is_admin()));

DROP POLICY IF EXISTS "Public read company assets" ON storage.objects;
CREATE POLICY "Public read company assets" ON storage.objects
  FOR SELECT
  TO anon,authenticated
  USING (((bucket_id = ANY (ARRAY['cargo-photos'::text, 'company-assets'::text])) AND ((storage.foldername(name))[1] = ANY (ARRAY['gallery'::text, 'hero'::text, 'timeline'::text]))));

DROP POLICY IF EXISTS "Public read featured delivery photos" ON storage.objects;
CREATE POLICY "Public read featured delivery photos" ON storage.objects
  FOR SELECT
  TO anon,authenticated
  USING (((bucket_id = 'cargo-photos'::text) AND is_featured_photo_path(name)));

DROP POLICY IF EXISTS "Users read own cargo photos" ON storage.objects;
CREATE POLICY "Users read own cargo photos" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (((bucket_id = 'cargo-photos'::text) AND ((storage.foldername(name))[1] = ANY (ARRAY['pickup'::text, 'delivery'::text, 'receipts'::text, 'pickup-proofs'::text, 'delivery-proofs'::text])) AND (EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.user_id = auth.uid()) AND (((o.tracking_number)::text = (storage.foldername(objects.name))[2]) OR (o.id = safe_uuid((storage.foldername(objects.name))[2]))))))));


-- ============================================================
-- CRON JOBS (pg_cron)
-- ============================================================
SELECT cron.schedule('0 3 * * *', $cron$SELECT public.purge_old_activity_logs()$cron$);
SELECT cron.schedule('30 3 * * *', $cron$SELECT public.auto_resolve_stale_conversations()$cron$);
SELECT cron.schedule('0 4 * * *', $cron$SELECT public.purge_old_delivery_attempts()$cron$);


-- ============================================================
-- COLUMN COMMENTS
-- ============================================================
COMMENT ON COLUMN public.announcements.comments IS 'Append-only array of {id, user_id, name, text, created_at}. Written only by add_announcement_comment().';
COMMENT ON COLUMN public.contact_inquiries.assigned_admin_id IS 'Who owns this inquiry. NULL = unclaimed.';
COMMENT ON COLUMN public.contact_inquiries.first_response_at IS 'When an admin first actioned it. Stamped by trigger on the move out of ''new''.';
COMMENT ON COLUMN public.contact_inquiries.push_dispatched_at IS 'Set after the public contact inquiry push dispatch is claimed.';
COMMENT ON COLUMN public.contact_inquiries.push_dispatch_started_at IS 'Start time of the current short-lived push dispatch lease.';
COMMENT ON COLUMN public.contact_inquiries.push_dispatch_claim_id IS 'Lease token used to complete or release the current contact push dispatch.';
COMMENT ON COLUMN public.conversations.escalated IS 'Bot matched an escalation pattern, or the customer asked for a human. A flag, not a state.';
COMMENT ON COLUMN public.conversations.first_response_at IS 'First admin message in this conversation. Set once, server-side; never rewritten.';
COMMENT ON COLUMN public.conversations.bot_resolved IS 'NULL = unknown. TRUE/FALSE only once the customer answers the thumbs prompt.';
COMMENT ON COLUMN public.orders.cancellation_details IS 'JSONB object containing all cancellation metadata: reason, requested_at, previous_status, reviewed_by, reviewed_at, review_notes.';
COMMENT ON COLUMN public.user_device_tokens.device_id IS 'Stable browser/PWA installation identifier. One user may have many device rows.';


-- ============================================================
-- REALTIME PUBLICATIONS
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE IF NOT EXISTS public.chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE IF NOT EXISTS public.contact_inquiries;
ALTER PUBLICATION supabase_realtime ADD TABLE IF NOT EXISTS public.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE IF NOT EXISTS public.notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE IF NOT EXISTS public.orders;


CREATE OR REPLACE FUNCTION public.purge_old_delivery_attempts()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.notification_delivery_attempts
  WHERE attempted_at < now() - interval '7 days';
END;
$function$;


-- ============================================================
-- PHOTO STORAGE MONITORING AND NEW-UPLOAD ROUTING
-- ============================================================
-- This switch never changes the cargo-photos bucket or existing descriptors.
CREATE TABLE IF NOT EXISTS public.photo_storage_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  upload_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (upload_mode IN ('automatic', 'force_firebase')),
  force_firebase_expires_at TIMESTAMPTZ,
  reason TEXT,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT force_firebase_requires_expiry CHECK (
    (upload_mode = 'automatic' AND force_firebase_expires_at IS NULL)
    OR (upload_mode = 'force_firebase' AND force_firebase_expires_at IS NOT NULL)
  ),
  CONSTRAINT photo_storage_settings_reason_length CHECK (char_length(COALESCE(reason, '')) <= 500)
);
INSERT INTO public.photo_storage_settings (id, upload_mode) VALUES (TRUE, 'automatic') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.photo_storage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN ('upload', 'mode_change', 'health_check')),
  provider TEXT NOT NULL CHECK (provider IN ('supabase', 'firebase', 'system')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'expired')),
  photo_type TEXT CHECK (photo_type IN ('pickup', 'delivery', 'receipt')),
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  storage_path TEXT,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT photo_storage_events_message_length CHECK (char_length(COALESCE(message, '')) <= 500)
);
CREATE INDEX IF NOT EXISTS photo_storage_events_created_at_idx ON public.photo_storage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS photo_storage_events_order_id_idx ON public.photo_storage_events (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photo_storage_events_provider_outcome_idx ON public.photo_storage_events (provider, outcome, created_at DESC);

CREATE OR REPLACE FUNCTION public.get_effective_photo_storage_mode()
RETURNS TABLE(upload_mode TEXT, force_firebase_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, updated_by UUID, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE v_settings public.photo_storage_settings%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_settings FROM public.photo_storage_settings WHERE id = TRUE FOR UPDATE;
  IF v_settings.upload_mode = 'force_firebase' AND v_settings.force_firebase_expires_at <= now() THEN
    UPDATE public.photo_storage_settings SET upload_mode = 'automatic', force_firebase_expires_at = NULL,
      reason = 'Force Firebase mode expired automatically.', updated_by = NULL, updated_at = now()
      WHERE id = TRUE RETURNING * INTO v_settings;
    INSERT INTO public.photo_storage_events (event_type, provider, outcome, message, metadata)
      VALUES ('mode_change', 'system', 'expired', 'Force Firebase mode expired and Automatic mode resumed.', jsonb_build_object('upload_mode', 'automatic'));
  END IF;
  RETURN QUERY SELECT v_settings.upload_mode, v_settings.force_firebase_expires_at, v_settings.updated_at, v_settings.updated_by, v_settings.reason;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_supabase_evidence_upload_allowed(p_path TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT public.is_admin() AND (
    (storage.foldername(p_path))[1] NOT IN ('pickup', 'delivery', 'receipts', 'pickup-proofs', 'delivery-proofs')
    OR COALESCE((SELECT (ps.upload_mode = 'automatic' OR ps.force_firebase_expires_at <= now()) FROM public.photo_storage_settings ps WHERE ps.id = TRUE), TRUE)
  );
$function$;

CREATE OR REPLACE FUNCTION public.set_photo_storage_mode(
  p_upload_mode TEXT, p_reason TEXT DEFAULT NULL, p_force_firebase_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(upload_mode TEXT, force_firebase_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, updated_by UUID, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE v_previous_mode TEXT; v_settings public.photo_storage_settings%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501'; END IF;
  IF p_upload_mode NOT IN ('automatic', 'force_firebase') THEN RAISE EXCEPTION 'Invalid upload mode' USING ERRCODE = '22023'; END IF;
  IF char_length(COALESCE(p_reason, '')) > 500 THEN RAISE EXCEPTION 'Reason is too long' USING ERRCODE = '22001'; END IF;
  IF p_upload_mode = 'force_firebase' THEN
    IF p_force_firebase_expires_at IS NULL OR p_force_firebase_expires_at <= now() OR p_force_firebase_expires_at > now() + INTERVAL '24 hours' THEN
      RAISE EXCEPTION 'Force Firebase expiry must be within the next 24 hours' USING ERRCODE = '22023';
    END IF;
  ELSE p_force_firebase_expires_at := NULL; END IF;
  SELECT pss.upload_mode INTO v_previous_mode FROM public.photo_storage_settings pss WHERE pss.id = TRUE FOR UPDATE;
  UPDATE public.photo_storage_settings SET upload_mode = p_upload_mode, force_firebase_expires_at = p_force_firebase_expires_at,
    reason = NULLIF(btrim(p_reason), ''), updated_by = auth.uid(), updated_at = now()
    WHERE id = TRUE RETURNING * INTO v_settings;
  INSERT INTO public.photo_storage_events (event_type, provider, outcome, message, metadata, created_by) VALUES (
    'mode_change', 'system', 'success',
    CASE WHEN p_upload_mode = 'force_firebase' THEN 'New evidence uploads are routed directly to Firebase fallback.' ELSE 'New evidence uploads use Supabase first with Firebase fallback.' END,
    jsonb_build_object('previous_mode', COALESCE(v_previous_mode, 'automatic'), 'upload_mode', p_upload_mode,
      'force_firebase_expires_at', p_force_firebase_expires_at, 'reason', NULLIF(btrim(p_reason), '')), auth.uid()
  );
  RETURN QUERY SELECT v_settings.upload_mode, v_settings.force_firebase_expires_at, v_settings.updated_at, v_settings.updated_by, v_settings.reason;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_photo_storage_summary()
RETURNS TABLE(supabase_photo_count BIGINT, firebase_photo_count BIGINT, legacy_photo_count BIGINT,
  pickup_photo_count BIGINT, delivery_photo_count BIGINT, receipt_photo_count BIGINT,
  failures_last_24h BIGINT, fallbacks_last_24h BIGINT, last_supabase_upload_at TIMESTAMPTZ, last_firebase_upload_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY WITH refs AS (
    SELECT 'pickup'::TEXT AS photo_type, jsonb_array_elements(COALESCE(o.pickup_photos, '[]'::jsonb)) AS ref FROM public.orders o
    UNION ALL SELECT 'delivery'::TEXT, jsonb_array_elements(COALESCE(o.delivery_photos, '[]'::jsonb)) FROM public.orders o
    UNION ALL SELECT 'receipt'::TEXT, to_jsonb(t.receipt_url) FROM public.payment_transactions t WHERE t.receipt_url IS NOT NULL AND btrim(t.receipt_url) <> ''
  ), classified AS (
    SELECT photo_type, CASE
      WHEN jsonb_typeof(ref) = 'object' AND (ref ->> 'type' = 'firestore_fallback' OR ref ? 'firestore_path') THEN 'firebase'
      WHEN jsonb_typeof(ref) = 'string' AND (ref #>> '{}') LIKE 'photoFallbacks/%' THEN 'firebase'
      WHEN jsonb_typeof(ref) = 'string' AND (ref #>> '{}') LIKE '%"firestore_path"%' THEN 'firebase'
      WHEN jsonb_typeof(ref) = 'object' AND (ref ->> 'type' = 'supabase_storage' OR ref ? 'path') THEN 'supabase'
      ELSE 'legacy' END AS provider FROM refs
  ) SELECT
    (SELECT count(*) FROM classified WHERE provider = 'supabase'), (SELECT count(*) FROM classified WHERE provider = 'firebase'),
    (SELECT count(*) FROM classified WHERE provider = 'legacy'), (SELECT count(*) FROM classified WHERE photo_type = 'pickup'),
    (SELECT count(*) FROM classified WHERE photo_type = 'delivery'), (SELECT count(*) FROM classified WHERE photo_type = 'receipt'),
    (SELECT count(*) FROM public.photo_storage_events WHERE event_type = 'upload' AND outcome = 'failure' AND created_at >= now() - INTERVAL '24 hours'),
    (SELECT count(*) FROM public.photo_storage_events WHERE event_type = 'upload' AND provider = 'firebase' AND outcome = 'success' AND created_at >= now() - INTERVAL '24 hours'),
    (SELECT max(created_at) FROM public.photo_storage_events WHERE event_type = 'upload' AND provider = 'supabase' AND outcome = 'success'),
    (SELECT max(created_at) FROM public.photo_storage_events WHERE event_type = 'upload' AND provider = 'firebase' AND outcome = 'success');
END;
$function$;

ALTER TABLE public.photo_storage_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_storage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins view photo storage events" ON public.photo_storage_events;
CREATE POLICY "Admins view photo storage events" ON public.photo_storage_events FOR SELECT TO authenticated USING (public.is_admin());
GRANT SELECT ON public.photo_storage_events TO authenticated;
REVOKE ALL ON public.photo_storage_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.photo_storage_events FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_effective_photo_storage_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_supabase_evidence_upload_allowed(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_photo_storage_mode(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_photo_storage_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_effective_photo_storage_mode() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_supabase_evidence_upload_allowed(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_photo_storage_mode(TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_photo_storage_summary() TO authenticated;
ALTER PUBLICATION supabase_realtime ADD TABLE IF NOT EXISTS public.photo_storage_events;

DROP POLICY IF EXISTS "Admins manage cargo photos" ON storage.objects;
DROP POLICY IF EXISTS "Admins read or delete cargo photos" ON storage.objects;
DROP POLICY IF EXISTS "Admins delete cargo photos" ON storage.objects;
DROP POLICY IF EXISTS "Admins insert cargo photos under active upload routing" ON storage.objects;
DROP POLICY IF EXISTS "Admins update cargo photos under active upload routing" ON storage.objects;
CREATE POLICY "Admins read or delete cargo photos" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'cargo-photos' AND public.is_admin());
CREATE POLICY "Admins delete cargo photos" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'cargo-photos' AND public.is_admin());
CREATE POLICY "Admins insert cargo photos under active upload routing" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'cargo-photos' AND public.is_supabase_evidence_upload_allowed(name));
CREATE POLICY "Admins update cargo photos under active upload routing" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'cargo-photos' AND public.is_admin()) WITH CHECK (bucket_id = 'cargo-photos' AND public.is_supabase_evidence_upload_allowed(name));
