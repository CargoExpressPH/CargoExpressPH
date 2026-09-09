-- Elevate E2E test account to admin
UPDATE public.profiles
SET role = 'admin'
WHERE email = 'e2e_admin@cargoexpress.ph';
