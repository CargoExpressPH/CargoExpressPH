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
  address TEXT DEFAULT NULL,
  address_lot_block VARCHAR(255) DEFAULT NULL,
  address_street VARCHAR(255) DEFAULT NULL,
  address_barangay VARCHAR(255) DEFAULT NULL,
  address_city VARCHAR(255) DEFAULT NULL,
  address_province VARCHAR(255) DEFAULT NULL,
  role VARCHAR(20) DEFAULT 'customer' CHECK (role IN ('admin', 'customer')),
  -- Contact & social
  facebook_name TEXT DEFAULT NULL,
  address_landmark TEXT DEFAULT NULL,
  -- Push notifications (FCM)
  fcm_token TEXT DEFAULT NULL,
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
  available_slots INTEGER DEFAULT 0,
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
  package_weight DECIMAL(10,2) DEFAULT 0,
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
  -- Pickup & delivery proof (photo arrays)
  pickup_photos JSONB DEFAULT '[]'::jsonb,
  delivery_photos JSONB DEFAULT '[]'::jsonb,
  -- Service area
  service_area_status TEXT DEFAULT 'standard' CHECK (service_area_status IN ('standard', 'for_review', 'approved', 'rejected')),
  service_area_remarks TEXT DEFAULT NULL,
  -- Payment extras
  payment_date DATE DEFAULT NULL,
  receipt_url TEXT DEFAULT NULL,
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
  status TEXT DEFAULT 'open',
  assigned_admin_id UUID DEFAULT NULL
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
  phone TEXT DEFAULT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


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
  stat_years INTEGER DEFAULT 0,
  stat_deliveries INTEGER DEFAULT 0,
  stat_customers INTEGER DEFAULT 0,
  stat_hubs INTEGER DEFAULT 0,
  always_open BOOLEAN DEFAULT false,
  business_hours JSONB,
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

CREATE POLICY "Public can read featured orders" ON orders
  FOR SELECT TO anon USING (featured_on_website = true);

CREATE POLICY "Public can read featured orders auth" ON orders
  FOR SELECT TO authenticated USING (featured_on_website = true);

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

-- ─── Company Information ────────────────────────────────────
CREATE POLICY "Allow public read access" ON company_information
  FOR SELECT USING (true);

CREATE POLICY "Allow admin full access" ON company_information
  FOR ALL USING (auth.role() = 'authenticated');

-- ─── Activity Logs ──────────────────────────────────────────
CREATE POLICY "Admins can view activity logs" ON activity_logs
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Authenticated users can insert activity logs" ON activity_logs
  FOR INSERT WITH CHECK (true);

-- ─── Coverage Regions ───────────────────────────────────────
CREATE POLICY "Allow public read access" ON coverage_regions
  FOR SELECT USING (true);

CREATE POLICY "Allow admin full access" ON coverage_regions
  FOR ALL USING (auth.role() = 'authenticated');

-- ─── Coverage Municipalities ────────────────────────────────
CREATE POLICY "Allow public read access" ON coverage_municipalities
  FOR SELECT USING (true);

CREATE POLICY "Allow admin full access" ON coverage_municipalities
  FOR ALL USING (auth.role() = 'authenticated');

-- ─── Customer Feedback ──────────────────────────────────────
CREATE POLICY "Admins can manage all feedback" ON customer_feedback
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Customers can insert own feedback" ON customer_feedback
  FOR INSERT WITH CHECK (auth.uid() = customer_id);

CREATE POLICY "Customers can read own feedback" ON customer_feedback
  FOR SELECT USING (auth.uid() = customer_id);

CREATE POLICY "Public can read non-hidden feedback" ON customer_feedback
  FOR SELECT USING (is_hidden = false);

CREATE POLICY "Public can read non-hidden feedback auth" ON customer_feedback
  FOR SELECT USING (is_hidden = false);

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
-- INDEXES (Performance)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_trip_id ON orders(trip_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders(tracking_number);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS idx_conversations_customer_id ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_created_at ON contact_inquiries(created_at);
CREATE INDEX IF NOT EXISTS idx_profiles_fcm_token ON profiles(fcm_token) WHERE fcm_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notification_id
  ON notification_delivery_attempts(notification_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_device_tokens_user_id ON user_device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_admin_id ON activity_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_module ON activity_logs(module);
CREATE INDEX IF NOT EXISTS idx_activity_logs_record_id ON activity_logs(record_id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_tx_ref ON payment_transactions(transaction_reference) WHERE transaction_reference IS NOT NULL;


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

DROP TRIGGER IF EXISTS payment_attempts_updated_at ON public.payment_attempts;
CREATE TRIGGER payment_attempts_updated_at BEFORE UPDATE ON public.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


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


-- ============================================================
-- CHAT ACTIVITY LOGGING
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_customer_chat_message()
RETURNS TRIGGER
LANGUAGE plpgsql
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
  v_payment_status TEXT;
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

  IF v_remaining <= 0 THEN
    v_payment_status := 'paid';
  ELSIF v_total_paid > 0 THEN
    v_payment_status := 'partial';
  ELSE
    v_payment_status := 'unpaid';
  END IF;

  UPDATE public.orders
  SET amount_paid = v_total_paid,
      remaining_balance = v_remaining,
      payment_status = v_payment_status
  WHERE id = v_order_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_update_totals_after_payment ON payment_transactions;
CREATE TRIGGER trigger_update_totals_after_payment
  AFTER INSERT OR UPDATE OR DELETE ON payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_order_payment_totals();


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
  order_row public.orders%ROWTYPE;
  paid_amount DECIMAL(10,2);
  total_cost DECIMAL(10,2);
  remaining DECIMAL(10,2);
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
       SET status = 'failed',
           payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status,
           last_error = 'Order no longer exists'
     WHERE source_id = p_source_id;

    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order no longer exists';
    RETURN;
  END IF;

  -- Block duplicate payment only if already FULLY paid with a DIFFERENT reference.
  -- Partial/unpaid orders are allowed to proceed with a new payment.
  IF order_row.payment_status = 'paid'
     AND order_row.payment_reference IS NOT NULL
     AND p_payment_id IS NOT NULL
     AND order_row.payment_reference <> p_payment_id THEN
    UPDATE public.payment_attempts
       SET status = 'failed',
           payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status,
           last_error = 'Order already fully paid with a different payment reference'
     WHERE source_id = p_source_id;

    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order already fully paid with a different payment reference';
    RETURN;
  END IF;

  -- Calculate remaining balance and payment status based on payment type
  total_cost := COALESCE(attempt_row.estimated_cost, order_row.shipping_cost, paid_amount);
  remaining := GREATEST(0, total_cost - paid_amount);

  IF attempt_row.payment_type = 'paylater' THEN
    -- Pay Later: this is a downpayment, there may be a remaining balance
    final_payment_status := CASE WHEN paid_amount > 0 THEN
      CASE WHEN remaining > 0 THEN 'partial' ELSE 'paid' END
    ELSE 'unpaid' END;
  ELSE
    -- Full Payment: trust the QR amount was the full amount
    final_payment_status := 'paid';
    remaining := 0;
  END IF;

  UPDATE public.orders
     SET payment_method = 'gcash',
         payer_type = COALESCE(attempt_row.payer_type, 'sender'),
         amount_paid = paid_amount,
         remaining_balance = remaining,
         payment_status = final_payment_status,
         payment_reference = COALESCE(p_payment_id, order_row.payment_reference),
         actual_weight = COALESCE(attempt_row.actual_weight, order_row.actual_weight),
         pickup_photos = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos),
         promised_payment_date = COALESCE(attempt_row.promised_payment_date, order_row.promised_payment_date),
         status = 'Picked Up'
   WHERE id = attempt_row.order_id;

  UPDATE public.payment_attempts
     SET status = 'reconciled',
         payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
         payment_status = final_payment_status,
         amount = paid_amount,
         last_error = NULL,
         reconciled_at = COALESCE(payment_attempts.reconciled_at, NOW())
   WHERE source_id = p_source_id;

  RETURN QUERY SELECT true, attempt_row.order_id, p_payment_id, 'Order reconciled';
END;
$$;

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

