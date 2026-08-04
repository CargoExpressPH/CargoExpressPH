-- ============================================================
-- CargoExpress PH — Complete Supabase PostgreSQL Schema
-- Single source-of-truth for the entire database.
-- Matches the LIVE database as of 2026-07-11
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================


-- ===================== 1. PROFILES =====================
-- Linked to Supabase auth.users via id (UUID)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  phone VARCHAR(20) DEFAULT NULL,
  address_lot_block VARCHAR(255) DEFAULT NULL,
  address_street VARCHAR(255) DEFAULT NULL,
  address_barangay VARCHAR(255) DEFAULT NULL,
  address_city VARCHAR(255) DEFAULT NULL,
  address_province VARCHAR(255) DEFAULT NULL,
  role VARCHAR(20) DEFAULT 'customer' CHECK (role IN ('admin', 'customer')),
  -- Contact & social
  facebook_name TEXT DEFAULT NULL,
  address_landmark TEXT DEFAULT NULL,
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ===================== 2. TRIPS =====================
CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_number VARCHAR(50) UNIQUE NOT NULL,
  origin VARCHAR(100) NOT NULL,
  destination VARCHAR(100) NOT NULL,
  departure_date TIMESTAMPTZ NOT NULL,
  arrival_date TIMESTAMPTZ DEFAULT NULL,
  capacity INTEGER DEFAULT 0,
  _deprecated_available_slots INTEGER DEFAULT 0,  -- DEPRECATED (20260803150000): write-only duplicate of capacity
  price_per_kg DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'arrived', 'completed', 'cancelled')),
  notes TEXT DEFAULT NULL,
  created_by UUID DEFAULT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ===================== 3. ORDERS =====================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id UUID DEFAULT NULL REFERENCES trips(id) ON DELETE SET NULL,
  origin VARCHAR(100) DEFAULT NULL,
  destination VARCHAR(100) DEFAULT NULL,
  tracking_number VARCHAR(50) UNIQUE NOT NULL,
  -- Sender info
  sender_name VARCHAR(100) NOT NULL,
  sender_phone VARCHAR(20) NOT NULL,
  sender_address TEXT NOT NULL,
  sender_province TEXT DEFAULT NULL,
  sender_city TEXT DEFAULT NULL,
  sender_facebook TEXT DEFAULT NULL,
  -- Receiver info
  receiver_name VARCHAR(100) NOT NULL,
  receiver_phone VARCHAR(20) NOT NULL,
  receiver_address TEXT NOT NULL,
  receiver_province TEXT DEFAULT NULL,
  receiver_city TEXT DEFAULT NULL,
  receiver_facebook TEXT DEFAULT NULL,
  -- Package info
  package_description TEXT,
  actual_weight DECIMAL(10,2) DEFAULT NULL,
  shipping_cost DECIMAL(10,2) DEFAULT 0,
  -- Payment info
  payer_type VARCHAR(20) DEFAULT NULL CHECK (payer_type IN ('sender', 'receiver')),
  payment_method VARCHAR(20) DEFAULT NULL CHECK (payment_method IN ('cash', 'gcash', 'paylater')),
  payment_status VARCHAR(20) DEFAULT 'unpaid' CHECK (payment_status IN ('paid', 'partial', 'unpaid')),
  amount_paid DECIMAL(10,2) DEFAULT 0.00,
  remaining_balance DECIMAL(10,2) DEFAULT 0.00,
  promised_payment_date DATE DEFAULT NULL,
  payment_reference VARCHAR(255) DEFAULT NULL,
  payment_preference TEXT DEFAULT 'unspecified',
  -- Pickup & delivery proof (photo arrays)
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  delivery_photos JSONB DEFAULT '[]'::jsonb,
  -- Service area
  service_area_status TEXT DEFAULT 'standard' CHECK (service_area_status IN ('standard', 'for_review', 'approved', 'rejected')),
  service_area_remarks TEXT DEFAULT NULL,
  -- Payment extras — DEPRECATED (20260803150000). Superseded by the
  -- payment_transactions columns of the same name; these were write-only.
  _deprecated_payment_date DATE DEFAULT NULL,
  _deprecated_receipt_url TEXT DEFAULT NULL,
  -- Featured on website
  featured_on_website BOOLEAN DEFAULT FALSE,
  featured_title TEXT DEFAULT NULL,
  featured_caption TEXT DEFAULT NULL,
  featured_image_type TEXT DEFAULT NULL,
  featured_at TIMESTAMPTZ DEFAULT NULL,
  -- Trip reassignment history
  reassignment_history JSONB DEFAULT '[]'::jsonb,
  -- Status & meta
  status VARCHAR(30) DEFAULT 'Pending' CHECK (status IN (
    'Pending Review', 'Pending', 'Assigned', 'Picked Up', 'In Transit',
    'Arrived at Hub', 'Out for Delivery', 'Delivered', 'Cancelled'
  )),
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ===================== 4. ANNOUNCEMENTS =====================
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  author_id UUID DEFAULT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ===================== 5. NOTIFICATIONS =====================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(30) DEFAULT 'general' CHECK (type IN ('order_update', 'trip_update', 'announcement', 'general', 'inquiry', 'feedback', 'chat_message')),
  reference_id UUID DEFAULT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ===================== 5b. USER DEVICE TOKENS =====================
CREATE TABLE IF NOT EXISTS user_device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_token_id UUID REFERENCES user_device_tokens(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  provider_message_id TEXT DEFAULT NULL,
  error_message TEXT DEFAULT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ===================== 6. GLOBAL SETTINGS =====================
-- NOTE: Removed in favour of company_information.default_price_per_kg
-- The global_settings table is no longer used. Price per kg is stored
-- directly in company_information for a single source of truth.
-- Legacy migration: supabase/migrations/20260715000000_consolidate_tables.sql


-- ===================== 7. CONVERSATIONS (Chat Support) =====================
-- One conversation per customer — enforced by UNIQUE constraint
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Service state. Every value is DERIVED from who spoke last, by trigger;
  -- the only one a human sets is 'resolved' (20260804260000).
  --   bot_active       bot handling — new chat, or a customer returning to a
  --                    resolved thread (usually a new, basic question)
  --   waiting          the customer spoke last — OUR TURN, the queue
  --   waiting_customer an admin spoke last — their turn
  --   resolved         an admin said so
  -- 'open' was deleted: once every admin reply means "waiting on the
  -- customer", it described nothing assigned_admin_id did not already say.
  status TEXT DEFAULT 'bot_active'
    CHECK (status IN ('bot_active', 'waiting', 'waiting_customer', 'resolved')),
  -- A FLAG, not a state: 'escalated' answers "how urgent", status answers
  -- "whose turn". Collapsing the two is what produced the original defect.
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  first_response_at TIMESTAMPTZ DEFAULT NULL,
  last_customer_message_at TIMESTAMPTZ DEFAULT NULL,
  resolved_at TIMESTAMPTZ DEFAULT NULL,
  bot_resolved BOOLEAN DEFAULT NULL,   -- NULL = unknown, the honest default
  -- FK added in 20260622000000; schema.sql previously omitted it, which broke
  -- the PostgREST embed assigned_admin:assigned_admin_id(name) on rebuild.
  assigned_admin_id UUID DEFAULT NULL REFERENCES profiles(id) ON DELETE SET NULL
);


-- ===================== 8. CHAT MESSAGES =====================
-- Linked to conversations, supports customer ↔ admin messaging
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_role VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ===================== 9. CONTACT INQUIRIES =====================
CREATE TABLE IF NOT EXISTS contact_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- Legacy polymorphic column: held a phone OR an email OR "phone | email".
  -- Still dual-written this release; normalized into the two columns below by
  -- 20260803140000_contact_inquiries_normalize.sql.
  phone TEXT DEFAULT NULL,
  contact_phone TEXT DEFAULT NULL,
  contact_email TEXT DEFAULT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'resolved')),
  -- Ownership + service timing (20260804230000). Without an owner nobody is
  -- answerable for an inquiry and two admins can answer the same person.
  -- The shared queue proposed as Phase 3 of the CS study was cancelled by
  -- decision — inquiries keep their own page, they just stop being anonymous.
  assigned_admin_id UUID DEFAULT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  first_response_at TIMESTAMPTZ DEFAULT NULL,
  resolved_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stamps first_response_at / resolved_at from the status transition, so the
-- values are correct whichever client made the call.
CREATE OR REPLACE FUNCTION public.stamp_inquiry_service_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status <> 'new' THEN
      NEW.first_response_at := COALESCE(NEW.first_response_at, now());
    END IF;
    IF NEW.status = 'resolved' THEN
      NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    ELSE
      NEW.resolved_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_inquiries_stamp_service_state ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_stamp_service_state
  BEFORE UPDATE OF status ON public.contact_inquiries
  FOR EACH ROW EXECUTE FUNCTION public.stamp_inquiry_service_state();


-- ===================== 10. COMPANY INFORMATION =====================
CREATE TABLE IF NOT EXISTS company_information (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT,
  short_description TEXT,
  long_description TEXT,
  hero_image_url TEXT,
  hero_title TEXT,
  hero_description TEXT,
  hero_button_text TEXT,
  hero_button_link TEXT,
  email TEXT,
  facebook TEXT,
  messenger TEXT,
  website TEXT,
  smart_phone TEXT,
  globe_phone TEXT,
  manila_address TEXT,
  bohol_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  default_price_per_kg NUMERIC DEFAULT 0,
  features JSONB DEFAULT '[]'::jsonb,
  -- Coverage areas: replaces coverage_regions + coverage_municipalities tables
  -- Format: [{ id, name, display_order, municipalities: [{ id, name, display_order }] }]
  coverage JSONB DEFAULT '[]'::jsonb
);


-- ===================== 11. ACTIVITY LOGS =====================
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID DEFAULT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
  module TEXT NOT NULL CHECK (module IN ('Orders', 'Trips', 'Payments', 'Chat', 'Authentication', 'System')),
  action TEXT NOT NULL,
  record_type TEXT DEFAULT NULL,
  record_id UUID DEFAULT NULL,
  record_ref TEXT DEFAULT NULL,
  previous_value JSONB DEFAULT NULL,
  new_value JSONB DEFAULT NULL,
  details TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7-day retention: purge function + daily pg_cron job (matches live DB).
-- See migration: supabase/migrations/20260730150000_activity_logs_7day_retention.sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.purge_old_activity_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.activity_logs
  WHERE created_at < now() - interval '7 days';
END;
$$;

-- Cron runs as postgres; no client role should call this directly
REVOKE EXECUTE ON FUNCTION public.purge_old_activity_logs() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-old-activity-logs') THEN
    PERFORM cron.unschedule('purge-old-activity-logs');
  END IF;
END;
$$;

SELECT cron.schedule(
  'purge-old-activity-logs',
  '0 3 * * *',
  $$SELECT public.purge_old_activity_logs()$$
);


-- ===================== 12. COVERAGE AREAS =====================
-- NOTE: coverage_regions and coverage_municipalities tables have been merged
-- into company_information.coverage (JSONB array) for simplicity.
-- See migration: supabase/migrations/20260715000000_consolidate_tables.sql


-- ===================== 14. CUSTOMER FEEDBACK =====================
CREATE TABLE IF NOT EXISTS customer_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  message TEXT NOT NULL,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT unique_order_feedback UNIQUE (order_id)
);


-- ===================== 15. PAYMENT TRANSACTIONS =====================
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  payment_method TEXT NOT NULL,
  transaction_reference TEXT DEFAULT NULL,
  payment_status TEXT NOT NULL,
  admin_id UUID DEFAULT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payment_type TEXT DEFAULT 'Additional Payment',
  payment_date DATE DEFAULT NULL,
  receipt_url TEXT DEFAULT NULL
);


-- ============================================================
-- DEFAULT DATA
-- ============================================================


INSERT INTO company_information (
  id, name, short_description, hero_title, hero_description, default_price_per_kg
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'CargoExpress PH',
  'Fast & Reliable Cargo Delivery connecting Bohol and Manila with safe, affordable sea cargo shipping.',
  'Cargo Delivery Services',
  'Marlon Sarong Cargo Delivery Services at your service.',
  80
)
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_information ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;

-- ─── Profiles ────────────────────────────────────────────────
-- Users can read own, admins can read all, update own or admin update
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

-- ─── Trips ───────────────────────────────────────────────────
-- Everyone can read, admins can manage
CREATE POLICY "Anyone can view trips" ON trips
  FOR SELECT USING (true);

CREATE POLICY "Admins can manage trips" ON trips
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── Orders ──────────────────────────────────────────────────
-- Users see own, admins see all; users create own; admins update/delete
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

-- REMOVED (20260803120000_public_data_rpcs.sql): "Public can read featured
-- orders" / "…auth" granted anon EVERY column of a featured order — phones,
-- addresses, payment_reference, user_id — not just the ones the About page
-- selects. The public gallery now goes through get_featured_deliveries(),
-- a SECURITY DEFINER RPC with a whitelisted column list.
-- anon has no table-level access to orders.

-- ─── Announcements ──────────────────────────────────────────
-- Everyone reads, admins manage
CREATE POLICY "Anyone can view announcements" ON announcements
  FOR SELECT USING (true);

CREATE POLICY "Admins can manage announcements" ON announcements
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── Notifications ──────────────────────────────────────────
-- Users see/update own, admins can view/insert
CREATE POLICY "Users can view own notifications" ON notifications
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Admins can view notifications" ON notifications
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Users can update own notifications" ON notifications
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can insert own notifications" ON notifications
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins can insert notifications" ON notifications
  FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY "Users can delete own notifications" ON notifications
  FOR DELETE USING (user_id = auth.uid());

-- ─── User Device Tokens ─────────────────────────────────────
CREATE POLICY "Users can view own device tokens" ON user_device_tokens
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can insert own device tokens" ON user_device_tokens
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own device tokens" ON user_device_tokens
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─── Global Settings (now part of company_information) ──────────────────────
-- The global_settings table has been removed. Price-per-kg is stored in
-- company_information.default_price_per_kg. No RLS policies needed.


CREATE POLICY "Users can delete own device tokens" ON user_device_tokens
  FOR DELETE USING (user_id = auth.uid());

CREATE POLICY "Admins can insert device tokens" ON user_device_tokens
  FOR INSERT WITH CHECK (public.is_admin());

-- ─── Conversations ──────────────────────────────────────────
-- Customers see own, admins see all; customers create own
CREATE POLICY "Customers view own conversations" ON conversations
  FOR SELECT USING (
    customer_id = auth.uid() OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Customers insert own conversations" ON conversations
  FOR INSERT WITH CHECK (customer_id = auth.uid());

CREATE POLICY "Admins insert conversations" ON conversations
  FOR INSERT WITH CHECK (
    public.is_admin()
    AND EXISTS (SELECT 1 FROM profiles WHERE id = conversations.customer_id AND role = 'customer')
  );

CREATE POLICY "Admins can update conversations" ON conversations
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Customers can update own conversations" ON conversations
  FOR UPDATE USING (customer_id = auth.uid());

-- ─── Chat Messages ──────────────────────────────────────────
-- Users see/insert messages in conversations they belong to; admins can update
CREATE POLICY "Users view messages in allowed conversations" ON chat_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE id = chat_messages.conversation_id AND (
        customer_id = auth.uid() OR
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
      )
    )
  );

CREATE POLICY "Users insert messages in allowed conversations" ON chat_messages
  FOR INSERT WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations
      WHERE id = chat_messages.conversation_id AND (
        customer_id = auth.uid() OR
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
      )
    )
  );

CREATE POLICY "Admins update messages" ON chat_messages
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Customers can mark ADMIN messages as read (is_read → true) in their own conversations
CREATE POLICY "Customers mark admin messages read" ON chat_messages
  FOR UPDATE TO authenticated
  USING (
    sender_role = 'admin'
    AND EXISTS (
      SELECT 1 FROM conversations
      WHERE id = chat_messages.conversation_id AND customer_id = auth.uid()
    )
  )
  WITH CHECK (
    sender_role = 'admin'
    AND is_read = true
    AND EXISTS (
      SELECT 1 FROM conversations
      WHERE id = chat_messages.conversation_id AND customer_id = auth.uid()
    )
  );

-- ─── Contact Inquiries ──────────────────────────────────────
-- Anyone can insert (public form), admins can view/manage
CREATE POLICY "Anyone can submit inquiry" ON contact_inquiries
  FOR INSERT WITH CHECK (true);

-- ─── Coverage Areas (now JSONB in company_information) ──────────────────────
-- coverage_regions and coverage_municipalities have been merged into
-- company_information.coverage JSONB. No separate RLS policies needed.


CREATE POLICY "Admins can view inquiries" ON contact_inquiries
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can update contact inquiries" ON contact_inquiries
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete contact inquiries" ON contact_inquiries
  FOR DELETE USING (public.is_admin());

-- ─── Company Information ────────────────────────────────────
CREATE POLICY "Allow public read access" ON company_information
  FOR SELECT USING (true);

CREATE POLICY "Allow admin full access" ON company_information
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ─── Activity Logs ──────────────────────────────────────────
CREATE POLICY "Admins can view activity logs" ON activity_logs
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can insert activity logs" ON activity_logs
  FOR INSERT WITH CHECK (public.is_admin());

-- Customers can log their own actions (login, booking); admin_id must match auth.uid()
CREATE POLICY "Users can insert their own activity logs" ON activity_logs
  FOR INSERT TO authenticated
  WITH CHECK (admin_id = auth.uid());

-- ─── Coverage Regions / Municipalities ──────────────────────
-- REMOVED: Tables dropped in migration 20260715000000_consolidate_tables.sql
-- Coverage data is now stored in company_information.coverage (JSONB).

-- ─── Customer Feedback ──────────────────────────────────────
CREATE POLICY "Admins can manage all feedback" ON customer_feedback
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Customers can insert own feedback" ON customer_feedback
  FOR INSERT WITH CHECK (auth.uid() = customer_id);

CREATE POLICY "Customers can read own feedback" ON customer_feedback
  FOR SELECT USING (auth.uid() = customer_id);

-- REMOVED (20260803120000_public_data_rpcs.sql): two byte-identical policies,
-- neither with a TO clause, exposed customer_id for every visible testimonial
-- to anon. Public testimonials now come from get_public_feedback(), which
-- masks the author name and never returns customer_id.

-- ─── Payment Transactions ───────────────────────────────────
CREATE POLICY "Admins can insert and select payment transactions" ON payment_transactions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Customers can view their own payment transactions" ON payment_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM orders WHERE id = payment_transactions.order_id AND user_id = auth.uid())
  );


-- ============================================================
-- CHECK CONSTRAINTS
-- Added 20260803130000. conversations.status and contact_inquiries.status
-- are declared inline on their tables above.
-- ============================================================
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_amount_paid_non_negative;
ALTER TABLE orders
  ADD CONSTRAINT orders_amount_paid_non_negative CHECK (amount_paid >= 0);

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_remaining_balance_non_negative;
ALTER TABLE orders
  ADD CONSTRAINT orders_remaining_balance_non_negative CHECK (remaining_balance >= 0);

-- Previously validated only in CreateTripPage.jsx — i.e. not at all, from the
-- database's point of view.
--
-- Safe on a fresh install. On the existing production DB this had to be
-- deferred: pre-existing rows violate it. See
-- 20260803131000_trips_date_constraint.sql, which must be applied only after
-- those rows are reconciled — a NOT VALID constraint still re-checks a row on
-- every UPDATE, so adding it early would make the offending trips uneditable
-- and strand their orders.
ALTER TABLE trips
  DROP CONSTRAINT IF EXISTS trips_arrival_after_departure;
ALTER TABLE trips
  ADD CONSTRAINT trips_arrival_after_departure
  CHECK (arrival_date IS NULL OR arrival_date > departure_date);

-- company_information is a singleton that every reader assumes (hardcoded
-- UUID, .single()). Make it structural rather than conventional.
ALTER TABLE company_information
  DROP CONSTRAINT IF EXISTS company_information_singleton;
ALTER TABLE company_information
  ADD CONSTRAINT company_information_singleton
  CHECK (id = '00000000-0000-0000-0000-000000000001');


-- ============================================================
-- INDEXES (Performance)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_trip_id ON orders(trip_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
-- idx_orders_tracking removed (20260803130000): duplicate of the UNIQUE index
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
-- idx_conversations_customer_id removed (20260803130000): duplicate of UNIQUE
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
-- idx_chat_messages_conv_id removed (duplicate of idx_chat_messages_conversation_id)
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_created_at ON contact_inquiries(created_at);
-- idx_profiles_fcm_token removed (fcm_token column dropped; tokens now in user_device_tokens)
CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notification_id
  ON notification_delivery_attempts(notification_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_device_tokens_user_id ON user_device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_admin_id ON activity_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_module ON activity_logs(module);
CREATE INDEX IF NOT EXISTS idx_activity_logs_record_id ON activity_logs(record_id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_tx_ref ON payment_transactions(transaction_reference) WHERE transaction_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_id ON payment_transactions(order_id);

-- Added 20260803130000 — each backs a query the app already runs.
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_featured ON orders(featured_at DESC) WHERE featured_on_website = true;
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON chat_messages(conversation_id, sender_role, is_read);
CREATE INDEX IF NOT EXISTS idx_customer_feedback_customer_id ON customer_feedback(customer_id);
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_status ON contact_inquiries(status);
CREATE INDEX IF NOT EXISTS idx_trips_departure_date ON trips(departure_date);


-- ============================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trips_updated_at BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER announcements_updated_at BEFORE UPDATE ON announcements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- payment_attempts_updated_at trigger: moved to after CREATE TABLE payment_attempts (line ~1323)


-- ============================================================
-- CHAT MESSAGE GUARD
-- ============================================================
-- Guard: enforce sender_role matches the authenticated user's actual role
CREATE OR REPLACE FUNCTION public.guard_chat_message_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actual_role TEXT;
BEGIN
  SELECT role INTO actual_role FROM public.profiles WHERE id = auth.uid();
  IF actual_role IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  NEW.sender_id := auth.uid();
  NEW.sender_role := actual_role;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_guard_insert ON chat_messages;
CREATE TRIGGER chat_messages_guard_insert
  BEFORE INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_message_insert();


-- ============================================================
-- CONVERSATION SERVICE STATE (20260804210000)
-- Derived service values are maintained server-side, never written by a
-- client — same principle as update_order_payment_totals. The auto-reopen
-- in the customer branch is what structurally prevents a resolved thread
-- from burying a customer who writes again.
-- A 'bot' message deliberately changes nothing: a bot reply is not a
-- response for service purposes and must never clear the queue.
-- ============================================================
CREATE OR REPLACE FUNCTION public.maintain_conversation_service_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM public.conversations WHERE id = NEW.conversation_id;

  -- Marks this as a SERVER decision so guard_conversation_update lets the
  -- status move through. Transaction-local and cleared immediately; a client
  -- cannot set it, since inserting a message is its own transaction.
  PERFORM set_config('app.conversation_service_write', 'on', true);

  IF NEW.sender_role = 'customer' THEN
    UPDATE public.conversations
       SET last_customer_message_at = NEW.created_at,
           status = CASE
                      WHEN v_status = 'bot_active' THEN 'bot_active'
                      WHEN v_status = 'resolved'   THEN 'bot_active'
                      ELSE 'waiting'
                    END,
           resolved_at = NULL
     WHERE id = NEW.conversation_id;

  ELSIF NEW.sender_role = 'admin' THEN
    -- An admin replying IS the signal that we are waiting on the customer.
    -- This replaced a manual "Awaiting Customer" button.
    UPDATE public.conversations
       SET first_response_at = COALESCE(first_response_at, NEW.created_at),
           status = 'waiting_customer'
     WHERE id = NEW.conversation_id;
  END IF;

  PERFORM set_config('app.conversation_service_write', 'off', true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_maintain_service_state ON public.chat_messages;
CREATE TRIGGER chat_messages_maintain_service_state
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.maintain_conversation_service_state();

-- Bounds what a CUSTOMER may write to their own conversation. The RLS policy
-- has USING but no WITH CHECK, so without this a customer could set their own
-- status (hiding from or jumping the admin queue), point the conversation at
-- an admin, or forge first_response_at into the service report.
-- Allowed: bot_resolved (only they know it), escalated -> TRUE, and
-- status -> 'waiting' (asking for a human). Everything else reverts to OLD.
-- Runs BEFORE stamp_conversation_resolved_at — alphabetical trigger order,
-- which is the order we need. See 20260804240000_guard_conversation_update.sql.
CREATE OR REPLACE FUNCTION public.guard_conversation_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  NEW.assigned_admin_id        := OLD.assigned_admin_id;
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
$$;

DROP TRIGGER IF EXISTS conversations_guard_update ON public.conversations;
CREATE TRIGGER conversations_guard_update
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_update();

CREATE OR REPLACE FUNCTION public.stamp_conversation_resolved_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN
    NEW.resolved_at := COALESCE(NEW.resolved_at, now());
  ELSIF NEW.status <> 'resolved' THEN
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_stamp_resolved_at ON public.conversations;
CREATE TRIGGER conversations_stamp_resolved_at
  BEFORE UPDATE OF status ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_conversation_resolved_at();

-- Nightly sweep. Excluding 'waiting' is load-bearing: a timer must never
-- clear a conversation where a human is still needed.
CREATE OR REPLACE FUNCTION public.auto_resolve_stale_conversations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE EXECUTE ON FUNCTION public.auto_resolve_stale_conversations() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-resolve-stale-conversations') THEN
    PERFORM cron.unschedule('auto-resolve-stale-conversations');
  END IF;
END;
$$;

SELECT cron.schedule(
  'auto-resolve-stale-conversations',
  '30 3 * * *',
  $$SELECT public.auto_resolve_stale_conversations()$$
);


-- ============================================================
-- ACTIVITY LOG WRITE GUARD
-- Same principle as guard_chat_message_insert: identity is taken from
-- auth.uid(), never from the client. Without it any authenticated customer
-- could forge staff entries in the audit trail — the RLS policy only pins
-- admin_id, leaving admin_name / module / action as free text.
-- Non-admins are limited to the modules the customer app actually writes.
-- See migration 20260804160000_activity_log_guard.sql.
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_activity_log_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- 'Chat' is written by the log_customer_chat_message() trigger on the
  -- customer's own behalf. Omitting it aborted the customer's chat_messages
  -- INSERT outright — see 20260804220000_fix_chat_activity_log_guard.sql.
  -- Any future narrowing of this list must enumerate SERVER-SIDE writers too,
  -- not just logActivity() calls in the client.
  IF NOT v_is_admin AND NEW.module NOT IN ('Orders', 'Authentication', 'Chat') THEN
    RAISE EXCEPTION 'Not allowed to write % activity logs', NEW.module;
  END IF;

  SELECT name INTO v_name FROM public.profiles WHERE id = v_uid;

  NEW.admin_id   := v_uid;
  NEW.admin_name := COALESCE(NULLIF(btrim(v_name), ''), 'Unknown Admin');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS activity_logs_guard_insert ON public.activity_logs;
CREATE TRIGGER activity_logs_guard_insert
  BEFORE INSERT ON public.activity_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_activity_log_insert();


-- ============================================================
-- ENABLE REALTIME
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE contact_inquiries;


-- ============================================================
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
  -- actual_weight only: an unweighed booking contributes nothing (20260805130000)
  SELECT COALESCE(SUM(COALESCE(actual_weight, 0)), 0)
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
  -- Price per kg is stored directly in company_information.default_price_per_kg
  -- global_settings table has been removed (merged into company_information)
  SELECT COALESCE(
    (SELECT default_price_per_kg FROM public.company_information
     WHERE id = '00000000-0000-0000-0000-000000000001' LIMIT 1),
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
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Cannot create orders for another user';
  END IF;

  -- No customer-declared weight any more, so a booking carries no price:
  -- shipping_cost is set when an admin weighs the parcel (20260805130000).
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
$$;

-- Single source of truth for payment_status. Both the ledger trigger and
-- guard_order_update call it, so a weight correction and a payment can never
-- label the same order differently. 'unpaid' when nothing is collected also
-- covers an unpriced booking (cost 0, paid 0), which a `remaining <= 0` test
-- wrongly called 'paid'. See 20260805120000.
CREATE OR REPLACE FUNCTION public.derive_payment_status(
  p_shipping_cost NUMERIC,
  p_amount_paid   NUMERIC
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN COALESCE(p_amount_paid, 0) <= 0 THEN 'unpaid'
    WHEN COALESCE(p_amount_paid, 0) >= COALESCE(p_shipping_cost, 0) - 0.005 THEN 'paid'
    ELSE 'partial'
  END;
$$;

REVOKE ALL ON FUNCTION public.derive_payment_status(NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derive_payment_status(NUMERIC, NUMERIC) TO authenticated, service_role;

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
BEGIN
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

  -- ── Warehouse dispatch gate (20260804100000) ─────────────────────────────
  -- Unpaid cargo is held at the destination warehouse and not dispatched for
  -- doorstep delivery. Freight Collect is exempt (payment is due at the door);
  -- a recorded Promise Date is the explicit override.
  -- Placed last so it sees the recomputed remaining_balance above.
  IF NEW.status = 'Out for Delivery' AND OLD.status IS DISTINCT FROM NEW.status THEN
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

-- mask_name(full_name): collapse a name to "First L." (privacy-safe).
-- Used by the public tracking RPC so anonymous visitors never see full PII.
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

-- Public tracking: names masked, phones/addresses/payment never returned,
-- trip.arrival_date surfaced as estimated_delivery for an ETA banner.
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

GRANT EXECUTE ON FUNCTION public.mask_name(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.track_order_public(TEXT) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_public_business_profile();

CREATE OR REPLACE FUNCTION public.get_public_business_profile()
RETURNS TABLE (
  name TEXT,
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
    c.name,
    c.smart_phone,
    c.globe_phone,
    c.facebook AS facebook_link,
    c.manila_address,
    c.bohol_address
  FROM public.company_information c
  WHERE c.id = '00000000-0000-0000-0000-000000000001'
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

-- ============================================================
-- SERVICE REPORTING (20260804250000)
-- Backs the Customer Service tab in Sales & Reports. Measurements only —
-- no SLA targets, because chat support has no real traffic to calibrate
-- one against yet. Response time is measured per MESSAGE (each customer
-- message paired with the next admin reply), not just the first exchange
-- in a thread.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_service_summary()
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

  WITH
  -- Every customer message paired with the next admin reply, if any.
  asked AS (
    SELECT m.id, m.conversation_id, m.created_at AS asked_at,
           (SELECT MIN(a.created_at)
              FROM public.chat_messages a
             WHERE a.conversation_id = m.conversation_id
               AND a.sender_role = 'admin'
               AND a.created_at > m.created_at) AS answered_at
      FROM public.chat_messages m
     WHERE m.sender_role = 'customer'
  ),
  waits AS (
    SELECT EXTRACT(EPOCH FROM (answered_at - asked_at)) / 60.0 AS minutes
      FROM asked
     WHERE answered_at IS NOT NULL
  ),
  response AS (
    SELECT jsonb_build_object(
      'customerMessages',   (SELECT COUNT(*) FROM asked),
      'answered',           (SELECT COUNT(*) FROM asked WHERE answered_at IS NOT NULL),
      'neverAnswered',      (SELECT COUNT(*) FROM asked WHERE answered_at IS NULL),
      'medianMinutes',      (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY minutes)::numeric, 1) FROM waits),
      'p90Minutes',         (SELECT ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY minutes)::numeric, 1) FROM waits),
      'worstMinutes',       (SELECT ROUND(MAX(minutes)::numeric, 1) FROM waits)
    ) AS value
  ),
  queue AS (
    SELECT jsonb_build_object(
      'total',            COUNT(*),
      'botActive',        COUNT(*) FILTER (WHERE status = 'bot_active'),
      'waiting',          COUNT(*) FILTER (WHERE status = 'waiting'),
      'waitingCustomer',  COUNT(*) FILTER (WHERE status = 'waiting_customer'),
      'resolved',         COUNT(*) FILTER (WHERE status = 'resolved'),
      'escalated',        COUNT(*) FILTER (WHERE escalated),
      'unassigned',       COUNT(*) FILTER (
                            WHERE status IN ('waiting', 'waiting_customer')
                              AND assigned_admin_id IS NULL),
      'waitingOver24h',   COUNT(*) FILTER (
                            WHERE status = 'waiting'
                              AND COALESCE(last_customer_message_at, created_at) < now() - interval '24 hours'),
      'oldestWaitHours',  COALESCE(ROUND(MAX(
                            CASE WHEN status = 'waiting'
                                 THEN EXTRACT(EPOCH FROM (now() - COALESCE(last_customer_message_at, created_at))) / 3600.0
                            END)::numeric, 1), 0)
    ) AS value
    FROM public.conversations
  ),
  -- Bot deflection. NULL is reported as its own bucket rather than folded
  -- into a denominator: "we never asked" is not the same as "it failed".
  bot AS (
    SELECT jsonb_build_object(
      'helped',    COUNT(*) FILTER (WHERE bot_resolved IS TRUE),
      'notHelped', COUNT(*) FILTER (WHERE bot_resolved IS FALSE),
      'unknown',   COUNT(*) FILTER (WHERE bot_resolved IS NULL),
      'answered',  (SELECT COUNT(*) FROM public.chat_messages WHERE sender_role = 'bot')
    ) AS value
    FROM public.conversations
  ),
  inquiries AS (
    SELECT jsonb_build_object(
      'total',      COUNT(*),
      'new',        COUNT(*) FILTER (WHERE status = 'new'),
      'read',       COUNT(*) FILTER (WHERE status = 'read'),
      'resolved',   COUNT(*) FILTER (WHERE status = 'resolved'),
      'unassigned', COUNT(*) FILTER (WHERE status <> 'resolved' AND assigned_admin_id IS NULL),
      'measured',   COUNT(*) FILTER (WHERE first_response_at IS NOT NULL),
      'medianResponseMinutes', ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60.0
      ) FILTER (WHERE first_response_at IS NOT NULL)::numeric, 1)
    ) AS value
    FROM public.contact_inquiries
  ),
  volume AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.week), '[]'::jsonb) AS value
    FROM (
      SELECT TO_CHAR(DATE_TRUNC('week', created_at), 'YYYY-MM-DD') AS week,
             COUNT(*) FILTER (WHERE sender_role = 'customer') AS customer_msgs,
             COUNT(*) FILTER (WHERE sender_role = 'admin')    AS admin_msgs,
             COUNT(*) FILTER (WHERE sender_role = 'bot')      AS bot_msgs
        FROM public.chat_messages
       WHERE created_at > now() - interval '12 weeks'
       GROUP BY DATE_TRUNC('week', created_at)
    ) v
  ),
  -- Demand by hour, Asia/Manila. Staffing information: it says when
  -- customers actually write, which is not necessarily when anyone is
  -- looking.
  hourly AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.hour), '[]'::jsonb) AS value
    FROM (
      SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Manila')::int AS hour,
             COUNT(*) AS customer_msgs
        FROM public.chat_messages
       WHERE sender_role = 'customer'
       GROUP BY 1
    ) h
  )
  SELECT jsonb_build_object(
    'response',  response.value,
    'queue',     queue.value,
    'bot',       bot.value,
    'inquiries', inquiries.value,
    'volume',    volume.value,
    'hourly',    hourly.value,
    'generatedAt', to_jsonb(now())
  )
  INTO payload
  FROM response, queue, bot, inquiries, volume, hourly;

  RETURN payload;
END;
$$;

REVOKE ALL ON FUNCTION public.get_service_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_service_summary() TO authenticated;


-- ============================================================
-- INBOX MESSAGE SEARCH (20260805100000)
-- Substring search over chat bodies so an admin can find a thread by what was
-- said in it. ILIKE rather than to_tsvector: admins search fragments ('motor'
-- must find "motorcycle", 'CE-2026' must survive the parser), which full-text
-- stemming would not match. Admin-gated — it reads every customer's history,
-- and SECURITY DEFINER bypasses the RLS that normally prevents that.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Substring search over message bodies. GIN + trigram is the index type that
-- can actually serve ILIKE '%term%'; a btree cannot.
CREATE INDEX IF NOT EXISTS chat_messages_message_trgm_idx
  ON public.chat_messages USING GIN (message gin_trgm_ops);


CREATE OR REPLACE FUNCTION public.search_conversation_messages(p_query TEXT)
RETURNS TABLE (
  conversation_id UUID,
  match_count     INTEGER,
  snippet         TEXT,
  matched_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.search_conversation_messages(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_conversation_messages(TEXT) TO authenticated;




-- ============================================================
-- AUTH TRIGGER — Auto-create profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, role, created_at, updated_at)
  VALUES (
    NEW.id, NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'name',''), initcap(split_part(NEW.email,'@',1))),
    'customer', now(), now()
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- AUTH TRIGGER — Sync email changes from auth.users to profiles
-- Keeps profiles.email (the app's source of truth) current when a
-- user changes their email and confirms it. Still live in the DB.
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_auth_email_to_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles
    SET email = NEW.email,
        updated_at = NOW()
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_change ON auth.users;
CREATE TRIGGER on_auth_user_email_change
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_auth_email_to_profile();


-- ============================================================
-- CHAT ACTIVITY LOGGING
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_customer_chat_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

DROP TRIGGER IF EXISTS trigger_log_customer_chat ON chat_messages;
CREATE TRIGGER trigger_log_customer_chat
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.log_customer_chat_message();


-- ============================================================
-- TRIP REASSIGNMENT
-- ============================================================
CREATE OR REPLACE FUNCTION public.reassign_trip(p_order_id UUID, p_new_trip_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_old_trip_id UUID;
  v_admin_id UUID;
  v_reassignment_history JSONB;
BEGIN
  v_admin_id := auth.uid();
  IF v_admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only administrators can reassign trips';
  END IF;

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
$$;

ALTER FUNCTION public.reassign_trip(UUID, UUID, TEXT) SET search_path = public;
REVOKE ALL ON FUNCTION public.reassign_trip(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_trip(UUID, UUID, TEXT) TO authenticated;


-- ============================================================
-- PAYMENT TRANSACTION TOTALS TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_paid DECIMAL(10,2);
  v_shipping_cost DECIMAL(10,2);
  v_remaining DECIMAL(10,2);
  v_order_id UUID;
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
$$;

DROP TRIGGER IF EXISTS trigger_update_totals_after_payment ON payment_transactions;
CREATE TRIGGER trigger_update_totals_after_payment
  AFTER INSERT OR UPDATE OR DELETE ON payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_order_payment_totals();


-- ============================================================
-- PUBLIC DATA RPCs — About page gallery and testimonials
-- See migration: supabase/migrations/20260803120000_public_data_rpcs.sql
--
-- These replace four over-broad RLS policies that granted anon whole-row
-- access to featured orders and to customer_feedback.customer_id.
-- Never widen table-level anon access to serve a public page — add an RPC.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_featured_deliveries()
RETURNS TABLE (
  id                  UUID,
  featured_title      TEXT,
  featured_caption    TEXT,
  featured_image_type TEXT,
  featured_at         TIMESTAMPTZ,
  pickup_photos       JSONB,
  delivery_photos     JSONB,
  receiver_city       TEXT,
  receiver_province   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    o.featured_title,
    o.featured_caption,
    o.featured_image_type,
    o.featured_at,
    o.pickup_photos,
    o.delivery_photos,
    o.receiver_city,
    o.receiver_province
  FROM public.orders o
  WHERE o.featured_on_website = true
  ORDER BY o.featured_at DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_featured_deliveries() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_public_feedback()
RETURNS TABLE (
  id                  UUID,
  rating              INTEGER,
  message             TEXT,
  created_at          TIMESTAMPTZ,
  customer_name       TEXT,
  featured_on_website BOOLEAN,
  featured_image_type TEXT,
  pickup_photos       JSONB,
  delivery_photos     JSONB,
  receiver_city       TEXT,
  receiver_province   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.id,
    f.rating,
    f.message,
    f.created_at,
    public.mask_name(p.name) AS customer_name,
    COALESCE(o.featured_on_website, false) AS featured_on_website,
    o.featured_image_type,
    o.pickup_photos,
    o.delivery_photos,
    o.receiver_city,
    o.receiver_province
  FROM public.customer_feedback f
  LEFT JOIN public.profiles p ON p.id = f.customer_id
  LEFT JOIN public.orders   o ON o.id = f.order_id
  WHERE f.is_hidden = false
  ORDER BY f.rating DESC, f.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_feedback() TO anon, authenticated;


-- ============================================================
-- ORDER STATUS EVENTS — permanent shipment history
-- See migration: supabase/migrations/20260803110000_order_status_events.sql
--
-- The tracking timeline used to be reconstructed by string-matching
-- activity_logs, which is purged after 7 days — so timelines silently
-- collapsed to created_at once they aged out. This append-only table is fed
-- by a trigger and has no retention purge.
--
-- Deliberately NOT unique on (order_id, status): a status can be re-entered.
-- Consumers take MIN(changed_at) per status for "first reached".
-- ============================================================
CREATE TABLE IF NOT EXISTS public.order_status_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  status     VARCHAR(30) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by UUID DEFAULT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  note       TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_status_events_order_id
  ON public.order_status_events(order_id, changed_at);

ALTER TABLE public.order_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own order status events" ON public.order_status_events;
CREATE POLICY "Users view own order status events" ON public.order_status_events
  FOR SELECT USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_status_events.order_id
        AND o.user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policy: rows come only from the trigger below.

CREATE OR REPLACE FUNCTION public.log_order_status_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_status_events (order_id, status, changed_at, changed_by)
    VALUES (NEW.id, NEW.status, COALESCE(NEW.created_at, NOW()), auth.uid());
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.order_status_events (order_id, status, changed_at, changed_by)
    VALUES (NEW.id, NEW.status, NOW(), auth.uid());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_log_status_event ON public.orders;
CREATE TRIGGER orders_log_status_event
  AFTER INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.log_order_status_event();

-- Public tracking: status + timestamp only. No names, amounts, or ids.
CREATE OR REPLACE FUNCTION public.get_public_order_events(p_tracking_number TEXT)
RETURNS TABLE (
  status     VARCHAR,
  changed_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.status, MIN(e.changed_at) AS changed_at
  FROM public.order_status_events e
  JOIN public.orders o ON o.id = e.order_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  GROUP BY e.status
  ORDER BY MIN(e.changed_at);
$$;

GRANT EXECUTE ON FUNCTION public.get_public_order_events(TEXT) TO anon, authenticated;

-- (The one-time historical backfill lives in the migration only.)


-- ============================================================
-- ATOMIC PICKUP / DELIVERY PAYMENT RECORDING
-- See migration: supabase/migrations/20260803100000_atomic_order_payment.sql
--
-- These RPCs write order METADATA only. amount_paid / remaining_balance /
-- payment_status are derived by update_order_payment_totals from the
-- payment_transactions ledger — the ledger is the single source of truth.
--
-- Step order is load-bearing: the orders UPDATE must run first so
-- guard_order_update recomputes shipping_cost from the new actual_weight
-- before the ledger trigger reads it to derive the remaining balance.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_pickup_payment(
  p_order_id              UUID,
  p_actual_weight         NUMERIC,
  p_payment_method        TEXT,
  p_payer_type            TEXT    DEFAULT 'sender',
  p_pickup_photos         JSONB   DEFAULT '[]'::jsonb,
  p_promised_payment_date DATE    DEFAULT NULL,
  p_amount                NUMERIC DEFAULT NULL,
  p_reference             TEXT    DEFAULT NULL,
  p_payment_date          DATE    DEFAULT NULL,
  p_receipt_url           TEXT    DEFAULT NULL,
  p_payment_type          TEXT    DEFAULT 'Initial Payment',
  p_notes                 TEXT    DEFAULT 'Initial pickup payment'
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  IF COALESCE(p_actual_weight, 0) <= 0 THEN
    RAISE EXCEPTION 'Actual weight must be greater than zero';
  END IF;

  UPDATE public.orders
     SET actual_weight         = p_actual_weight,
         payment_method        = p_payment_method,
         payer_type            = COALESCE(p_payer_type, payer_type, 'sender'),
         pickup_photos         = COALESCE(p_pickup_photos, pickup_photos),
         promised_payment_date = p_promised_payment_date,
         payment_reference     = COALESCE(p_reference, payment_reference),
         status                = 'Picked Up'
   WHERE id = p_order_id;

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
      p_order_id, p_amount, p_payment_method, v_label,
      p_reference, auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
      p_payment_type, p_payment_date, p_receipt_url
    )
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_delivery_payment(
  p_order_id        UUID,
  p_delivery_photos JSONB   DEFAULT '[]'::jsonb,
  p_payment_method  TEXT    DEFAULT NULL,
  p_amount          NUMERIC DEFAULT NULL,
  p_reference       TEXT    DEFAULT NULL,
  p_payment_date    DATE    DEFAULT NULL,
  p_receipt_url     TEXT    DEFAULT NULL,
  p_payment_type    TEXT    DEFAULT 'Balance Settlement',
  p_notes           TEXT    DEFAULT 'Balance settlement upon delivery',
  p_promised_payment_date DATE DEFAULT NULL
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  UPDATE public.orders
     SET delivery_photos       = COALESCE(p_delivery_photos, delivery_photos),
         payment_method        = COALESCE(p_payment_method, payment_method),
         payment_reference     = COALESCE(p_reference, payment_reference),
         promised_payment_date = COALESCE(p_promised_payment_date, promised_payment_date),
         status                = 'Delivered'
   WHERE id = p_order_id;

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
$$;

REVOKE EXECUTE ON FUNCTION public.record_pickup_payment(UUID, NUMERIC, TEXT, TEXT, JSONB, DATE, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_pickup_payment(UUID, NUMERIC, TEXT, TEXT, JSONB, DATE, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE) TO authenticated;


-- Supabase Storage bucket for proof photos.
--
-- public = FALSE. Proof photos and receipts sit under guessable paths (the
-- tracking number is in the path), so the bucket is private and the app uses
-- signed URLs (see 20260804180000_customer_photo_access.sql and
-- 20260804200000_lock_cargo_photos.sql). Company website decoration lives in
-- the separate public `company-assets` bucket below.
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

-- Public bucket for company website assets (hero, gallery, timeline).
-- Separate from cargo-photos so website decoration and cargo evidence are not
-- forced to share one privacy setting.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-assets',
  'company-assets',
  TRUE,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Admins manage cargo photos" ON storage.objects;
DROP POLICY IF EXISTS "Users read own cargo photos" ON storage.objects;
DROP POLICY IF EXISTS "Public read company assets" ON storage.objects;
DROP POLICY IF EXISTS "Admins manage company assets" ON storage.objects;

CREATE POLICY "Admins manage cargo photos" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'cargo-photos' AND public.is_admin())
  WITH CHECK (bucket_id = 'cargo-photos' AND public.is_admin());

CREATE POLICY "Admins manage company assets" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'company-assets' AND public.is_admin())
  WITH CHECK (bucket_id = 'company-assets' AND public.is_admin());

-- Customers read the evidence for their OWN shipments.
-- Matches both path schemes: the current <folder>/<tracking-number>/<file>
-- and the original <folder>/<order-uuid>/<file>. Keying on the UUID alone
-- silently stopped matching when the naming scheme changed, so this policy
-- granted nothing at all until 20260804180000_customer_photo_access.sql.
CREATE POLICY "Users read own cargo photos" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cargo-photos'
    AND (storage.foldername(name))[1] IN (
      'pickup', 'delivery', 'receipts',
      'pickup-proofs', 'delivery-proofs'
    )
    AND EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.user_id = auth.uid()
        AND (
          o.tracking_number = (storage.foldername(name))[2]
          OR o.id = public.safe_uuid((storage.foldername(name))[2])
        )
    )
  );

-- Company website assets stay readable to anonymous visitors (the About page
-- is public), and are the only folders anon may sign a URL for.
CREATE POLICY "Public read company assets" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id IN ('cargo-photos', 'company-assets')
    AND (storage.foldername(name))[1] IN ('gallery', 'hero', 'timeline')
  );

-- Featured delivery photos stay readable to anonymous visitors (About page
-- gallery) even though the bucket is private. The helper is SECURITY DEFINER
-- because anon has no table-level access to orders; it reads one boolean and
-- leaks nothing else.
CREATE OR REPLACE FUNCTION public.is_featured_order_ref(p_ref TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.featured_on_website = TRUE
      AND (
        o.tracking_number = p_ref
        OR o.id = public.safe_uuid(p_ref)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_featured_order_ref(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_featured_order_ref(TEXT) TO anon, authenticated;

DROP POLICY IF EXISTS "Public read featured delivery photos" ON storage.objects;

CREATE POLICY "Public read featured delivery photos" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id = 'cargo-photos'
    AND (storage.foldername(name))[1] IN (
      'pickup', 'delivery', 'pickup-proofs', 'delivery-proofs'
    )
    AND public.is_featured_order_ref((storage.foldername(name))[2])
  );

-- ============================================================
-- PAYMENT RECONCILIATION
-- ============================================================
CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  description TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'chargeable', 'reconciled', 'failed')),
  payment_id TEXT UNIQUE DEFAULT NULL,
  payment_status TEXT DEFAULT NULL,
  actual_weight DECIMAL(10,2) DEFAULT NULL,
  payer_type VARCHAR(20) DEFAULT 'sender' CHECK (payer_type IN ('sender', 'receiver')),
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  payment_type TEXT DEFAULT 'full' CHECK (payment_type IN ('full', 'paylater')),
  estimated_cost DECIMAL(10,2) DEFAULT NULL,
  promised_payment_date DATE DEFAULT NULL,
  last_error TEXT DEFAULT NULL,
  reconciled_at TIMESTAMPTZ DEFAULT NULL,
  created_by UUID DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage payment attempts" ON public.payment_attempts;
CREATE POLICY "Admins can manage payment attempts" ON public.payment_attempts
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order_id ON public.payment_attempts(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON public.payment_attempts(status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_created_at ON public.payment_attempts(created_at DESC);

DROP TRIGGER IF EXISTS payment_attempts_updated_at ON public.payment_attempts;
CREATE TRIGGER payment_attempts_updated_at BEFORE UPDATE ON public.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.reconcile_paymongo_payment_attempt(
  p_source_id TEXT,
  p_payment_id TEXT,
  p_payment_amount DECIMAL,
  p_payment_status TEXT DEFAULT 'paid'
)
RETURNS TABLE (
  order_reconciled BOOLEAN,
  order_id UUID,
  payment_id TEXT,
  message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    -- THE FIX: the index predicate is required to infer a PARTIAL index
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;

    -- Order metadata only. amount_paid is deliberately NOT written here --
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
$$;

-- The REVOKE is the load-bearing half. PostgreSQL grants EXECUTE to PUBLIC on
-- every new function, so a bare GRANT TO service_role left this SECURITY
-- DEFINER payment-writing RPC callable by `anon` — a direct payment-forgery
-- path for anyone holding a source id from a checkout QR.
-- See 20260804190000_function_privileges.sql.
REVOKE ALL ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, DECIMAL, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_paymongo_payment_attempt(TEXT, TEXT, DECIMAL, TEXT) TO service_role;

-- =====================================================================
-- 28. ADMIN NOTIFICATIONS RPC
-- =====================================================================
CREATE OR REPLACE FUNCTION public.create_admin_notifications_rpc(
  p_title TEXT,
  p_message TEXT,
  p_type TEXT,
  p_reference_id UUID DEFAULT NULL
)
RETURNS TABLE (admin_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Authenticated callers only. Created without grants, this SECURITY DEFINER
  -- function defaulted to EXECUTE TO PUBLIC — letting anonymous visitors push
  -- arbitrary text into every admin's notification feed.
  -- See migration 20260804160000_activity_log_guard.sql.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    SELECT id, p_title, p_message, p_type, p_reference_id
    FROM public.profiles
    WHERE role = 'admin'
    RETURNING user_id
  )
  SELECT user_id FROM inserted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_admin_notifications_rpc(TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_admin_notifications_rpc(TEXT, TEXT, TEXT, UUID) TO authenticated;


-- ============================================================
-- TRIP COMPLETION GUARD (20260804100000)
-- A trip cannot be completed while any of its orders still owes money.
-- This is the enforceable form of "an order can never be tagged Completed
-- while unpaid" — orders have no Completed status, but trips do.
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_trip_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count     INT;
  v_unsettled TEXT;
BEGIN
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

      -- '%%' in a RAISE format string is an escaped literal '%', not two
      -- placeholders. Append the marker to the string instead.
      IF v_count > 5 THEN
        v_unsettled := v_unsettled || ' …';
      END IF;

      RAISE EXCEPTION
        'Cannot complete trip % — % order(s) still have an unpaid balance: %',
        NEW.trip_number, v_count, v_unsettled;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trips_guard_completion ON public.trips;
CREATE TRIGGER trips_guard_completion
  BEFORE UPDATE OF status ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_completion();
