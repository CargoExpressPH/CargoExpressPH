-- Update violating trips to make arrival_date 1 day after departure_date
UPDATE public.trips 
SET arrival_date = departure_date + interval '1 day' 
WHERE arrival_date <= departure_date;
