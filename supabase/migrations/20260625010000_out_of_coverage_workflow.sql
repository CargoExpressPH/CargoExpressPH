-- Add new columns for Out-of-Coverage workflow
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS service_area_status TEXT DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS service_area_remarks TEXT;

-- Drop existing status check constraint if it exists and recreate it to include 'Pending Review'
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
ADD CONSTRAINT orders_status_check CHECK (status IN (
    'Pending Review', 
    'Pending', 
    'Assigned', 
    'Picked Up', 
    'In Transit', 
    'Arrived at Hub', 
    'Out for Delivery', 
    'Delivered', 
    'Cancelled'
));

-- Add a check constraint for service_area_status
ALTER TABLE public.orders
ADD CONSTRAINT orders_service_area_status_check CHECK (service_area_status IN (
    'standard',
    'for_review',
    'approved',
    'rejected'
));
