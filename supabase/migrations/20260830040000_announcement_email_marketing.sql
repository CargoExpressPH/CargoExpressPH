-- Lead-gen / email-marketing opt-in columns.
--
-- contact_inquiries already has `contact_email` (added in
-- 20260803140000_contact_inquiries_normalize.sql) — this migration does NOT
-- add a second `email` column, it only adds the consent flag.
ALTER TABLE public.contact_inquiries
  ADD COLUMN IF NOT EXISTS wants_announcements BOOLEAN NOT NULL DEFAULT false;

-- Registered customers get the same opt-in flag on their profile, so the
-- "email everyone who has an account" idea in the feature request becomes
-- "email everyone who has an account AND asked to hear from us" — sending
-- marketing email to every registered user regardless of consent is both
-- a Data Privacy Act purpose-limitation problem (account creation ≠ consent
-- to marketing) and a deliverability problem (Resend and major mailbox
-- providers require real, unforced opt-in for bulk mail). Defaults to false;
-- a customer opts in from Profile → Preferences.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS wants_announcements BOOLEAN NOT NULL DEFAULT false;

-- Per-announcement email broadcast flag + a record of whether/when it went out,
-- so re-opening an announcement's edit state never triggers a second send.
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS send_email BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.contact_inquiries.wants_announcements IS
  'Visitor opted in, on the public contact form, to receive trip/promo/announcement emails.';
COMMENT ON COLUMN public.profiles.wants_announcements IS
  'Customer opted in, from their profile preferences, to receive announcement emails. Defaults false — account creation alone is not marketing consent.';
COMMENT ON COLUMN public.announcements.send_email IS
  'Admin requested an email broadcast to opted-in subscribers when this announcement was published.';
COMMENT ON COLUMN public.announcements.emailed_at IS
  'Set by the broadcast-announcement Edge Function once the send completes. NULL means not sent (or not requested).';
