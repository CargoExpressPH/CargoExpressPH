-- Validate every push registration at the privileged RPC boundary and remove
-- direct authenticated INSERT/UPDATE access that could bypass that validation.

CREATE OR REPLACE FUNCTION public.claim_push_device_registration(
  p_device_id TEXT,
  p_token TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_device_id TEXT := NULLIF(btrim(p_device_id), '');
  v_token TEXT := NULLIF(btrim(p_token), '');
  v_subscription JSONB;
  v_endpoint TEXT;
  v_p256dh TEXT;
  v_auth TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_device_id IS NULL OR v_token IS NULL THEN
    RAISE EXCEPTION 'A device ID and push token are required';
  END IF;

  IF char_length(v_device_id) < 8
     OR char_length(v_device_id) > 200
     OR v_device_id ~ '[[:space:][:cntrl:]]'
     OR v_device_id !~ '^[A-Za-z0-9._:-]+$' THEN
    RAISE EXCEPTION 'Device ID is not valid';
  END IF;

  IF left(v_token, 8) = 'webpush:' THEN
    IF char_length(v_token) > 6000 THEN
      RAISE EXCEPTION 'Web Push subscription is too long';
    END IF;

    BEGIN
      v_subscription := substring(v_token FROM 9)::JSONB;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Web Push subscription is not valid JSON';
    END;

    IF jsonb_typeof(v_subscription) <> 'object'
       OR jsonb_typeof(v_subscription->'keys') <> 'object' THEN
      RAISE EXCEPTION 'Web Push subscription has an invalid shape';
    END IF;

    v_endpoint := v_subscription->>'endpoint';
    v_p256dh := v_subscription->'keys'->>'p256dh';
    v_auth := v_subscription->'keys'->>'auth';

    -- CargoExpress currently creates native Web Push subscriptions only in
    -- Safari/WebKit. Restrict egress to Apple's documented push-service domain.
    IF v_endpoint IS NULL
       OR v_endpoint !~ '^https://([A-Za-z0-9-]+\.)+push\.apple\.com(?::443)?/[^[:space:]#]+$' THEN
      RAISE EXCEPTION 'Web Push endpoint is not an approved Apple push endpoint';
    END IF;

    -- PushSubscription.toJSON() emits unpadded base64url: a 65-byte P-256
    -- public key is 87 characters and a 16-byte auth secret is 22.
    IF v_p256dh IS NULL OR v_p256dh !~ '^[A-Za-z0-9_-]{87}$' THEN
      RAISE EXCEPTION 'Web Push p256dh key is not valid';
    END IF;
    IF v_auth IS NULL OR v_auth !~ '^[A-Za-z0-9_-]{22}$' THEN
      RAISE EXCEPTION 'Web Push auth key is not valid';
    END IF;
  ELSE
    -- FCM registration tokens are opaque. Enforce conservative structural
    -- limits without assuming a provider-internal fixed length.
    IF char_length(v_token) < 20
       OR char_length(v_token) > 4096
       OR v_token ~ '[[:space:][:cntrl:]]' THEN
      RAISE EXCEPTION 'FCM token is not valid';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_device_id));

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
SET search_path = ''
AS $function$
DECLARE
  v_device_id TEXT := NULLIF(btrim(p_device_id), '');
  v_token TEXT := NULLIF(btrim(p_token), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_device_id IS NULL AND v_token IS NULL THEN
    RAISE EXCEPTION 'A device ID or push token is required';
  END IF;

  DELETE FROM public.user_device_tokens
  WHERE user_id = auth.uid()
    AND (
      (v_device_id IS NOT NULL AND device_id = v_device_id)
      OR (v_token IS NOT NULL AND token = v_token)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_push_device_registration(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_push_device_registration(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_push_device_registration(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_push_device_registration(TEXT, TEXT) TO authenticated, service_role;

DROP POLICY IF EXISTS "Admins can insert device tokens" ON public.user_device_tokens;
DROP POLICY IF EXISTS "Users can insert own device tokens" ON public.user_device_tokens;
DROP POLICY IF EXISTS "Users can update own device tokens" ON public.user_device_tokens;
DROP POLICY IF EXISTS "Users can view own device tokens" ON public.user_device_tokens;
DROP POLICY IF EXISTS "Users can delete own device tokens" ON public.user_device_tokens;

CREATE POLICY "Users can view own device tokens"
  ON public.user_device_tokens
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can delete own device tokens"
  ON public.user_device_tokens
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE ON TABLE public.user_device_tokens FROM authenticated;

-- Preserve the existing notification permissions while reducing them to one
-- permissive policy per operation and evaluating auth helpers once per query.
DROP POLICY IF EXISTS "Admins can insert notifications" ON public.notifications;
DROP POLICY IF EXISTS "Admins can view notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can insert own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can view own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can delete own notifications" ON public.notifications;

CREATE POLICY "Users view authorized notifications"
  ON public.notifications
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (SELECT public.is_admin())
  );

CREATE POLICY "Users insert authorized notifications"
  ON public.notifications
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    OR (SELECT public.is_admin())
  );

CREATE POLICY "Users update own notifications"
  ON public.notifications
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users delete own notifications"
  ON public.notifications
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admins can view delivery attempts" ON public.notification_delivery_attempts;
CREATE POLICY "Admins can view delivery attempts"
  ON public.notification_delivery_attempts
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

CREATE INDEX IF NOT EXISTS notification_delivery_attempts_user_id_idx
  ON public.notification_delivery_attempts (user_id);
CREATE INDEX IF NOT EXISTS notification_delivery_attempts_device_token_id_idx
  ON public.notification_delivery_attempts (device_token_id)
  WHERE device_token_id IS NOT NULL;
