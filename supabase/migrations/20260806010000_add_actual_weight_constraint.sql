-- Add an upper bound CHECK constraint on actual_weight to prevent malicious or extremely erroneous data.
-- Limit set to 10000 kg (10 tons) per order which is extremely generous for a single package but prevents integer overflows or UI-breaking huge numbers.

ALTER TABLE public.orders 
ADD CONSTRAINT check_orders_actual_weight_upper_bound 
CHECK (actual_weight IS NULL OR actual_weight <= 10000);
