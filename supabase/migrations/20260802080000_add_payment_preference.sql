ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_preference text DEFAULT 'unspecified';
