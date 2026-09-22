-- Package QR Labels: how many physical boxes/parcels make up one booking.
-- Admin-set display/operational metadata only — it does not feed pricing,
-- weight, capacity, or any status transition, so it deliberately does NOT
-- touch guard_order_update() or any other trigger. A plain column, written
-- through the existing admin-only "Admins can update orders" RLS policy
-- (FOR UPDATE USING (is_admin()) WITH CHECK (is_admin())) via the existing
-- generic updateOrder() path — no new RPC needed.
--
-- Customers have no UPDATE policy on orders at all (see
-- 20260524190000_production_hardening.sql), so this column is unreachable
-- from the customer side by construction.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS package_quantity INTEGER NOT NULL DEFAULT 1;

-- Sanity ceiling, not a real business limit — keeps a stray value (0,
-- negative, or an absurd count from a bad client) out even if something
-- ever bypasses the admin UI's own stepper bounds.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_package_quantity_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_package_quantity_check
  CHECK (package_quantity >= 1 AND package_quantity <= 50);
