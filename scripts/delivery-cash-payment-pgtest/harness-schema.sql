-- Minimal harness schema for the delivery Cash-or-GCash fix. Same approach as
-- scripts/shipping-discount-pgtest and scripts/photo-gallery-pgtest: this
-- hand-builds only the parts record_delivery_payment() and
-- record_additional_payment() touch, then the REAL migration files
-- (20260912010000 for the baseline, then 20260915100000 for the actual fix
-- under test) are applied verbatim on top, so what's tested is byte-for-byte
-- the SQL that ships.

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
CREATE SCHEMA IF NOT EXISTS private;

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

-- ── order_payable_amount() — verbatim from 20260911020000 ──────────────────
CREATE OR REPLACE FUNCTION public.order_payable_amount(
  p_shipping_cost NUMERIC,
  p_discount_amount NUMERIC
)
RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
SET search_path = public
AS $$
  SELECT GREATEST(COALESCE(p_shipping_cost, 0) - COALESCE(p_discount_amount, 0), 0);
$$;

-- ── derive_payment_status() — verbatim from 20260805120000 ─────────────────
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

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  tracking_number VARCHAR(50) NOT NULL UNIQUE,
  receiver_name TEXT DEFAULT 'Receiver',
  actual_weight DECIMAL(10,2),
  shipping_cost DECIMAL(10,2) DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  discount_reason TEXT,
  discount_notes TEXT,
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
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  payment_method TEXT NOT NULL,
  transaction_reference TEXT,
  transaction_reference_normalized TEXT,
  gcash_channel TEXT CHECK (gcash_channel IS NULL OR gcash_channel = ANY (ARRAY['paymongo','manual'])),
  idempotency_key UUID,
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
CREATE UNIQUE INDEX uq_payment_transactions_idempotency_key ON public.payment_transactions USING btree (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_payment_transactions_manual_gcash_ref ON public.payment_transactions USING btree (transaction_reference_normalized) WHERE gcash_channel = 'manual' AND transaction_reference_normalized IS NOT NULL;

-- Minimal payment_refunds stand-in — the current update_order_payment_totals
-- (20260913170000) sums succeeded refunds against it. No test here exercises
-- a refund, so it stays permanently empty, but the trigger's SELECT needs the
-- table and its two columns to exist.
CREATE TABLE payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- ── guard_manual_gcash_payment() — verbatim from 20260909030000 ────────────
CREATE OR REPLACE FUNCTION public.guard_manual_gcash_payment(p_reference text, p_admin_verified_receipt boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ref_norm TEXT;
  v_dupe     RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF NOT COALESCE(p_admin_verified_receipt, false) THEN
    RAISE EXCEPTION 'Confirm that you have verified receipt of this GCash transfer before recording it.'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(trim(p_reference), '') = '' THEN
    RAISE EXCEPTION 'A GCash transfer reference number is required.'
      USING ERRCODE = '22023';
  END IF;

  v_ref_norm := upper(regexp_replace(trim(p_reference), '[\s-]+', '', 'g'));

  SELECT pt.order_id, o.tracking_number, pt.amount, pt.created_at
    INTO v_dupe
    FROM public.payment_transactions pt
    JOIN public.orders o ON o.id = pt.order_id
   WHERE pt.gcash_channel = 'manual'
     AND pt.transaction_reference_normalized = v_ref_norm
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'This GCash reference was already recorded against order % (₱% on %). It cannot be credited again.',
      v_dupe.tracking_number, TO_CHAR(v_dupe.amount, 'FM999999990.00'), v_dupe.created_at::date
      USING ERRCODE = '23505';
  END IF;

  RETURN v_ref_norm;
END;
$function$;

-- ── update_order_payment_totals() — verbatim from 20260913170000 ───────────
-- (discount-aware + serialized via FOR UPDATE on the order row).
CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_gross_paid      NUMERIC(10,2);
  v_refunded        NUMERIC(10,2);
  v_total_paid      NUMERIC(10,2);
  v_shipping_cost   NUMERIC(10,2);
  v_discount_amount NUMERIC(10,2);
  v_payable         NUMERIC(10,2);
  v_remaining       NUMERIC(10,2);
  v_order_id        UUID;
BEGIN
  v_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;

  SELECT shipping_cost, discount_amount
    INTO v_shipping_cost, v_discount_amount
    FROM public.orders
   WHERE id = v_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_gross_paid
    FROM public.payment_transactions
   WHERE order_id = v_order_id
     AND payment_status IN ('paid', 'partial');

  SELECT COALESCE(SUM(amount), 0)
    INTO v_refunded
    FROM public.payment_refunds
   WHERE order_id = v_order_id
     AND status = 'succeeded';

  v_total_paid := GREATEST(v_gross_paid - v_refunded, 0);
  v_payable := public.order_payable_amount(v_shipping_cost, v_discount_amount);
  v_remaining := GREATEST(0, v_payable - v_total_paid);

  UPDATE public.orders
     SET amount_paid = v_total_paid,
         remaining_balance = v_remaining,
         payment_status = public.derive_payment_status(v_payable, v_total_paid)
   WHERE id = v_order_id;

  RETURN NULL;
END;
$function$;

CREATE TRIGGER trigger_update_totals_after_payment
AFTER INSERT OR UPDATE OR DELETE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION public.update_order_payment_totals();

-- ── Payment-confirmation notification — verbatim from 20260909120000 ──────
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL,
  reference_id UUID,
  payment_transaction_id UUID REFERENCES public.payment_transactions(id) ON DELETE SET NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notifications_payment_transaction_key
  ON public.notifications (payment_transaction_id);

CREATE OR REPLACE FUNCTION private.notify_payment_recorded()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_amount_text TEXT;
  v_balance_text TEXT;
  v_method_label TEXT;
BEGIN
  IF NEW.payment_status NOT IN ('paid', 'partial') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = NEW.order_id;

  IF NOT FOUND OR v_order.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_amount_text := chr(8369) || to_char(
    GREATEST(COALESCE(NEW.amount, 0), 0),
    'FM999,999,999,990.00'
  );
  v_balance_text := chr(8369) || to_char(
    GREATEST(COALESCE(v_order.remaining_balance, 0), 0),
    'FM999,999,999,990.00'
  );

  v_method_label := CASE
    WHEN NEW.payment_method = 'gcash' AND NEW.gcash_channel = 'manual' THEN 'GCash transfer'
    WHEN NEW.payment_method = 'gcash' THEN 'GCash'
    WHEN NEW.payment_method = 'cash' THEN 'cash'
    ELSE COALESCE(NEW.payment_method, 'payment')
  END;

  INSERT INTO public.notifications (
    user_id, title, message, type, reference_id, payment_transaction_id
  )
  VALUES (
    v_order.user_id,
    CASE
      WHEN COALESCE(v_order.remaining_balance, 0) <= 0 THEN 'Payment Complete'
      ELSE 'Payment Received'
    END,
    CASE
      WHEN COALESCE(v_order.remaining_balance, 0) <= 0 THEN format(
        'We recorded your %s %s payment for order %s. Your order is now fully paid.',
        v_amount_text,
        v_method_label,
        v_order.tracking_number
      )
      ELSE format(
        'We recorded your %s %s payment for order %s. Remaining balance: %s.',
        v_amount_text,
        v_method_label,
        v_order.tracking_number,
        v_balance_text
      )
    END,
    'payment_update',
    v_order.id,
    NEW.id
  )
  ON CONFLICT (payment_transaction_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER zz_payment_transactions_notify_customer
AFTER INSERT ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION private.notify_payment_recorded();
