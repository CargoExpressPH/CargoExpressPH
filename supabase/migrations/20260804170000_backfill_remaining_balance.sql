-- ============================================================
-- 20260804170000_backfill_remaining_balance.sql
--
-- Make the settlement guards apply to legacy rows.
--
-- WHY:
--   guard_order_update and guard_trip_completion both test
--   COALESCE(remaining_balance, 0) > 0. A row where remaining_balance is
--   NULL therefore reads as "settled" and sails through the warehouse
--   dispatch gate no matter how much is actually owed. The Unsettled
--   Deliveries list derives the figure from shipping_cost - amount_paid and
--   so *would* show such a row — meaning the report and the enforcement
--   could disagree. This closes that gap.
--
-- SCOPE (measured on the live database, 2026-08-04):
--   0 of 49 orders currently have a NULL remaining_balance, so this is a
--   no-op today. It is applied anyway because it is the invariant, not the
--   cleanup: any future row that reaches production with a NULL balance is
--   silently exempt from the guards, and this migration documents and
--   repairs that class of row.
--
-- Deliberately NOT touched: rows where remaining_balance is non-NULL but
-- disagrees with shipping_cost - amount_paid. There is exactly one (a
-- Cancelled ₱1,770,560 test order) and overwriting a stored ledger total
-- from derived arithmetic would destroy evidence of whatever caused the
-- drift. Those surface as `balance_mismatch` in the Unsettled Deliveries
-- list for a human to judge.
-- ============================================================

UPDATE public.orders
   SET remaining_balance = GREATEST(0, COALESCE(shipping_cost, 0) - COALESCE(amount_paid, 0))
 WHERE remaining_balance IS NULL;


-- ============================================================
-- VERIFY (should return 0):
--   SELECT COUNT(*) FROM orders WHERE remaining_balance IS NULL;
-- ============================================================
