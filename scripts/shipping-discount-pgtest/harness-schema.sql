-- Minimal harness schema for the shipping-discount feature — enough of the
-- real CargoExpressPH schema, AS IT STOOD BEFORE THIS FEATURE, for
-- record_pickup_payment / guard_order_update / update_order_payment_totals /
-- reconcile_paymongo_payment_attempt to run unmodified. The REAL new
-- migration files (20260911010000 .. 20260911040000) are applied verbatim on
-- top by run.mjs, so what is tested is byte-for-byte what ships — including
-- the "before" behaviour, which several scenarios diff against.

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

-- ── Pricing infrastructure (trips + global rate) ────────────────────────────
CREATE TABLE global_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT
);
INSERT INTO global_settings (setting_key, setting_value) VALUES ('price_per_kilo', '70');

CREATE OR REPLACE FUNCTION public.global_price_per_kilo()
 RETURNS numeric
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT setting_value::NUMERIC FROM public.global_settings WHERE setting_key = 'price_per_kilo' LIMIT 1),
    70
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

CREATE OR REPLACE FUNCTION public.effective_trip_price(p_trip_id UUID)
 RETURNS numeric
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT NULLIF(price_per_kg, 0) FROM public.trips WHERE id = p_trip_id),
    public.global_price_per_kilo()
  );
$function$;

CREATE OR REPLACE FUNCTION public.generate_order_tracking_number()
 RETURNS text
 LANGUAGE sql
AS $function$ SELECT 'CE-TEST-' || substr(gen_random_uuid()::text, 1, 8) $function$;

-- ── orders — the schema exactly as it stood before this feature ────────────
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  trip_id UUID REFERENCES trips(id),
  origin TEXT,
  destination TEXT,
  tracking_number VARCHAR(50) NOT NULL UNIQUE,
  sender_name TEXT DEFAULT 'Sender',
  receiver_name TEXT DEFAULT 'Receiver',
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

-- ── prepare_order_insert() — verbatim from 20260909094000 (pre-discount) ───
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
  NEW.tracking_number := COALESCE(NEW.tracking_number, public.generate_order_tracking_number());
  NEW.actual_weight := NULL;
  NEW.payment_method := NULL;
  NEW.payment_status := 'unpaid';
  NEW.amount_paid := 0;
  NEW.promised_payment_date := NULL;
  NEW.payment_reference := NULL;
  NEW.pickup_photos := '[]'::jsonb;
  NEW.delivery_photos := '[]'::jsonb;
  NEW.cancellation_details := NULL;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    NEW.status := 'Assigned';
    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
  ELSE
    NEW.status := COALESCE(NEW.status, 'Pending');
  END IF;

  NEW.shipping_cost := 0;
  NEW.remaining_balance := 0;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER orders_prepare_insert
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION public.prepare_order_insert();

-- ── guard_order_update() — verbatim from 20260909094000 (pre-discount) ─────
CREATE OR REPLACE FUNCTION public.guard_order_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row      public.trips%ROWTYPE;
  weight        NUMERIC;
  price         NUMERIC;
  v_current_load NUMERIC;
  v_capacity_allowance CONSTANT NUMERIC := 200;
BEGIN
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
    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;

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
    NEW.payment_status := public.derive_payment_status(NEW.shipping_cost, NEW.amount_paid);
  END IF;

  IF NEW.status = 'Out for Delivery' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF COALESCE(NEW.actual_weight, 0) <= 0 THEN
      RAISE EXCEPTION
        'Cannot dispatch order % — it has not been weighed, so it has no price yet. Record the actual weight first.',
        NEW.tracking_number;
    END IF;
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
$function$;

CREATE TRIGGER orders_guard_update
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_update();

-- ── update_order_payment_totals() — verbatim from 20260805120000 (pre-discount) ──
CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

CREATE TRIGGER trigger_update_totals_after_payment
AFTER INSERT OR UPDATE OR DELETE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION public.update_order_payment_totals();

-- ── Payment-confirmation notification — verbatim from 20260909120000 ──────
-- Included so the discount tests can prove a discount-only action creates NO
-- notification (the trigger only ever fires on payment_transactions INSERT,
-- which a discount never causes) and that a real payment's notification
-- reports the DISCOUNTED remaining_balance.
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  title TEXT,
  message TEXT,
  type TEXT,
  reference_id UUID,
  payment_transaction_id UUID REFERENCES payment_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_payment_transaction_key ON public.notifications (payment_transaction_id);

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

  SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_amount_text := chr(8369) || to_char(GREATEST(COALESCE(NEW.amount, 0), 0), 'FM999,999,999,990.00');
  v_balance_text := chr(8369) || to_char(GREATEST(COALESCE(v_order.remaining_balance, 0), 0), 'FM999,999,999,990.00');
  v_method_label := CASE
    WHEN NEW.payment_method = 'gcash' AND NEW.gcash_channel = 'manual' THEN 'GCash transfer'
    WHEN NEW.payment_method = 'gcash' THEN 'GCash'
    WHEN NEW.payment_method = 'cash' THEN 'cash'
    ELSE COALESCE(NEW.payment_method, 'payment')
  END;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id, payment_transaction_id)
  VALUES (
    v_order.user_id,
    CASE WHEN COALESCE(v_order.remaining_balance, 0) <= 0 THEN 'Payment Complete' ELSE 'Payment Received' END,
    CASE
      WHEN COALESCE(v_order.remaining_balance, 0) <= 0 THEN format('We recorded your %s %s payment for order %s. Your order is now fully paid.', v_amount_text, v_method_label, v_order.tracking_number)
      ELSE format('We recorded your %s %s payment for order %s. Remaining balance: %s.', v_amount_text, v_method_label, v_order.tracking_number, v_balance_text)
    END,
    'payment_update', v_order.id, NEW.id
  )
  ON CONFLICT (payment_transaction_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER zz_payment_transactions_notify_customer
AFTER INSERT ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION private.notify_payment_recorded();

-- ── record_pickup_payment() — verbatim 14-param version from 20260909030000 ──
CREATE OR REPLACE FUNCTION public.record_pickup_payment(
  p_order_id uuid,
  p_actual_weight numeric,
  p_payment_method text,
  p_payer_type text DEFAULT 'sender'::text,
  p_pickup_photos jsonb DEFAULT '[]'::jsonb,
  p_promised_payment_date date DEFAULT NULL::date,
  p_amount numeric DEFAULT NULL::numeric,
  p_reference text DEFAULT NULL::text,
  p_payment_date date DEFAULT NULL::date,
  p_receipt_url text DEFAULT NULL::text,
  p_payment_type text DEFAULT 'Initial Payment'::text,
  p_notes text DEFAULT 'Initial pickup payment'::text,
  p_idempotency_key uuid DEFAULT NULL::uuid,
  p_admin_verified_receipt boolean DEFAULT false
)
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
  v_ref_norm   TEXT;
  v_method     TEXT := lower(COALESCE(p_payment_method, ''));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.payment_transactions WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN v_order;
  END IF;

  IF COALESCE(p_actual_weight, 0) <= 0 THEN
    RAISE EXCEPTION 'Actual weight must be greater than zero';
  END IF;

  IF COALESCE(p_amount, 0) > 0 AND v_method = 'gcash' THEN
    v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);
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

    BEGIN
      INSERT INTO public.payment_transactions (
        order_id, amount, payment_method, payment_status,
        transaction_reference, transaction_reference_normalized, gcash_channel,
        admin_id, admin_name, notes, payment_type, payment_date, receipt_url,
        idempotency_key
      ) VALUES (
        p_order_id, p_amount, p_payment_method, v_label,
        p_reference, v_ref_norm, CASE WHEN v_ref_norm IS NOT NULL THEN 'manual' END,
        auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
        p_payment_type, p_payment_date, p_receipt_url, p_idempotency_key
      )
      ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
      DO NOTHING;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'This GCash reference was already recorded on another order. It cannot be credited again.'
        USING ERRCODE = '23505';
    END;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$;

-- ── reconcile_paymongo_payment_attempt() — verbatim from 20260909020000 ────
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
  IF p_payment_id IS NOT NULL AND p_payment_id ~ '^auto_' THEN
    RAISE EXCEPTION 'Synthetic payment references are not allowed; a verified PayMongo payment id is required to reconcile a payment.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt_row FROM public.payment_attempts WHERE source_id = p_source_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, p_payment_id, 'No payment attempt found for source';
    RETURN;
  END IF;

  IF attempt_row.status = 'reconciled' THEN
    RETURN QUERY SELECT true, attempt_row.order_id, attempt_row.payment_id, 'Already reconciled (no-op)';
    RETURN;
  END IF;

  IF p_payment_id IS NULL THEN
    RETURN QUERY SELECT false, attempt_row.order_id, NULL::TEXT, 'No verified payment id supplied; nothing recorded';
    RETURN;
  END IF;

  paid_amount := COALESCE(NULLIF(p_payment_amount, 0), attempt_row.amount);

  SELECT * INTO order_row FROM public.orders WHERE id = attempt_row.order_id FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.payment_attempts
       SET status = 'failed', payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
           payment_status = p_payment_status, last_error = 'Order no longer exists'
     WHERE source_id = p_source_id;
    RETURN QUERY SELECT false, attempt_row.order_id, p_payment_id, 'Order no longer exists';
    RETURN;
  END IF;

  IF attempt_row.payment_type = 'paylater' THEN
    final_payment_status := 'partial';
  ELSE
    final_payment_status := 'paid';
  END IF;

  IF p_payment_id IS NOT NULL THEN
    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, gcash_channel, admin_name, notes
    ) VALUES (
      attempt_row.order_id, paid_amount, 'gcash', final_payment_status,
      p_payment_id, 'paymongo', 'System Webhook', 'Captured via PayMongo Webhook'
    )
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;

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
     SET status = 'reconciled', payment_id = COALESCE(p_payment_id, payment_attempts.payment_id),
         payment_status = final_payment_status, amount = paid_amount, last_error = NULL,
         reconciled_at = COALESCE(payment_attempts.reconciled_at, NOW())
   WHERE source_id = p_source_id;

  RETURN QUERY SELECT true, attempt_row.order_id, p_payment_id, 'Order reconciled via payment_transactions insert';
END;
$function$;

-- ── get_sales_summary() — verbatim from 20260806040000 (pre-discount) ──────
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
    SELECT
      o.*,
      GREATEST(COALESCE(o.shipping_cost, 0) - COALESCE(o.amount_paid, 0), 0) AS outstanding,
      (COALESCE(o.actual_weight, 0) > 0) AS is_priced,
      (o.status IN ('Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered')) AS is_tracked
    FROM public.orders o
    WHERE o.status <> 'Cancelled'
  ),
  order_rollup AS (
    SELECT
      COALESCE(SUM(shipping_cost), 0) AS total_revenue,
      COALESCE(SUM(amount_paid), 0)   AS paid_total,
      COALESCE(SUM(outstanding) FILTER (WHERE is_tracked), 0) AS outstanding_tracked,
      COUNT(*) FILTER (WHERE is_tracked AND outstanding > 0.005)    AS unpaid_count,
      COUNT(*) FILTER (WHERE NOT is_priced)                         AS unpriced_count
    FROM active_orders
  )
  SELECT jsonb_build_object(
    'totalRevenue',     o.total_revenue,
    'paidTotal',        o.paid_total,
    'outstandingTotal', o.outstanding_tracked,
    'unpaidCount',      o.unpaid_count,
    'unpricedCount',    o.unpriced_count
  )
  INTO payload
  FROM order_rollup o;

  RETURN jsonb_build_object('summary', payload, 'monthlySales', '[]'::jsonb, 'unpaidOrders', '[]'::jsonb);
END;
$$;
