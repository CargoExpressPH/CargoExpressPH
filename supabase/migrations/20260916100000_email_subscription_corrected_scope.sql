-- ============================================================
-- Corrected scope for the "email preference" feature.
--
-- Previously, "wants_announcements" lived only as a boolean on
-- contact_inquiries (per-inquiry-row) and profiles (per-account), with no
-- audit trail and no way to record an admin-witnessed opt-in (phone/chat/
-- in-person). That made the subscription's lifecycle implicitly tied to
-- whichever row happened to hold `true`, with no history of who consented,
-- when, or through what channel.
--
-- This migration adds a dedicated subscription entity, keyed by email
-- address (not by inquiry row or account), independent of inquiry status,
-- plus an append-only consent history. It does NOT touch or repurpose
-- `profiles.wants_announcements` / `contact_inquiries.wants_announcements`:
-- those columns keep gating the existing, separate trip-reschedule courtesy
-- email (trips_notify_reschedule_email / email-trip-reschedule, see
-- 20260910020000_trip_reschedule_email_trigger.sql) untouched, and this
-- migration's RPCs best-effort mirror into them so that unrelated feature
-- keeps reflecting the same real-world consent without its own trigger
-- needing to change.
--
-- Scope actually covered by this subscription, per the corrected
-- requirement: newly published trip schedules (already routed through
-- createAnnouncement()+broadcast-announcement when an admin publishes a
-- trip with "announce via email" — src/lib/database.js createTrip()) and
-- publicly published announcements (broadcast-announcement). Both already
-- funnel through the same Edge Function; this migration changes what that
-- function reads as its recipient list (see the accompanying Edge Function
-- change), not the publish triggers themselves.
-- ============================================================

-- ── Current-state table: one row per email address ──────────────────────
CREATE TABLE public.email_subscriptions (
  email TEXT PRIMARY KEY CHECK (
    email = lower(btrim(email))
    AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    AND char_length(email) <= 320
  ),
  subscribed BOOLEAN NOT NULL DEFAULT false,
  name TEXT CHECK (name IS NULL OR char_length(name) <= 100),
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  source_inquiry_id UUID REFERENCES public.contact_inquiries(id) ON DELETE SET NULL,
  last_source TEXT NOT NULL CHECK (last_source IN ('public_form', 'profile_settings', 'admin_recorded', 'unsubscribe_link')),
  -- Reserved for a future bounce/complaint-suppression integration. No
  -- Resend (or other provider) webhook exists in this codebase today, so
  -- nothing sets this column yet — see the implementation report. It is
  -- included now so that integration is a column-already-there addition,
  -- not a schema change, and broadcast-announcement already excludes any
  -- row where this is true.
  suppressed BOOLEAN NOT NULL DEFAULT false,
  suppressed_reason TEXT,
  subscribed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_subscriptions_subscribed_idx
  ON public.email_subscriptions (email)
  WHERE subscribed = true AND suppressed = false;

DROP TRIGGER IF EXISTS email_subscriptions_updated_at ON public.email_subscriptions;
CREATE TRIGGER email_subscriptions_updated_at
  BEFORE UPDATE ON public.email_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Append-only consent history — "subsequent preference history" ───────
CREATE TABLE public.email_subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('subscribed', 'unsubscribed')),
  source TEXT NOT NULL CHECK (source IN ('public_form', 'profile_settings', 'admin_recorded', 'unsubscribe_link')),
  -- Only meaningful (and only required, enforced in the RPC below) for
  -- source = 'admin_recorded'.
  permission_channel TEXT CHECK (permission_channel IS NULL OR permission_channel IN ('phone', 'chat', 'in_person', 'other')),
  permission_received_at TIMESTAMPTZ,
  -- The admin who recorded this, when applicable. NULL for every
  -- self-service source (public_form / profile_settings / unsubscribe_link)
  -- — nobody "on behalf of" the customer acted there.
  recorded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 280),
  source_inquiry_id UUID REFERENCES public.contact_inquiries(id) ON DELETE SET NULL,
  -- Server clock only — never client-supplied. This is "recording
  -- timestamp"; permission_received_at is the separate, admin-supplied
  -- "when the customer actually agreed" field.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_subscription_events_email_idx
  ON public.email_subscription_events (email, created_at DESC);

-- ── Backfill: existing consent under the old boolean columns must carry
--    over. Without this, the moment broadcast-announcement switches to
--    reading only email_subscriptions (see the accompanying Edge Function
--    change), every existing opted-in customer/lead would silently stop
--    receiving mail until they re-subscribed — a real regression, not a
--    migration nicety. subscribed_at is set to "now" (this migration's run
--    time) because neither source column records when consent was actually
--    given; this is documented in the implementation report as a backfill
--    timestamp, not a true original-consent date. profiles is preferred on
--    conflict (an account is a stronger identity than a lead form), so the
--    contact_inquiries insert below is ON CONFLICT DO NOTHING.
INSERT INTO public.email_subscriptions (email, subscribed, name, user_id, last_source, subscribed_at)
SELECT lower(btrim(p.email)), true, p.name, p.id, 'profile_settings', now()
FROM public.profiles p
WHERE p.role = 'customer'
  AND p.wants_announcements = true
  AND p.email IS NOT NULL
  AND lower(btrim(p.email)) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.email_subscriptions (email, subscribed, name, source_inquiry_id, last_source, subscribed_at)
SELECT DISTINCT ON (lower(btrim(ci.contact_email)))
  lower(btrim(ci.contact_email)), true, ci.name, ci.id, 'public_form', now()
FROM public.contact_inquiries ci
WHERE ci.wants_announcements = true
  AND ci.contact_email IS NOT NULL
  AND lower(btrim(ci.contact_email)) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
ORDER BY lower(btrim(ci.contact_email)), ci.created_at DESC
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.email_subscription_events (email, action, source, note)
SELECT email, 'subscribed', last_source::TEXT, 'Backfilled from the pre-existing wants_announcements flag during the subscription-scope correction migration.'
FROM public.email_subscriptions;

COMMENT ON TABLE public.email_subscriptions IS
  'Live "Trip & Announcement Emails" subscription state, one row per email address, independent of any contact_inquiries row or profiles account. Sole recipient source for broadcast-announcement.';
COMMENT ON TABLE public.email_subscription_events IS
  'Append-only consent history for email_subscriptions — every subscribe/unsubscribe, its source, and (for admin-recorded consent) the permission channel, date, admin, and optional note.';

-- ── RLS: admins may read; all writes go through the RPCs below (or the
--    service role, used by the submit-inquiry / unsubscribe-announcements /
--    broadcast-announcement Edge Functions) ──────────────────────────────
ALTER TABLE public.email_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_subscription_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.email_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.email_subscription_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.email_subscriptions TO authenticated;
GRANT SELECT ON public.email_subscription_events TO authenticated;

CREATE POLICY "Admins can view email subscriptions"
  ON public.email_subscriptions
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

CREATE POLICY "Admins can view email subscription history"
  ON public.email_subscription_events
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

-- ============================================================
-- RPC 1: a signed-in customer manages their OWN subscription
-- (Profile → Preferences toggle). Email is derived server-side from the
-- caller's own profile row — never client-supplied — so this can only ever
-- change the caller's own subscription.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_my_email_subscription(p_subscribed BOOLEAN)
RETURNS TABLE (email TEXT, subscribed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
  v_name TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT lower(btrim(p.email)), p.name INTO v_email, v_name
  FROM public.profiles p
  WHERE p.id = v_uid;

  IF v_email IS NULL OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'Your account has no valid email on file';
  END IF;

  INSERT INTO public.email_subscriptions (email, subscribed, name, user_id, last_source, subscribed_at, unsubscribed_at)
  VALUES (
    v_email, p_subscribed, v_name, v_uid, 'profile_settings',
    CASE WHEN p_subscribed THEN now() ELSE NULL END,
    CASE WHEN p_subscribed THEN NULL ELSE now() END
  )
  ON CONFLICT (email) DO UPDATE SET
    subscribed = p_subscribed,
    user_id = v_uid,
    last_source = 'profile_settings',
    name = COALESCE(public.email_subscriptions.name, v_name),
    subscribed_at = CASE WHEN p_subscribed THEN COALESCE(public.email_subscriptions.subscribed_at, now()) ELSE public.email_subscriptions.subscribed_at END,
    unsubscribed_at = CASE WHEN p_subscribed THEN public.email_subscriptions.unsubscribed_at ELSE now() END;

  INSERT INTO public.email_subscription_events (email, action, source)
  VALUES (v_email, CASE WHEN p_subscribed THEN 'subscribed' ELSE 'unsubscribed' END, 'profile_settings');

  -- Best-effort mirror for the existing, separate trip-reschedule courtesy
  -- email, which reads this column directly and is not otherwise touched.
  UPDATE public.profiles SET wants_announcements = p_subscribed WHERE id = v_uid;

  RETURN QUERY SELECT v_email, p_subscribed;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_my_email_subscription(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_email_subscription(BOOLEAN) TO authenticated;

-- ============================================================
-- RPC 2: an admin manages a CUSTOMER'S subscription, either flipping it
-- off, or — the new "admin-recorded permission" path — turning it on based
-- on an explicit agreement received by phone/chat/in person. Recording an
-- inquiry reply is a different action entirely and never calls this.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_email_subscription(
  p_email TEXT,
  p_subscribed BOOLEAN,
  p_permission_channel TEXT DEFAULT NULL,
  p_permission_received_at TIMESTAMPTZ DEFAULT NULL,
  p_note TEXT DEFAULT NULL,
  p_source_inquiry_id UUID DEFAULT NULL,
  p_name TEXT DEFAULT NULL
)
RETURNS TABLE (email TEXT, subscribed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_email TEXT := lower(btrim(p_email));
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_user_id UUID;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  IF v_email IS NULL OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'A valid email address is required';
  END IF;

  -- Enabling requires the compact confirmation: an explicit permission
  -- channel and when it was received. Agreeing to an inquiry reply is not
  -- this, and there is no separate "agreed" flag to fake — the admin
  -- recording a channel and date *is* the recorded agreement.
  IF p_subscribed THEN
    IF p_permission_channel IS NULL OR p_permission_channel NOT IN ('phone', 'chat', 'in_person', 'other') THEN
      RAISE EXCEPTION 'Permission source (phone, chat, in person, or other) is required to enable this subscription';
    END IF;
    IF p_permission_received_at IS NULL THEN
      RAISE EXCEPTION 'When permission was received is required to enable this subscription';
    END IF;
    IF p_permission_received_at > now() + INTERVAL '1 minute' THEN
      RAISE EXCEPTION 'Permission date cannot be in the future';
    END IF;
  END IF;

  SELECT id INTO v_user_id FROM public.profiles WHERE lower(btrim(email)) = v_email LIMIT 1;

  INSERT INTO public.email_subscriptions (email, subscribed, name, user_id, source_inquiry_id, last_source, subscribed_at, unsubscribed_at)
  VALUES (
    v_email, p_subscribed, NULLIF(btrim(COALESCE(p_name, '')), ''), v_user_id, p_source_inquiry_id, 'admin_recorded',
    CASE WHEN p_subscribed THEN now() ELSE NULL END,
    CASE WHEN p_subscribed THEN NULL ELSE now() END
  )
  ON CONFLICT (email) DO UPDATE SET
    subscribed = p_subscribed,
    user_id = COALESCE(v_user_id, public.email_subscriptions.user_id),
    source_inquiry_id = COALESCE(p_source_inquiry_id, public.email_subscriptions.source_inquiry_id),
    last_source = 'admin_recorded',
    name = COALESCE(public.email_subscriptions.name, NULLIF(btrim(COALESCE(p_name, '')), '')),
    subscribed_at = CASE WHEN p_subscribed THEN COALESCE(public.email_subscriptions.subscribed_at, now()) ELSE public.email_subscriptions.subscribed_at END,
    unsubscribed_at = CASE WHEN p_subscribed THEN public.email_subscriptions.unsubscribed_at ELSE now() END;

  INSERT INTO public.email_subscription_events (
    email, action, source, permission_channel, permission_received_at, recorded_by, note, source_inquiry_id
  ) VALUES (
    v_email,
    CASE WHEN p_subscribed THEN 'subscribed' ELSE 'unsubscribed' END,
    'admin_recorded',
    CASE WHEN p_subscribed THEN p_permission_channel ELSE NULL END,
    CASE WHEN p_subscribed THEN p_permission_received_at ELSE NULL END,
    auth.uid(),
    v_note,
    p_source_inquiry_id
  );

  -- Best-effort mirror, same reasoning as set_my_email_subscription above.
  IF v_user_id IS NOT NULL THEN
    UPDATE public.profiles SET wants_announcements = p_subscribed WHERE id = v_user_id;
  END IF;
  UPDATE public.contact_inquiries SET wants_announcements = p_subscribed WHERE lower(btrim(contact_email)) = v_email;

  RETURN QUERY SELECT v_email, p_subscribed;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_email_subscription(TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_email_subscription(TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT) TO authenticated;

-- ============================================================
-- VERIFY:
--   -- As a customer, toggle Profile → Trip & Announcement Emails, then:
--   select * from email_subscriptions where email = '<their email>';
--   select * from email_subscription_events where email = '<their email>' order by created_at desc;
--   -- As an admin, from a disposable test inquiry, run record_email_subscription
--   -- with p_subscribed=true and no p_permission_channel — must raise.
-- ============================================================
