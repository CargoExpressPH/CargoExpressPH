-- ============================================================
-- Manual payment hardening (part 3 of 3).
--
-- Fixes four separate gaps found while implementing the BUG-01 fix, none of
-- which were caused by the PayMongo race itself but which the task's
-- business rules and failure-mode list both call out directly:
--
--   A. record_pickup_payment() / record_delivery_payment() had no
--      idempotency protection for a plain double-click or a dropped
--      response after the database already committed — their only guard was
--      ON CONFLICT (transaction_reference), which does nothing for a cash
--      payment (transaction_reference is NULL). Both now accept an optional
--      p_idempotency_key: a stable id the client generates once per
--      collection attempt and resends unchanged on retry.
--
--   B. record_delivery_payment() accepted 'cash' with no restriction, even
--      though the business rule is explicit: after pickup, the admin will
--      not return to the pickup location to collect cash, so a remaining
--      balance may only be settled via GCash. Delivery-time settlement is
--      "after pickup" by construction, so cash is now rejected server-side
--      there. record_pickup_payment is unchanged in this respect — cash at
--      the moment of pickup is exactly what the business rule allows.
--
--   C. Neither function required the admin to attest that a manually-entered
--      GCash reference was actually verified as received, nor did anything
--      stop the same transfer reference from being credited twice —
--      including against a different order. Both are now enforced through
--      guard_manual_gcash_payment(), backed by the unique index added in
--      20260909010000.
--
--   D. The "Record Additional Payment" flow (recordAdditionalPayment() in
--      src/lib/database.js) never went through a SECURITY DEFINER RPC at
--      all — it read the order with a plain SELECT (no row lock) and then
--      INSERTed into payment_transactions directly from the browser, using
--      only RLS ("admin role") as a gate. That is the exact "SELECT then
--      INSERT" pattern the task calls out as insufficient on its own: no
--      atomic order lock, no idempotency key, no cash-after-pickup rule, no
--      manual-GCash verification or duplicate check. record_additional_payment()
--      replaces it with the same locked, idempotent, rule-enforcing pattern
--      as the other two functions, and the RLS policy below removes the
--      admin INSERT path so this RPC is the only way in.
-- ============================================================

-- ── Shared guard for a manually-entered ("direct transfer") GCash reference ──
-- Used by all three payment-recording RPCs below. Requires:
--   * the caller is an admin (defense in depth — every caller already checks
--     this itself before reaching here);
--   * the admin has ticked "I verified this transfer was received" — a
--     reference string is never, by itself, proof money changed hands;
--   * a non-blank reference;
--   * the normalized reference (uppercased, whitespace/dash-stripped —
--     leading zeros and all other characters preserved) is not already on
--     file against ANY order, since this business has one receiving GCash
--     account and the same transfer cannot legitimately fund two orders.
-- Returns the normalized reference for storage; raises on any failure.
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

REVOKE ALL ON FUNCTION public.guard_manual_gcash_payment(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_manual_gcash_payment(text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.guard_manual_gcash_payment(text, boolean) TO authenticated, service_role;


-- ── record_pickup_payment(): idempotency key + manual-GCash verification ────
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

  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Retry of the SAME collection (double-click, or the response was lost
  -- after this already committed): return the current order untouched. Safe
  -- to check unconditionally — the order row lock above serializes any two
  -- calls for this order, so the second call always observes the first
  -- call's commit before deciding this.
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.payment_transactions WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN v_order;
  END IF;

  IF COALESCE(p_actual_weight, 0) <= 0 THEN
    RAISE EXCEPTION 'Actual weight must be greater than zero';
  END IF;

  -- A manually-entered GCash reference at pickup (the PayMongo QR path never
  -- reaches this function with money attached — the webhook records that).
  IF COALESCE(p_amount, 0) > 0 AND v_method = 'gcash' AND COALESCE(trim(p_reference), '') <> '' THEN
    v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);
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
      -- The manual-GCash-reference race: guard_manual_gcash_payment's check
      -- above is a pre-check, not the atomic guard — this is. Two admins
      -- entering the same reference for two different orders at almost the
      -- same instant both pass the pre-check; the uq_payment_transactions_
      -- manual_gcash_ref partial unique index lets only one INSERT commit.
      RAISE EXCEPTION 'This GCash reference was already recorded on another order. It cannot be credited again.'
        USING ERRCODE = '23505';
    END;
  END IF;

  -- Re-read AFTER the ledger trigger has recomputed the totals.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_pickup_payment(uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_pickup_payment(uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_pickup_payment(uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean) TO service_role, authenticated;


-- ── record_delivery_payment(): idempotency key + cash-after-pickup block ────
-- + manual-GCash verification.
CREATE OR REPLACE FUNCTION public.record_delivery_payment(
  p_order_id uuid,
  p_delivery_photos jsonb DEFAULT '[]'::jsonb,
  p_payment_method text DEFAULT NULL::text,
  p_amount numeric DEFAULT NULL::numeric,
  p_reference text DEFAULT NULL::text,
  p_payment_date date DEFAULT NULL::date,
  p_receipt_url text DEFAULT NULL::text,
  p_payment_type text DEFAULT 'Balance Settlement'::text,
  p_notes text DEFAULT 'Balance settlement upon delivery'::text,
  p_promised_payment_date date DEFAULT NULL::date,
  p_idempotency_key uuid DEFAULT NULL::uuid,
  p_admin_verified_receipt boolean DEFAULT false
)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order                  public.orders;
  v_admin_name             TEXT;
  v_paid_after             NUMERIC;
  v_label                  TEXT;
  v_total_paid_projected   NUMERIC;
  v_remaining_projected    NUMERIC;
  v_effective_promise_date DATE;
  v_ref_norm               TEXT;
  v_method                 TEXT := lower(COALESCE(p_payment_method, ''));
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

  -- Business rule: after pickup, a remaining balance is GCash-only — the
  -- admin will not return to the pickup location to collect cash. Delivery
  -- settlement is always "after pickup" by construction, so this is an
  -- unconditional rejection rather than a status lookup.
  IF COALESCE(p_amount, 0) > 0 AND v_method = 'cash' THEN
    RAISE EXCEPTION 'Cash is no longer accepted once an order has been picked up. Collect the remaining balance via GCash.'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_amount, 0) > 0 AND v_method = 'gcash' AND COALESCE(trim(p_reference), '') <> '' THEN
    v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);
  END IF;

  -- ── Promise-date guard ──────────────────────────────────────────────────
  -- Sum the ledger as it stands, add the payment about to be recorded (never
  -- negative — a malformed p_amount must not reduce the projected total),
  -- and compare against shipping_cost exactly like update_order_payment_totals
  -- will a moment from now.
  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_paid_projected
    FROM public.payment_transactions
   WHERE order_id = p_order_id
     AND payment_status IN ('paid', 'partial');

  v_total_paid_projected := v_total_paid_projected + GREATEST(COALESCE(p_amount, 0), 0);
  v_remaining_projected  := GREATEST(0, COALESCE(v_order.shipping_cost, 0) - v_total_paid_projected);
  -- A date given in THIS call counts, same as one already on file — either
  -- is enough to satisfy the rule, matching needsPromiseDate's own check.
  v_effective_promise_date := COALESCE(p_promised_payment_date, v_order.promised_payment_date);

  IF v_remaining_projected > 0.005 AND v_effective_promise_date IS NULL THEN
    RAISE EXCEPTION
      'Cannot mark order % as delivered with ₱% still owing and no promise date on record. Record a Promise Date or collect the balance first.',
      v_order.tracking_number,
      TO_CHAR(v_remaining_projected, 'FM999999990.00');
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

    BEGIN
      INSERT INTO public.payment_transactions (
        order_id, amount, payment_method, payment_status,
        transaction_reference, transaction_reference_normalized, gcash_channel,
        admin_id, admin_name, notes, payment_type, payment_date, receipt_url,
        idempotency_key
      ) VALUES (
        p_order_id, p_amount, COALESCE(p_payment_method, 'gcash'), v_label,
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

REVOKE ALL ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_delivery_payment(uuid, jsonb, text, numeric, text, date, text, text, text, date, uuid, boolean) TO service_role, authenticated;


-- ── record_additional_payment(): replaces the raw client-side INSERT ────────
-- Previously src/lib/database.js's recordAdditionalPayment() did a plain
-- `SELECT` (no row lock) followed by a plain `.insert()` into
-- payment_transactions under RLS alone — the "SELECT then INSERT" pattern
-- called out as insufficient. This RPC gives the "Record Additional Payment"
-- / balance-settlement flow (OrderDetailPage, UnsettledDeliveriesPage) the
-- same locked, idempotent, rule-enforcing pattern as pickup and delivery.
--
-- This is always a POST-pickup collection (remaining_balance is only ever
-- non-zero after pickup sets shipping_cost — see BookShipmentPage/
-- prepare_order_insert), so cash is rejected unconditionally, matching
-- record_delivery_payment.
CREATE OR REPLACE FUNCTION public.record_additional_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_payment_date date DEFAULT NULL::date,
  p_receipt_url text DEFAULT NULL::text,
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
  v_type       TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
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

  IF v_method = 'cash' THEN
    RAISE EXCEPTION 'Cash is no longer accepted once an order has been picked up. Collect the remaining balance via GCash.'
      USING ERRCODE = '22023';
  END IF;

  IF v_method <> 'gcash' THEN
    RAISE EXCEPTION 'Unsupported payment method: %', p_payment_method;
  END IF;

  v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);

  SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

  SELECT COALESCE(SUM(amount), 0) + p_amount
    INTO v_paid_after
    FROM public.payment_transactions
   WHERE order_id = p_order_id
     AND payment_status IN ('paid', 'partial');

  v_label := CASE WHEN v_paid_after >= COALESCE(v_order.shipping_cost, 0) THEN 'paid' ELSE 'partial' END;
  v_type  := CASE
               WHEN v_label = 'paid' AND COALESCE(v_order.remaining_balance, 0) > 0 THEN 'Balance Settlement'
               ELSE 'Additional Payment'
             END;

  BEGIN
    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, transaction_reference_normalized, gcash_channel,
      admin_id, admin_name, notes, payment_type, payment_date, receipt_url,
      idempotency_key
    ) VALUES (
      p_order_id, p_amount, 'gcash', v_label,
      p_reference, v_ref_norm, 'manual',
      auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
      v_type, p_payment_date, p_receipt_url, p_idempotency_key
    )
    ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL
    DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This GCash reference was already recorded on another order. It cannot be credited again.'
      USING ERRCODE = '23505';
  END;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_additional_payment(uuid, numeric, text, text, text, date, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_additional_payment(uuid, numeric, text, text, text, date, text, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_additional_payment(uuid, numeric, text, text, text, date, text, uuid, boolean) TO service_role, authenticated;


-- ── clear_payment_receipt_url(): the one other direct admin write ──────────
-- src/lib/database.js's clearPaymentReceiptUrls() used a plain
-- `.update({ receipt_url: null })` under the same broad RLS policy being
-- narrowed below. It only ever clears a photo reference (no money, no
-- status), but with the INSERT/UPDATE policy removed it needs its own
-- narrow RPC to keep working.
CREATE OR REPLACE FUNCTION public.clear_payment_receipt_url(p_order_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.payment_transactions
     SET receipt_url = NULL
   WHERE order_id = p_order_id
     AND public.is_admin();
$function$;

REVOKE ALL ON FUNCTION public.clear_payment_receipt_url(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_payment_receipt_url(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.clear_payment_receipt_url(uuid) TO service_role, authenticated;


-- ── RLS: remove the direct admin write path now that every legitimate ──────
-- write goes through a SECURITY DEFINER RPC (which, as the table owner,
-- bypasses RLS the same way it already did for the pickup/delivery/webhook
-- inserts that predate this migration). Customers keep their existing
-- SELECT-only policy untouched.
DROP POLICY IF EXISTS "Admins can insert and select payment transactions" ON public.payment_transactions;
CREATE POLICY "Admins can view payment transactions" ON public.payment_transactions
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));
