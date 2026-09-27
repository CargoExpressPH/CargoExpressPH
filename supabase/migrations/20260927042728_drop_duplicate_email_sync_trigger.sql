-- auth.users carried two AFTER UPDATE OF email triggers calling the same
-- public.sync_auth_email_to_profile(): on_auth_email_sync (defined in
-- 20260825175302_ip_rate_limit_worldclass.sql) and on_auth_user_email_change,
-- which no migration in this repository defines. Every email change ran the
-- sync twice. The function is repeat-safe, so the second run did nothing
-- useful; drop the untracked duplicate and keep the tracked trigger.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'on_auth_email_sync'
       AND tgrelid = 'auth.users'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'on_auth_email_sync is missing; refusing to drop the only email sync trigger';
  END IF;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_email_change ON auth.users;
