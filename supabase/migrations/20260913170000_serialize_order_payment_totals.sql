-- Serialize every payment-summary recalculation at the order row.
--
-- Payment/refund rows are the authoritative ledger. The orders financial
-- fields are a derived cache maintained by triggers. Without an order-level
-- lock, two successful child-row operations for the same order can each
-- aggregate from a different snapshot and the last writer can leave the
-- derived cache behind the ledger. This migration changes only the
-- recalculation function; it does not rewrite any payment, refund, or order
-- data.

BEGIN;

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

  -- This is the common serialization point for payment and refund triggers.
  -- The aggregate SELECTs happen after the lock. Under READ COMMITTED, a
  -- concurrent waiter therefore takes its aggregate snapshot after the
  -- earlier recalculation commits and includes that transaction's child row.
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

COMMIT;
