-- Add optional middle name columns for sender and receiver on orders.
-- These are nullable; middle name is not required.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS sender_middle_name   TEXT,
  ADD COLUMN IF NOT EXISTS receiver_middle_name TEXT;
