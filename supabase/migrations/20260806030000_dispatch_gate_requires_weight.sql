-- ============================================================
-- 20260806030000_dispatch_gate_requires_weight.sql
--
-- Bug #8 (schema) — the dispatch gate let unweighed cargo through.
--
-- The warehouse hold added in 20260804100000 asks `remaining_balance > 0`.
-- For an unweighed parcel that expression is FALSE, because
-- `remaining_balance` is 0 — not because anything was collected, but because
-- `actual_weight` is the only input to the pricing formula and it has not been
-- captured yet, so `shipping_cost` is 0 too. The gate therefore read "nothing
-- is owed" from a row that means "nothing has been billed", and dispatched it.
--
-- The failure is silent and one-way: cargo leaves the warehouse having never
-- been priced, and once it is Delivered there is no pickup left at which to
-- weigh it. `derive_payment_status` already refuses to call that state 'paid'
-- (20260805120000); this applies the same distinction to dispatch.
--
-- Checked BEFORE the freight-collect exemption. Freight Collect says who pays
-- and when, not whether the parcel has a price — and `actual_weight` is
-- recorded at PICKUP, several statuses before 'Out for Delivery', so any order
-- reaching the gate without one is a data defect regardless of payer.
--
-- Deliberately NOT gated on `shipping_cost > 0`: a genuinely zero-rated
-- shipment (a promo, a reship) is representable and legitimate. The question
-- is whether the parcel was weighed, which is what actual_weight answers.
-- ============================================================

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
$$;
