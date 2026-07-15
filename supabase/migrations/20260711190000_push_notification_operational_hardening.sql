-- Make browser push registrations reliable and retain a server-side delivery audit.

CREATE TABLE IF NOT EXISTS public.notification_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES public.notifications(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_token_id UUID REFERENCES public.user_device_tokens(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  provider_message_id TEXT DEFAULT NULL,
  error_message TEXT DEFAULT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.notification_delivery_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view notifications" ON public.notifications;
CREATE POLICY "Admins can view notifications" ON public.notifications
  FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS "Users can update own device tokens" ON public.user_device_tokens;
CREATE POLICY "Users can update own device tokens" ON public.user_device_tokens
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notification_id
  ON public.notification_delivery_attempts(notification_id, attempted_at DESC);