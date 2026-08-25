-- World-class IP rate limiting (no captcha) + hardening from audit
-- IP 5/10min per IP, 15 global/min, CHECKs, RLS, cron, stamp hardening

-- 1. Add ip column (idempotent)
ALTER TABLE public.contact_inquiries ADD COLUMN IF NOT EXISTS ip TEXT;

-- 2. Add CHECKs for contact_inquiries if not exists (idempotent via DO block)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name = 'contact_inquiries_name_check') THEN
    ALTER TABLE public.contact_inquiries ADD CONSTRAINT contact_inquiries_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name = 'contact_inquiries_phone_check') THEN
    ALTER TABLE public.contact_inquiries ADD CONSTRAINT contact_inquiries_phone_check CHECK (char_length(btrim(phone)) BETWEEN 7 AND 20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name = 'contact_inquiries_message_check') THEN
    ALTER TABLE public.contact_inquiries ADD CONSTRAINT contact_inquiries_message_check CHECK (char_length(btrim(message)) BETWEEN 10 AND 2000);
  END IF;
END $$;

-- 3. Index for ip
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_ip ON public.contact_inquiries USING btree (ip) WHERE ip IS NOT NULL;

-- 4. World-class IP rate limit trigger (replace)
CREATE OR REPLACE FUNCTION public.guard_contact_inquiry_rate_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ 
BEGIN
  IF NEW.ip IS NOT NULL AND btrim(NEW.ip) <> '' THEN
    IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE ip = NEW.ip AND created_at > now() - interval '10 minutes') >= 5 THEN
      RAISE EXCEPTION 'Too many inquiries from your network. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE phone = NEW.phone AND created_at > now() - interval '10 minutes') >= 3 THEN
      RAISE EXCEPTION 'Too many inquiries from this phone number. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE created_at > now() - interval '1 minute') >= 15 THEN
    RAISE EXCEPTION 'Too many inquiries right now. Please try again in a minute.' USING ERRCODE = '42501';
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.phone := btrim(NEW.phone);
  NEW.message := btrim(NEW.message);
  IF NEW.ip IS NOT NULL THEN NEW.ip := btrim(NEW.ip); END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS contact_inquiries_guard_rate_limit ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_guard_rate_limit BEFORE INSERT ON contact_inquiries FOR EACH ROW EXECUTE FUNCTION guard_contact_inquiry_rate_limit();

-- 5. Hardening: stamp functions, RLS, cron, update_updated_at
CREATE OR REPLACE FUNCTION public.stamp_conversation_resolved_at()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ BEGIN IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN NEW.resolved_at := COALESCE(NEW.resolved_at, now()); ELSIF NEW.status <> 'resolved' THEN NEW.resolved_at := NULL; END IF; RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.stamp_inquiry_service_state()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ BEGIN IF NEW.status IS DISTINCT FROM OLD.status THEN IF NEW.status <> 'new' THEN NEW.first_response_at := COALESCE(NEW.first_response_at, now()); END IF; IF NEW.status = 'resolved' THEN NEW.resolved_at := COALESCE(NEW.resolved_at, now()); ELSE NEW.resolved_at := NULL; END IF; END IF; RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $function$;

DROP POLICY IF EXISTS "Admins can view delivery attempts" ON public.notification_delivery_attempts;
CREATE POLICY "Admins can view delivery attempts" ON public.notification_delivery_attempts FOR SELECT TO authenticated USING (is_admin());

SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_old_activity_logs') THEN cron.unschedule('purge_old_activity_logs') END;
SELECT cron.schedule('purge_old_activity_logs', '0 3 * * *', $cron$SELECT public.purge_old_activity_logs()$cron$);
SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto_resolve_stale_conversations') THEN cron.unschedule('auto_resolve_stale_conversations') END;
SELECT cron.schedule('auto_resolve_stale_conversations', '30 3 * * *', $cron$SELECT public.auto_resolve_stale_conversations()$cron$);

-- Auth triggers (idempotent)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
DROP TRIGGER IF EXISTS on_auth_email_sync ON auth.users;
CREATE TRIGGER on_auth_email_sync AFTER UPDATE OF email ON auth.users FOR EACH ROW EXECUTE FUNCTION public.sync_auth_email_to_profile();
