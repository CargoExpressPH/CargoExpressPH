-- Keep one push registration per browser/PWA installation while preserving
-- multiple registrations for the same user across multiple devices.

ALTER TABLE public.user_device_tokens
  ADD COLUMN IF NOT EXISTS device_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS user_device_tokens_user_device_key
  ON public.user_device_tokens (user_id, device_id)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_device_tokens_device_id_idx
  ON public.user_device_tokens (device_id)
  WHERE device_id IS NOT NULL;

-- The public contact form creates its in-app notifications in a database
-- trigger. This marker makes the follow-up push dispatch idempotent.
ALTER TABLE public.contact_inquiries
  ADD COLUMN IF NOT EXISTS push_dispatched_at TIMESTAMPTZ;

COMMENT ON COLUMN public.user_device_tokens.device_id IS
  'Stable browser/PWA installation identifier. One user may have many device rows.';

COMMENT ON COLUMN public.contact_inquiries.push_dispatched_at IS
  'Set after the public contact inquiry push dispatch is claimed.';

CREATE OR REPLACE FUNCTION public.claim_push_device_registration(
  p_device_id TEXT,
  p_token TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $function$
DECLARE
  v_device_id TEXT := NULLIF(btrim(p_device_id), '');
  v_token TEXT := NULLIF(btrim(p_token), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_device_id IS NULL OR v_token IS NULL THEN
    RAISE EXCEPTION 'A device ID and push token are required';
  END IF;

  IF char_length(v_device_id) > 200 OR char_length(v_token) > 20000 THEN
    RAISE EXCEPTION 'Push registration value is too long';
  END IF;

  -- Serialize claims for one installation so a token refresh and an account
  -- switch cannot leave duplicate rows behind.
  PERFORM pg_advisory_xact_lock(hashtext(v_device_id));

  -- A browser can only have one current signed-in account. Remove its stale
  -- ownership, but leave every other device belonging to the old account.
  DELETE FROM public.user_device_tokens
   WHERE device_id = v_device_id
      OR token = v_token;

  INSERT INTO public.user_device_tokens (user_id, device_id, token)
  VALUES (auth.uid(), v_device_id, v_token);
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_push_device_registration(
  p_device_id TEXT DEFAULT NULL,
  p_token TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $function$
DECLARE
  v_device_id TEXT := NULLIF(btrim(p_device_id), '');
  v_token TEXT := NULLIF(btrim(p_token), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  DELETE FROM public.user_device_tokens
   WHERE user_id = auth.uid()
     AND (
       (v_device_id IS NOT NULL AND device_id = v_device_id)
       OR (v_token IS NOT NULL AND token = v_token)
     );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_push_device_registration(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_push_device_registration(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_push_device_registration(TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.remove_push_device_registration(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_push_device_registration(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_push_device_registration(TEXT, TEXT) TO authenticated;
