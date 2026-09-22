-- Global default trip capacity, paired with the existing
-- company_information.default_price_per_kg. Create Trip no longer asks the
-- admin to type capacity/price per trip — both are pulled from this single
-- row at trip-creation time (src/pages/admin/CreateTripPage.jsx) instead, the
-- same way default_price_per_kg already backs global_price_per_kilo() for
-- every unpriced order.
ALTER TABLE public.company_information
  ADD COLUMN IF NOT EXISTS default_capacity INTEGER DEFAULT 0;

-- Sanity floor only (mirrors trips.capacity itself, which has no CHECK
-- constraint of its own) — a negative capacity is never meaningful.
ALTER TABLE public.company_information
  DROP CONSTRAINT IF EXISTS company_information_default_capacity_check;
ALTER TABLE public.company_information
  ADD CONSTRAINT company_information_default_capacity_check
  CHECK (default_capacity >= 0);
