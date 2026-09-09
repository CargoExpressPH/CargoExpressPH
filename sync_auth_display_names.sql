-- I-UPDATE ANG DISPLAY NAME SA SUPABASE AUTHENTICATION
-- Kinokopya nito ang pangalan mula sa "profiles" table at nilalagay sa "auth.users" metadata.

UPDATE auth.users
SET raw_user_meta_data = 
  COALESCE(raw_user_meta_data, '{}'::jsonb) || 
  jsonb_build_object('full_name', p.name, 'name', p.name)
FROM public.profiles p
WHERE auth.users.id = p.id;
