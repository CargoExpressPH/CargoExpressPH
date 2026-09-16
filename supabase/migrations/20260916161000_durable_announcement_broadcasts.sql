BEGIN;

CREATE TABLE public.announcement_email_broadcasts (
  announcement_id UUID PRIMARY KEY REFERENCES public.announcements(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  from_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'partial', 'failed', 'needs_review', 'completed')),
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  total_recipients INTEGER NOT NULL DEFAULT 0 CHECK (total_recipients >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  retryable_count INTEGER NOT NULL DEFAULT 0 CHECK (retryable_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  needs_review_count INTEGER NOT NULL DEFAULT 0 CHECK (needs_review_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE public.announcement_email_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id UUID NOT NULL REFERENCES public.announcement_email_broadcasts(announcement_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'accepted', 'skipped', 'retryable', 'permanent_failed', 'needs_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  first_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_payload JSONB,
  provider_message_id TEXT,
  last_error TEXT,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, email),
  CHECK (char_length(idempotency_key) <= 256)
);

CREATE INDEX announcement_email_recipients_claim_idx
  ON public.announcement_email_recipients (announcement_id, status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'retryable', 'sending');

ALTER TABLE public.announcement_email_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_email_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.announcement_email_broadcasts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.announcement_email_recipients FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.announcement_email_broadcasts TO authenticated;

CREATE POLICY "Admins can view announcement email broadcast status"
  ON public.announcement_email_broadcasts
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

CREATE OR REPLACE FUNCTION public.claim_announcement_email_broadcast(
  p_announcement_id UUID,
  p_from_email TEXT,
  p_worker_token UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_announcement public.announcements%ROWTYPE;
  v_job public.announcement_email_broadcasts%ROWTYPE;
  v_created BOOLEAN := false;
BEGIN
  IF p_worker_token IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'Invalid broadcast lease';
  END IF;
  IF btrim(COALESCE(p_from_email, '')) = '' OR char_length(p_from_email) > 320 THEN
    RAISE EXCEPTION 'Invalid sender address';
  END IF;

  SELECT * INTO v_announcement
  FROM public.announcements
  WHERE id = p_announcement_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Announcement not found'; END IF;
  IF v_announcement.send_email IS NOT TRUE THEN
    RAISE EXCEPTION 'Announcement is not marked for email';
  END IF;

  SELECT * INTO v_job
  FROM public.announcement_email_broadcasts
  WHERE announcement_id = p_announcement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.announcement_email_broadcasts
      (announcement_id, subject, content, from_email, status)
    VALUES
      (p_announcement_id, v_announcement.title, v_announcement.content, p_from_email, 'pending')
    RETURNING * INTO v_job;
    v_created := true;

    INSERT INTO public.announcement_email_recipients (announcement_id, email)
    SELECT p_announcement_id, email
    FROM public.email_subscriptions
    WHERE subscribed IS TRUE
    ON CONFLICT (announcement_id, email) DO NOTHING;

    UPDATE public.announcement_email_broadcasts
    SET total_recipients = (
      SELECT count(*) FROM public.announcement_email_recipients
      WHERE announcement_id = p_announcement_id
    )
    WHERE announcement_id = p_announcement_id
    RETURNING * INTO v_job;
  END IF;

  IF v_announcement.emailed_at IS NOT NULL OR v_job.status = 'completed' THEN
    RETURN jsonb_build_object('state', 'completed', 'already_completed', true);
  END IF;

  IF v_job.claim_expires_at > now() AND v_job.claim_token IS DISTINCT FROM p_worker_token THEN
    RETURN jsonb_build_object('state', 'busy', 'retry_after', v_job.claim_expires_at);
  END IF;

  -- An expired send is uncertain. Reuse the same provider idempotency key only
  -- while Resend still retains it; older uncertain sends require review.
  UPDATE public.announcement_email_recipients
  SET status = CASE
        WHEN first_attempt_at <= now() - interval '23 hours' THEN 'needs_review'
        ELSE 'retryable'
      END,
      claim_token = NULL,
      claim_expires_at = NULL,
      next_attempt_at = now(),
      last_error = COALESCE(last_error, 'Recovered an expired sending claim'),
      updated_at = now()
  WHERE announcement_id = p_announcement_id
    AND status = 'sending'
    AND claim_expires_at <= now();

  UPDATE public.announcement_email_recipients
  SET status = 'needs_review',
      last_error = COALESCE(last_error, 'Provider idempotency retention window elapsed'),
      updated_at = now()
  WHERE announcement_id = p_announcement_id
    AND status = 'retryable'
    AND first_attempt_at <= now() - interval '23 hours';

  UPDATE public.announcement_email_broadcasts
  SET status = 'processing',
      claim_token = p_worker_token,
      claim_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  WHERE announcement_id = p_announcement_id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'state', 'claimed',
    'created', v_created,
    'subject', v_job.subject,
    'content', v_job.content,
    'from_email', v_job.from_email,
    'total', v_job.total_recipients
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_announcement_email_recipient(
  p_announcement_id UUID,
  p_worker_token UUID,
  p_lease_seconds INTEGER DEFAULT 45
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_recipient public.announcement_email_recipients%ROWTYPE;
  v_recipient_token UUID := gen_random_uuid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.announcement_email_broadcasts
    WHERE announcement_id = p_announcement_id
      AND claim_token = p_worker_token
      AND claim_expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Broadcast claim is stale';
  END IF;

  SELECT * INTO v_recipient
  FROM public.announcement_email_recipients
  WHERE announcement_id = p_announcement_id
    AND status IN ('pending', 'retryable')
    AND next_attempt_at <= now()
  ORDER BY created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.announcement_email_recipients
  SET status = 'sending',
      attempts = attempts + 1,
      claim_token = v_recipient_token,
      claim_expires_at = now() + make_interval(secs => p_lease_seconds),
      first_attempt_at = COALESCE(first_attempt_at, now()),
      updated_at = now()
  WHERE id = v_recipient.id
  RETURNING * INTO v_recipient;

  RETURN jsonb_build_object(
    'id', v_recipient.id,
    'email', v_recipient.email,
    'idempotency_key', v_recipient.idempotency_key,
    'recipient_token', v_recipient.claim_token,
    'delivery_payload', v_recipient.delivery_payload,
    'attempts', v_recipient.attempts
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.prepare_announcement_email_payload(
  p_announcement_id UUID,
  p_worker_token UUID,
  p_recipient_id UUID,
  p_recipient_token UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_payload JSONB;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'Invalid email payload'; END IF;
  UPDATE public.announcement_email_recipients r
  SET delivery_payload = COALESCE(r.delivery_payload, p_payload), updated_at = now()
  FROM public.announcement_email_broadcasts b
  WHERE r.id = p_recipient_id
    AND r.announcement_id = p_announcement_id
    AND r.status = 'sending'
    AND r.claim_token = p_recipient_token
    AND r.claim_expires_at > now()
    AND b.announcement_id = r.announcement_id
    AND b.claim_token = p_worker_token
    AND b.claim_expires_at > now()
  RETURNING r.delivery_payload INTO v_payload;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recipient claim is stale'; END IF;
  RETURN v_payload;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_announcement_email_outcome(
  p_announcement_id UUID,
  p_worker_token UUID,
  p_recipient_id UUID,
  p_recipient_token UUID,
  p_outcome TEXT,
  p_provider_message_id TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL,
  p_retry_after_seconds INTEGER DEFAULT 60
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_outcome NOT IN ('accepted', 'skipped', 'retryable', 'permanent_failed', 'needs_review') THEN
    RAISE EXCEPTION 'Invalid recipient outcome';
  END IF;
  UPDATE public.announcement_email_recipients r
  SET status = p_outcome,
      provider_message_id = CASE WHEN p_outcome = 'accepted' THEN p_provider_message_id ELSE r.provider_message_id END,
      accepted_at = CASE WHEN p_outcome = 'accepted' THEN now() ELSE r.accepted_at END,
      last_error = left(p_error, 1000),
      next_attempt_at = CASE WHEN p_outcome = 'retryable'
        THEN now() + make_interval(secs => greatest(15, least(p_retry_after_seconds, 3600)))
        ELSE r.next_attempt_at END,
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = now()
  FROM public.announcement_email_broadcasts b
  WHERE r.id = p_recipient_id
    AND r.announcement_id = p_announcement_id
    AND r.status = 'sending'
    AND r.claim_token = p_recipient_token
    AND b.announcement_id = r.announcement_id
    AND b.claim_token = p_worker_token
    AND b.claim_expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Recipient claim is stale'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_announcement_email_broadcast(
  p_announcement_id UUID,
  p_worker_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_total INTEGER;
  v_accepted INTEGER;
  v_skipped INTEGER;
  v_retryable INTEGER;
  v_failed INTEGER;
  v_review INTEGER;
  v_outstanding INTEGER;
  v_status TEXT;
BEGIN
  PERFORM 1 FROM public.announcement_email_broadcasts
  WHERE announcement_id = p_announcement_id
    AND claim_token = p_worker_token
    AND claim_expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Broadcast claim is stale'; END IF;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'accepted'),
         count(*) FILTER (WHERE status = 'skipped'),
         count(*) FILTER (WHERE status = 'retryable'),
         count(*) FILTER (WHERE status = 'permanent_failed'),
         count(*) FILTER (WHERE status = 'needs_review'),
         count(*) FILTER (WHERE status IN ('pending', 'sending', 'retryable'))
  INTO v_total, v_accepted, v_skipped, v_retryable, v_failed, v_review, v_outstanding
  FROM public.announcement_email_recipients
  WHERE announcement_id = p_announcement_id;

  v_status := CASE
    WHEN v_outstanding = 0 AND v_failed = 0 AND v_review = 0 THEN 'completed'
    WHEN v_outstanding = 0 AND v_review > 0 THEN 'needs_review'
    WHEN v_outstanding = 0 AND v_failed > 0 THEN 'failed'
    ELSE 'partial'
  END;

  IF v_status = 'completed' THEN
    UPDATE public.announcements
    SET emailed_at = COALESCE(emailed_at, now())
    WHERE id = p_announcement_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Announcement completion write failed'; END IF;
  END IF;

  UPDATE public.announcement_email_broadcasts
  SET status = v_status,
      claim_token = NULL,
      claim_expires_at = NULL,
      total_recipients = v_total,
      accepted_count = v_accepted,
      skipped_count = v_skipped,
      retryable_count = v_retryable,
      failed_count = v_failed,
      needs_review_count = v_review,
      completed_at = CASE WHEN v_status = 'completed' THEN now() ELSE NULL END,
      updated_at = now()
  WHERE announcement_id = p_announcement_id;

  RETURN jsonb_build_object(
    'state', v_status,
    'total', v_total,
    'accepted', v_accepted,
    'skipped', v_skipped,
    'retryable', v_retryable,
    'failed', v_failed,
    'needs_review', v_review
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_announcement_email_broadcast(UUID, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_announcement_email_recipient(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_announcement_email_payload(UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_announcement_email_outcome(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_announcement_email_broadcast(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_announcement_email_broadcast(UUID, TEXT, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_announcement_email_recipient(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_announcement_email_payload(UUID, UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_announcement_email_outcome(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_announcement_email_broadcast(UUID, UUID) TO service_role;

COMMENT ON TABLE public.announcement_email_broadcasts IS
  'Durable announcement-email job. Content and sender are snapshotted on first claim; emailed_at is set only after every recipient is accepted or skipped.';
COMMENT ON COLUMN public.announcement_email_recipients.idempotency_key IS
  'Stable Resend Idempotency-Key reused for every safe retry of this recipient.';
COMMENT ON COLUMN public.announcement_email_recipients.delivery_payload IS
  'Exact provider payload persisted before the first send and reused with the stable idempotency key.';

COMMIT;
