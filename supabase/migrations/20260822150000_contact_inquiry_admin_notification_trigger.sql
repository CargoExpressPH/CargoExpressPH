-- Keep public contact submissions visible to admins without trusting a
-- browser-supplied notification payload. The insert policy intentionally
-- allows anonymous visitors to submit inquiries, so the notification fan-out
-- belongs in a SECURITY DEFINER trigger owned by the database.

CREATE OR REPLACE FUNCTION public.notify_admins_of_contact_inquiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'New Contact Inquiry',
    format(
      'Inquiry from %s: %s',
      COALESCE(NULLIF(btrim(NEW.name), ''), 'Visitor'),
      left(COALESCE(btrim(NEW.message), ''), 80)
    ),
    'inquiry',
    NEW.id
  FROM public.profiles AS p
  WHERE p.role = 'admin';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_inquiries_notify_admins ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_notify_admins
AFTER INSERT ON public.contact_inquiries
FOR EACH ROW
EXECUTE FUNCTION public.notify_admins_of_contact_inquiry();

REVOKE ALL ON FUNCTION public.notify_admins_of_contact_inquiry() FROM PUBLIC;
