-- ============================================================
-- "Email Updates" preference for Contact Inquiries + Profile.
--
-- One authoritative row per email address, independent of how many
-- contact_inquiries rows or profiles accounts share that address. This is
-- the standing preference for trip-schedule/promo/announcement emails sent
-- through the existing "Send email" option (createAnnouncement +
-- broadcast-announcement — see src/lib/database.js and
-- supabase/functions/broadcast-announcement). It is NOT push notifications
-- and NOT booking/payment transactional email.
--
-- Design note (why a new table, not another boolean column): the same
-- email can appear on multiple contact_inquiries rows AND a profiles
-- account. A boolean per row cannot express "the one current answer for
-- this address" without ambiguity when those rows disagree — which is
-- exactly the bug this feature exists to avoid. profiles.wants_announcements
-- and contact_inquiries.wants_announcements are left exactly as they are:
-- the former keeps gating the separate, pre-existing trip-reschedule
-- courtesy email (email-trip-reschedule Edge Function, untouched here);
-- the latter remains each inquiry's own historical record of what was
-- checked on that particular submission, never rewritten after the fact.
-- Neither is read by the sender going forward — email_subscriptions is the
-- sole recipient source for broadcast-announcement (see the accompanying
-- Edge Function change).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE public.email_subscriptions (
  email TEXT PRIMARY KEY CHECK (
    email = lower(btrim(email))
    AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    AND char_length(email) <= 320
  ),
  subscribed BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL CHECK (source IN ('contact_form', 'admin', 'profile', 'unsubscribe_link')),
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_subscriptions_subscribed_idx
  ON public.email_subscriptions (email)
  WHERE subscribed = true;

COMMENT ON TABLE public.email_subscriptions IS
  'Authoritative "Email Updates" (trip schedules / promos / announcements) preference, one row per email address. Sole recipient source for broadcast-announcement.';
COMMENT ON COLUMN public.email_subscriptions.updated_at IS
  'Server timestamp of the last state change. Label as "Last updated" / "Enabled on" in the UI — not necessarily the exact moment a customer verbally agreed.';
COMMENT ON COLUMN public.email_subscriptions.updated_by IS
  'Admin who made this change via the admin toggle. NULL for self-service sources (contact_form, profile, unsubscribe_link).';

ALTER TABLE public.email_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.email_subscriptions TO authenticated;

CREATE POLICY "Admins can view email subscriptions"
  ON public.email_subscriptions
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

-- ============================================================
-- Sync 1: a new contact inquiry with the box checked is a fresh, current
-- opt-in. An unchecked box writes nothing — it must never cancel an
-- existing subscription. A later inquiry from the same address, submitted
-- without checking the box, is not a withdrawal of consent.
-- ============================================================
CREATE OR REPLACE FUNCTION private.sync_contact_inquiry_email_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_email TEXT := lower(btrim(COALESCE(NEW.contact_email, '')));
BEGIN
  IF NEW.wants_announcements IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF v_email = '' OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.email_subscriptions (email, subscribed, source, updated_by, updated_at)
  VALUES (v_email, true, 'contact_form', NULL, now())
  ON CONFLICT (email) DO UPDATE SET
    subscribed = true,
    source = 'contact_form',
    updated_by = NULL,
    updated_at = now();

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.sync_contact_inquiry_email_subscription() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS contact_inquiries_sync_email_subscription ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_sync_email_subscription
AFTER INSERT ON public.contact_inquiries
FOR EACH ROW
EXECUTE FUNCTION private.sync_contact_inquiry_email_subscription();

-- ============================================================
-- Sync 2: a registered customer's own Profile toggle is a self-service,
-- first-party signal for that account's email — mirror it one-directionally
-- into the authoritative table. The reverse direction (an admin- or
-- unsubscribe-driven disable reaching back into profiles, so the separate
-- trip-reschedule email keeps respecting the same real preference) is
-- handled explicitly by the two RPCs below, using a session-local guard so
-- THIS trigger does not re-fire and overwrite their source/actor back to
-- 'profile'/NULL.
-- ============================================================
CREATE OR REPLACE FUNCTION private.sync_profile_email_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_email TEXT := lower(btrim(COALESCE(NEW.email, '')));
BEGIN
  IF current_setting('cargoexpress.suppress_subscription_sync', true) = 'true' THEN
    RETURN NEW;
  END IF;
  IF v_email = '' OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.email_subscriptions (email, subscribed, source, updated_by, updated_at)
  VALUES (v_email, NEW.wants_announcements, 'profile', NULL, now())
  ON CONFLICT (email) DO UPDATE SET
    subscribed = NEW.wants_announcements,
    source = 'profile',
    updated_by = NULL,
    updated_at = now();

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.sync_profile_email_subscription() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_sync_email_subscription ON public.profiles;
CREATE TRIGGER profiles_sync_email_subscription
AFTER UPDATE OF wants_announcements ON public.profiles
FOR EACH ROW
WHEN (OLD.wants_announcements IS DISTINCT FROM NEW.wants_announcements)
EXECUTE FUNCTION private.sync_profile_email_subscription();

-- ============================================================
-- RPC 1: admin enable/disable from the Contact Inquiry detail modal.
--
-- No permission-channel, date, or note parameters by design: the short
-- confirmation shown in the UI ("The customer agreed to receive trip
-- schedules, promos, and announcements") IS the compact record of
-- agreement. What gets recorded is the admin's own identity (server-derived
-- from auth.uid(), never client-supplied) and a server timestamp — not a
-- form field the admin has to fill in.
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_email_subscription(
  p_email TEXT,
  p_subscribed BOOLEAN
)
-- Returns the whole row rather than RETURNS TABLE(email TEXT, ...): naming
-- an OUT column "email" declares a PL/pgSQL variable of that name, which
-- then shadows every bare `email` column reference in the SQL below
-- ("column reference is ambiguous") — caught by the pgTest suite in
-- scripts/email-updates-subscription-pgtest, not by inspection.
RETURNS public.email_subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_email TEXT := lower(btrim(p_email));
  v_result public.email_subscriptions;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'A valid email address is required';
  END IF;

  INSERT INTO public.email_subscriptions (email, subscribed, source, updated_by, updated_at)
  VALUES (v_email, p_subscribed, 'admin', auth.uid(), now())
  ON CONFLICT (email) DO UPDATE SET
    subscribed = p_subscribed,
    source = 'admin',
    updated_by = auth.uid(),
    updated_at = now()
  RETURNING * INTO v_result;

  -- Disabling must actually stop the separate trip-reschedule courtesy email
  -- too, if this address belongs to a registered customer — that feature
  -- reads profiles.wants_announcements directly and is not otherwise
  -- touched here. Deliberately asymmetric: enabling via this admin path does
  -- NOT mirror into profiles (agreeing to hear about trip schedules through
  -- a phone/chat conversation on an inquiry is not the same as opting into
  -- every future account-level email), but disabling always propagates,
  -- because an opt-out should never leave a person still receiving mail
  -- from a related feature.
  IF NOT p_subscribed THEN
    PERFORM set_config('cargoexpress.suppress_subscription_sync', 'true', true);
    UPDATE public.profiles SET wants_announcements = false WHERE lower(btrim(email)) = v_email;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_email_subscription(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_email_subscription(TEXT, BOOLEAN) TO authenticated;

-- ============================================================
-- RPC 2: unsubscribe-announcements Edge Function's single write path.
-- Replaces that function's two separate direct table updates so the
-- authoritative write and the legacy profiles/contact_inquiries mirror
-- happen atomically in one transaction, with the same suppress-flag
-- protection as the admin RPC above.
-- ============================================================
CREATE OR REPLACE FUNCTION public.unsubscribe_email_updates(p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_email TEXT := lower(btrim(p_email));
BEGIN
  IF v_email IS NULL OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'A valid email address is required';
  END IF;

  INSERT INTO public.email_subscriptions (email, subscribed, source, updated_by, updated_at)
  VALUES (v_email, false, 'unsubscribe_link', NULL, now())
  ON CONFLICT (email) DO UPDATE SET
    subscribed = false,
    source = 'unsubscribe_link',
    updated_by = NULL,
    updated_at = now();

  PERFORM set_config('cargoexpress.suppress_subscription_sync', 'true', true);
  UPDATE public.profiles SET wants_announcements = false WHERE lower(btrim(email)) = v_email;
  UPDATE public.contact_inquiries SET wants_announcements = false WHERE lower(btrim(contact_email)) = v_email;
END;
$function$;

REVOKE ALL ON FUNCTION public.unsubscribe_email_updates(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unsubscribe_email_updates(TEXT) TO service_role;

-- ============================================================
-- VERIFY (after applying):
--   -- Submit a test inquiry with the box checked, then:
--   select * from email_subscriptions where email = '<test email>';
--   -- Toggle a customer's own Profile preference, confirm source='profile':
--   select * from email_subscriptions where email = '<their email>';
--   -- As an admin, call admin_set_email_subscription(p_subscribed=false)
--   -- for an email with a matching profiles row, confirm that row's
--   -- wants_announcements also flips to false.
-- ============================================================
