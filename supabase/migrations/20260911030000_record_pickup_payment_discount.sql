-- ============================================================
-- Admin-only shipping discount — record_pickup_payment() (part 3 of 3)
--
-- The ONLY sanctioned way to set a discount: three new trailing parameters
-- (p_discount_amount, p_discount_reason, p_discount_notes), passed into the
-- SAME single UPDATE statement that already sets actual_weight/status in one
-- transaction with the ledger insert — so a failure anywhere in this function
-- (bad weight, a rejected discount, a duplicate GCash reference) leaves
-- NEITHER the price nor the payment partially saved. The actual validation
-- (nonnegative, ≤ original fee, reason required, "Other" needs notes, admin
-- only, pre-pickup only, no existing payment) lives in guard_order_update()
-- from 20260911020000 — ONE place, so this RPC and any other write path to
-- `orders` are held to the identical rule instead of two copies drifting.
--
-- This also adds the "already picked up" guard this function itself was
-- missing: previously nothing stopped record_pickup_payment() from being
-- called a second time on an order already in 'Picked Up' or later (only the
-- UI hid the button). That gap is exactly what "discount read-only after
-- pickup" needs closed at the RPC layer, not only inside guard_order_update
-- (which only reacts when discount_amount itself changes) — a second pickup
-- call that happens to resend the SAME discount must be refused too, because
-- it is not a legitimate action once pickup is confirmed.
--
-- ── SIGNATURE NOTE ──────────────────────────────────────────────────────────
-- record_pickup_payment already exists as two prior overloads — a 12-param
-- version (20260803100000) and the current 14-param version
-- (20260909030000) — because each of those migrations used CREATE OR REPLACE
-- while ADDING trailing parameters, which Postgres treats as a distinct
-- function rather than a true replacement (the argument list changed). Both
-- older overloads are harmless orphans: src/lib/database.js's
-- recordPickupPayment() always sends every named parameter the CURRENT
-- version defines, and neither older overload has p_discount_amount /
-- p_discount_reason / p_discount_notes / (for the 12-param one)
-- p_idempotency_key / p_admin_verified_receipt as valid names, so PostgREST
-- can only resolve such a call to this one. This migration follows the same
-- established pattern (CREATE OR REPLACE with new trailing params) rather
-- than risk an exact-signature DROP FUNCTION typo against a function this
-- large; cleaning up the two orphaned overloads is a separate, unrelated
-- piece of debt, noted in the implementation report rather than touched here.
-- ============================================================

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
  p_admin_verified_receipt boolean DEFAULT false,
  -- ── Shipping discount (new) ──────────────────────────────────────────────
  -- p_discount_amount = 0 (the default, and what the client sends whenever
  -- the "Apply discount" toggle is OFF) means "effective discount is zero" —
  -- guard_order_update then requires discount_reason/notes to be NULL too.
  p_discount_amount numeric DEFAULT 0,
  p_discount_reason text DEFAULT NULL::text,
  p_discount_notes text DEFAULT NULL::text
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

  -- Pickup is a one-time confirmation. Once it has happened, calling this
  -- again — whether to "revise" the discount, resend the same one, or
  -- anything else — is refused here, server-side, not only by the UI hiding
  -- the button. This is what makes the discount (and the pickup weight,
  -- payment method, and photos) genuinely read-only afterward.
  IF v_order.status NOT IN ('Pending Review', 'Pending', 'Assigned') THEN
    RAISE EXCEPTION 'This order has already been picked up (status: %). Pickup, and any discount applied with it, can no longer be changed.', v_order.status;
  END IF;

  IF COALESCE(p_actual_weight, 0) <= 0 THEN
    RAISE EXCEPTION 'Actual weight must be greater than zero';
  END IF;

  -- Any GCash money reaching this function is, by construction, a manual
  -- direct-transfer entry: the PayMongo QR path never sends an amount here
  -- at all — it returns early with payment: null (see buildPaymentSubmission
  -- in PaymentCollectionPanel.jsx) because the webhook already recorded that
  -- money via reconcile_paymongo_payment_attempt(). So this is unconditional
  -- on amount + method, NOT gated on a reference already being present —
  -- otherwise a blank reference would skip verification entirely instead of
  -- being refused by guard_manual_gcash_payment's own check.
  IF COALESCE(p_amount, 0) > 0 AND v_method = 'gcash' THEN
    v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);
  END IF;

  -- Step 1 — order metadata ONLY, including the discount.
  -- amount_paid / remaining_balance / payment_status are deliberately absent:
  -- the ledger trigger owns them. shipping_cost is deliberately absent too —
  -- guard_order_update recomputes it from actual_weight in this SAME
  -- statement (actual_weight and discount_amount both change here), and also
  -- validates discount_amount against that freshly computed shipping_cost —
  -- see 20260911020000. Rejecting an invalid discount therefore rejects this
  -- entire UPDATE, so nothing below it (the ledger insert) ever runs.
  UPDATE public.orders
     SET actual_weight         = p_actual_weight,
         payment_method        = p_payment_method,
         payer_type            = COALESCE(p_payer_type, payer_type, 'sender'),
         pickup_photos         = COALESCE(p_pickup_photos, pickup_photos),
         promised_payment_date = p_promised_payment_date,
         payment_reference     = COALESCE(p_reference, payment_reference),
         status                = 'Picked Up',
         discount_amount       = ROUND(COALESCE(p_discount_amount, 0), 2),
         discount_reason       = p_discount_reason,
         discount_notes        = p_discount_notes
   WHERE id = p_order_id;

  -- Step 2 — the ledger, only when money actually changed hands. A discount
  -- is NEVER a payment: this block is driven entirely by p_amount, which the
  -- client leaves null/0 for a discount-only or fully-discounted (₱0 payable)
  -- pickup. No payment_transactions row and no payment notification are ever
  -- produced by the discount itself — only by real money in p_amount.
  IF COALESCE(p_amount, 0) > 0 THEN
    SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

    SELECT COALESCE(SUM(amount), 0) + p_amount
      INTO v_paid_after
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial');

    -- Per-transaction label. Must be 'paid' or 'partial' — those are the only
    -- two values update_order_payment_totals counts toward amount_paid.
    -- Compared against the DISCOUNTED payable amount, so a payment that
    -- fully covers a discounted fee is labelled 'paid', not 'partial'.
    SELECT CASE
             WHEN v_paid_after >= public.order_payable_amount(shipping_cost, discount_amount) THEN 'paid'
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

REVOKE ALL ON FUNCTION public.record_pickup_payment(uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_pickup_payment(uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean, numeric, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_pickup_payment(uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean, numeric, text, text) TO service_role, authenticated;
