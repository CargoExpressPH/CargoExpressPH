-- Public payment-return verification uses a bearer capability, not a login
-- session or a public table policy. Store only its SHA-256 digest so a database
-- read cannot be used to reconstruct the confirmation URL.

ALTER TABLE public.payment_attempts
  ADD COLUMN IF NOT EXISTS return_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS return_token_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_attempts_return_token_hash
  ON public.payment_attempts (return_token_hash)
  WHERE return_token_hash IS NOT NULL;

COMMENT ON COLUMN public.payment_attempts.return_token_hash IS
  'SHA-256 digest of the short-lived public payment-return capability; never expose the raw token.';

COMMENT ON COLUMN public.payment_attempts.return_token_expires_at IS
  'Expiry for the public payment-return capability. This does not expire the payment record.';
