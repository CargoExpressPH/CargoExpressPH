-- BURA SA AUTH.USERS NA WALA NA SA PROFILES
-- Gamitin ito para i-sync ang Authentication table dahil manual kang nagbura sa "profiles" table.

DELETE FROM auth.users 
WHERE id NOT IN (SELECT id FROM public.profiles);
