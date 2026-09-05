-- Make successful payment notifications customer-facing and self-contained.
-- The transaction amount comes from the immutable ledger row, while the
-- remaining balance is read after trigger_update_totals_after_payment runs.
-- PostgreSQL executes same-event triggers by name, and the existing
-- zz_payment_transactions_notify_customer trigger deliberately runs last.

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

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  VALUES (
    v_order.user_id,
    CASE
      WHEN COALESCE(v_order.remaining_balance, 0) <= 0 THEN 'Payment Complete'
      ELSE 'Payment Received'
    END,
    CASE
      WHEN COALESCE(v_order.remaining_balance, 0) <= 0 THEN format(
        'We received your payment of %s for order %s. Your order is now fully paid.',
        v_amount_text,
        v_order.tracking_number
      )
      ELSE format(
        'We received your payment of %s for order %s. Remaining balance: %s.',
        v_amount_text,
        v_order.tracking_number,
        v_balance_text
      )
    END,
    'payment_update',
    v_order.id
  );

  RETURN NEW;
END;
$function$;

-- This trigger function is server-owned and must never become an RPC surface.
REVOKE ALL ON FUNCTION private.notify_payment_recorded() FROM PUBLIC, anon, authenticated;
