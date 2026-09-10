-- ============================================================
-- Admin-only shipping discount — schema (part 1 of 3)
--
-- ── DESIGN ───────────────────────────────────────────────────────────────
-- `orders.shipping_cost` already means ONE thing everywhere in this codebase:
-- the ORIGINAL fee computed from actual_weight × the applicable rate (see
-- guard_order_update / prepare_order_insert). Every trigger, RPC and report
-- that touches it keeps meaning that. This migration does NOT redefine it —
-- doing so would be the "subtract the discount twice" trap the feature brief
-- warns about, since guard_order_update recomputes shipping_cost from scratch
-- (weight × rate) on every weight/trip change; if shipping_cost had become
-- "the discounted fee", that recompute would silently erase every discount.
--
-- Instead, the discount is recorded on its OWN columns, and "what is payable"
-- becomes a small derived expression — shipping_cost minus discount_amount —
-- computed by the new order_payable_amount() helper in the next migration and
-- used everywhere "the amount owed" used to mean bare shipping_cost:
-- guard_order_update, update_order_payment_totals, and the reporting RPCs.
--
--   orders.discount_amount     — fixed peso amount taken off the ORIGINAL fee.
--                                 0 by default; never negative; never more
--                                 than shipping_cost (enforced below and by
--                                 guard_order_update in the next migration).
--   orders.discount_reason     — 'Regular customer' | 'Negotiated price' |
--                                 'Other'; NULL when discount_amount is 0.
--   orders.discount_notes      — the required explanation when reason is
--                                 'Other'; NULL otherwise.
--   orders.discount_applied_by — the admin profile that set it. Kept on the
--                                 ORDER ROW, not only in activity_logs, per
--                                 the brief: activity_logs is a log an admin
--                                 can purge, so "who/when/why" must survive
--                                 that.
--   orders.discount_applied_at — when it was set.
--
-- "Original fee", "discount" and "final fee" are therefore always three
-- separate, always-recoverable numbers:
--   original fee = shipping_cost
--   final fee    = order_payable_amount(shipping_cost, discount_amount)
--   discount     = discount_amount
--
-- Nothing here changes remaining_balance / payment_status computation yet —
-- that is 20260911020000, which is the migration that actually makes
-- "what is owed" discount-aware. This migration only adds the columns, so it
-- is safe to apply on its own with zero behavioural change (every existing
-- order gets discount_amount = 0, which is a no-op in every formula that will
-- read it).
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS discount_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_reason    TEXT,
  ADD COLUMN IF NOT EXISTS discount_notes     TEXT,
  ADD COLUMN IF NOT EXISTS discount_applied_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discount_applied_at TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.discount_amount IS
  'Fixed peso amount subtracted from the ORIGINAL shipping_cost to get the payable ("final") fee. Never negative, never greater than shipping_cost. 0 means no discount. Set exactly once, at pickup, by record_pickup_payment(); read-only after that — see guard_order_update.';
COMMENT ON COLUMN public.orders.discount_reason IS
  'Regular customer | Negotiated price | Other. NULL whenever discount_amount is 0 — a reason with no discount would be a stale label, not a fact about the order.';
COMMENT ON COLUMN public.orders.discount_notes IS
  'Required free-text explanation when discount_reason = Other; NULL otherwise. Admin-internal — not shown to the customer (see customer/admin OrderDetailPage).';
COMMENT ON COLUMN public.orders.discount_applied_by IS
  'The admin profile that applied the discount. Kept on the order itself (not only in activity_logs, which can be purged) so the audit fact survives independently.';
COMMENT ON COLUMN public.orders.discount_applied_at IS
  'When the discount was applied. Paired with discount_applied_by.';

ALTER TABLE public.orders
  ADD CONSTRAINT orders_discount_amount_nonnegative
    CHECK (discount_amount >= 0),
  ADD CONSTRAINT orders_discount_amount_not_exceeding_fee
    CHECK (discount_amount <= COALESCE(shipping_cost, 0)),
  ADD CONSTRAINT orders_discount_reason_valid
    CHECK (discount_reason IS NULL OR discount_reason IN ('Regular customer', 'Negotiated price', 'Other')),
  -- No reason may be stored without money behind it, and vice versa — a
  -- positive discount is meaningless without a stated reason.
  ADD CONSTRAINT orders_discount_reason_requires_amount
    CHECK ((discount_amount > 0) = (discount_reason IS NOT NULL)),
  ADD CONSTRAINT orders_discount_other_requires_notes
    CHECK (discount_reason IS DISTINCT FROM 'Other' OR NULLIF(btrim(discount_notes), '') IS NOT NULL);

-- Every existing order keeps its current price and payment history exactly as
-- it is: discount_amount defaults to 0 and every other new column defaults to
-- NULL, so order_payable_amount(shipping_cost, 0) = shipping_cost for every
-- row that already exists. No historical fee is recomputed, and no discount
-- history is fabricated for past orders.
