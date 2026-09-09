-- ============================================================
-- BUG-02 follow-up: harden the existing payment-confirmation notification.
--
-- private.notify_payment_recorded() (added in 20260904235517, copy revised in
-- 20260905221303/20260905221305/20260905223244) already does most of what
-- BUG-02 asked for: it fires from a single AFTER INSERT trigger on the ledger
-- table itself (public.payment_transactions), skips non-paid/partial rows,
-- skips orders with no linked customer, and reads the order AFTER
-- trigger_update_totals_after_payment has recomputed remaining_balance
-- (triggers on the same table/event fire in alphabetical name order:
-- "payment_transactions_log_activity" < "trigger_update_totals_after_payment"
-- < "zz_payment_transactions_notify_customer" — verified against the live
-- database, not assumed).
--
-- Two gaps remained when re-verified against the current code for this task:
--
--   A. No duplicate-prevention constraint lives in the database itself. The
--      function relies entirely on the ledger never inserting more than one
--      payment_transactions row for one logical payment (true today, thanks
--      to the BUG-01 fix + the idempotency-key/manual-GCash-reference guards
--      in 20260909030000) — but nothing stops a FUTURE change (a second
--      trigger accidentally left registered on payment_transactions calling
--      this same function, or a new AFTER UPDATE variant) from inserting a
--      second notification for the exact same ledger row. The task asks for
--      this to be "tied to the unique recorded payment" and "enforced
--      atomically in the database", not merely implied by upstream ledger
--      hygiene. Fixed by a new payment_transaction_id column with a UNIQUE
--      index and an ON CONFLICT DO NOTHING on the insert.
--
--   B. The message never says HOW the customer paid. The task's business
--      rules distinguish three payment channels customers should be able to
--      tell apart (cash at pickup; a direct GCash transfer the admin
--      verified; GCash via PayMongo, verified automatically) and explicitly
--      asks for "customer-friendly payment method" in the notification body.
--      payment_transactions.payment_method/.gcash_channel (added in
--      20260909010000) already carry this; the trigger just never read them.
-- ============================================================

-- ── A. Tie notification identity to the specific recorded payment ─────────
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS payment_transaction_id UUID
    REFERENCES public.payment_transactions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.notifications.payment_transaction_id IS
  'Set only for type=payment_update. Ties the notification to the exact ledger row that caused it (not just the order), so a second insert for the same payment_transactions.id can never produce a second notification. NULL values never conflict with each other under a plain UNIQUE index, so every other notification type is unaffected.';

CREATE UNIQUE INDEX IF NOT EXISTS notifications_payment_transaction_key
  ON public.notifications (payment_transaction_id);

-- ── B. Rewrite the trigger function: add the dedup key + the payment method ─
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
  -- Defense in depth: every current insert path (reconcile_paymongo_payment_
  -- attempt, record_pickup_payment, record_delivery_payment,
  -- record_additional_payment) only ever writes 'paid' or 'partial'. A
  -- pending/failed/cancelled row (should one ever be written by a future
  -- change) must not notify.
  IF NEW.payment_status NOT IN ('paid', 'partial') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = NEW.order_id;

  -- Orders always have a NOT NULL user_id today, but this is cheap insurance
  -- against a future schema change (e.g. a walk-in/no-account order) — the
  -- task asks this be handled gracefully, not assumed impossible.
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

  -- Customer-friendly channel label. gcash_channel only exists on GCash rows
  -- (see 20260909010000); a manual direct transfer and an automatic PayMongo
  -- capture are deliberately worded differently, matching the two different
  -- trust levels already surfaced in the admin UI (PaymentCollectionPanel /
  -- AdditionalPaymentModal: "Process via PayMongo" vs "record a direct GCash
  -- transfer").
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
  -- Belt-and-suspenders: payment_transactions.id is a primary key, so this
  -- INSERT can only ever be attempted once per real payment under today's
  -- code. This guard is what makes that a guaranteed database invariant
  -- instead of an assumption about every future caller of this trigger.
  ON CONFLICT (payment_transaction_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- Server-owned; must never become an RPC surface a client can call directly.
REVOKE ALL ON FUNCTION private.notify_payment_recorded() FROM PUBLIC, anon, authenticated;

-- Re-declare the trigger so this migration is self-sufficient (safe to read
-- in isolation) even though the function replace above would already take
-- effect without it. Name and timing are unchanged: "zz_" keeps this trigger
-- sorting alphabetically last among payment_transactions' AFTER INSERT
-- triggers, so it still observes the ledger totals AFTER
-- trigger_update_totals_after_payment has recomputed them.
DROP TRIGGER IF EXISTS zz_payment_transactions_notify_customer ON public.payment_transactions;
CREATE TRIGGER zz_payment_transactions_notify_customer
AFTER INSERT ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION private.notify_payment_recorded();
