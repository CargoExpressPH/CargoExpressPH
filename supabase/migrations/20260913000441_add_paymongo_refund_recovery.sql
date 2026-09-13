-- ============================================================
-- Automatic PayMongo refund recovery
--
-- Webhooks remain the fast path. This durable queue is the independent
-- recovery path for missed webhook deliveries, dashboard-created refunds,
-- and app refund requests whose provider outcome was initially unknown.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE private.paymongo_refund_recovery_jobs (
  payment_transaction_id UUID PRIMARY KEY
    REFERENCES public.payment_transactions(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL,
  livemode BOOLEAN,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed')),
  scan_until TIMESTAMPTZ NOT NULL,
  next_check_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_refund_count INTEGER NOT NULL DEFAULT 0 CHECK (last_refund_count >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error TEXT,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paymongo_refund_recovery_payment_id_format
    CHECK (payment_id ~ '^pay_[A-Za-z0-9_-]{4,128}$'),
  CONSTRAINT paymongo_refund_recovery_schedule_state
    CHECK (
      (status = 'active' AND next_check_at IS NOT NULL)
      OR (status = 'completed' AND next_check_at IS NULL)
    ),
  CONSTRAINT paymongo_refund_recovery_claim_pair
    CHECK ((claim_token IS NULL) = (claimed_at IS NULL))
);

CREATE INDEX paymongo_refund_recovery_due_idx
  ON private.paymongo_refund_recovery_jobs (next_check_at, payment_transaction_id)
  WHERE status = 'active';

COMMENT ON TABLE private.paymongo_refund_recovery_jobs IS
  'Server-only durable schedule for independently reconciling PayMongo refunds. No client role can read or mutate this table.';

REVOKE ALL ON TABLE private.paymongo_refund_recovery_jobs
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE private.paymongo_refund_recovery_jobs TO service_role;

-- Every verified PayMongo payment receives a recovery job. Updating a
-- payment never discards a successful scan history, but it does reactivate a
-- completed job if the provider identity changes.
CREATE OR REPLACE FUNCTION private.enqueue_paymongo_refund_recovery_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.payment_method = 'gcash'
     AND NEW.gcash_channel = 'paymongo'
     AND NEW.transaction_reference ~ '^pay_[A-Za-z0-9_-]{4,128}$'
     AND NEW.payment_status IN ('paid', 'partial') THEN
    INSERT INTO private.paymongo_refund_recovery_jobs (
      payment_transaction_id,
      payment_id,
      scan_until,
      next_check_at
    ) VALUES (
      NEW.id,
      NEW.transaction_reference,
      COALESCE(NEW.created_at, NOW()) + INTERVAL '180 days',
      NOW() + INTERVAL '5 minutes'
    )
    ON CONFLICT (payment_transaction_id) DO UPDATE
    SET payment_id = EXCLUDED.payment_id,
        status = 'active',
        scan_until = GREATEST(
          private.paymongo_refund_recovery_jobs.scan_until,
          EXCLUDED.scan_until
        ),
        next_check_at = LEAST(
          COALESCE(
            private.paymongo_refund_recovery_jobs.next_check_at,
            EXCLUDED.next_check_at
          ),
          EXCLUDED.next_check_at
        ),
        claim_token = CASE
          WHEN private.paymongo_refund_recovery_jobs.payment_id <> EXCLUDED.payment_id
            THEN NULL
          ELSE private.paymongo_refund_recovery_jobs.claim_token
        END,
        claimed_at = CASE
          WHEN private.paymongo_refund_recovery_jobs.payment_id <> EXCLUDED.payment_id
            THEN NULL
          ELSE private.paymongo_refund_recovery_jobs.claimed_at
        END,
        livemode = CASE
          WHEN private.paymongo_refund_recovery_jobs.payment_id <> EXCLUDED.payment_id
            THEN NULL
          ELSE private.paymongo_refund_recovery_jobs.livemode
        END,
        updated_at = NOW();
  ELSE
    DELETE FROM private.paymongo_refund_recovery_jobs
    WHERE payment_transaction_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.enqueue_paymongo_refund_recovery_payment()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payment_transactions_enqueue_refund_recovery
  ON public.payment_transactions;
CREATE TRIGGER payment_transactions_enqueue_refund_recovery
AFTER INSERT OR UPDATE OF
  payment_method, gcash_channel, transaction_reference, payment_status
ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION private.enqueue_paymongo_refund_recovery_payment();

-- A new or unresolved local refund must wake its payment's job even if the
-- normal 180-day scan window has just ended. Terminal provider updates are
-- also given one more day of verification.
CREATE OR REPLACE FUNCTION private.wake_paymongo_refund_recovery_for_refund()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE private.paymongo_refund_recovery_jobs
  SET status = 'active',
      scan_until = GREATEST(scan_until, NOW() + INTERVAL '24 hours'),
      next_check_at = LEAST(
        COALESCE(next_check_at, NOW() + INTERVAL '2 minutes'),
        NOW() + INTERVAL '2 minutes'
      ),
      updated_at = NOW()
  WHERE payment_transaction_id = NEW.payment_transaction_id;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.wake_paymongo_refund_recovery_for_refund()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payment_refunds_wake_recovery ON public.payment_refunds;
CREATE TRIGGER payment_refunds_wake_recovery
AFTER INSERT OR UPDATE OF status, refund_id ON public.payment_refunds
FOR EACH ROW EXECUTE FUNCTION private.wake_paymongo_refund_recovery_for_refund();

-- Existing payments are scanned once immediately. When a historical refund
-- already establishes the payment mode, retain it; otherwise the worker
-- verifies the Payment resource before assigning test/live mode.
INSERT INTO private.paymongo_refund_recovery_jobs (
  payment_transaction_id,
  payment_id,
  livemode,
  scan_until,
  next_check_at
)
SELECT
  pt.id,
  pt.transaction_reference,
  CASE
    WHEN COUNT(DISTINCT pr.livemode) FILTER (WHERE pr.livemode IS NOT NULL) = 1
      THEN MAX(pr.livemode::INT)::BOOLEAN
    ELSE NULL
  END,
  pt.created_at + INTERVAL '180 days',
  NOW()
FROM public.payment_transactions AS pt
LEFT JOIN public.payment_refunds AS pr
  ON pr.payment_transaction_id = pt.id
WHERE pt.payment_method = 'gcash'
  AND pt.gcash_channel = 'paymongo'
  AND pt.transaction_reference ~ '^pay_[A-Za-z0-9_-]{4,128}$'
  AND pt.payment_status IN ('paid', 'partial')
GROUP BY pt.id, pt.transaction_reference, pt.created_at
ON CONFLICT (payment_transaction_id) DO NOTHING;

-- Claim due jobs with a lease. SKIP LOCKED allows a manual invocation and the
-- cron invocation to overlap without scanning the same payment twice.
CREATE OR REPLACE FUNCTION public.claim_paymongo_refund_recovery_jobs(
  p_limit INTEGER,
  p_livemode BOOLEAN
)
RETURNS TABLE (
  payment_transaction_id UUID,
  payment_id TEXT,
  claim_token UUID,
  livemode BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 15), 1), 25);
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL THEN
    RAISE EXCEPTION 'PayMongo mode is required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT j.payment_transaction_id
    FROM private.paymongo_refund_recovery_jobs AS j
    WHERE j.status = 'active'
      AND j.next_check_at <= NOW()
      AND (j.claimed_at IS NULL OR j.claimed_at < NOW() - INTERVAL '10 minutes')
      AND (j.livemode IS NULL OR j.livemode = p_livemode)
    ORDER BY
      EXISTS (
        SELECT 1
        FROM public.payment_refunds AS pr
        WHERE pr.payment_transaction_id = j.payment_transaction_id
          AND pr.status IN ('creating', 'pending', 'processing')
      ) DESC,
      j.next_check_at,
      j.payment_transaction_id
    FOR UPDATE OF j SKIP LOCKED
    LIMIT v_limit
  ), claimed AS (
    UPDATE private.paymongo_refund_recovery_jobs AS j
    SET claim_token = gen_random_uuid(),
        claimed_at = NOW(),
        updated_at = NOW()
    FROM candidates AS c
    WHERE j.payment_transaction_id = c.payment_transaction_id
    RETURNING
      j.payment_transaction_id,
      j.payment_id,
      j.claim_token,
      j.livemode
  )
  SELECT
    c.payment_transaction_id,
    c.payment_id,
    c.claim_token,
    c.livemode
  FROM claimed AS c;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_paymongo_refund_recovery_jobs(INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paymongo_refund_recovery_jobs(INTEGER, BOOLEAN)
  TO service_role;

-- Finish only the lease that was actually claimed. A crashed worker's lease
-- expires after ten minutes. Successful scans run every fifteen minutes while
-- refunds are possible; unresolved app requests are checked every five.
-- Provider failures use bounded exponential backoff but never become dead
-- jobs, so a temporary outage cannot create a permanent reconciliation gap.
CREATE OR REPLACE FUNCTION public.finish_paymongo_refund_recovery_job(
  p_payment_transaction_id UUID,
  p_claim_token UUID,
  p_success BOOLEAN,
  p_livemode BOOLEAN,
  p_has_unresolved BOOLEAN DEFAULT FALSE,
  p_refund_count INTEGER DEFAULT 0,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_updated INTEGER;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_payment_transaction_id IS NULL OR p_claim_token IS NULL OR p_livemode IS NULL THEN
    RAISE EXCEPTION 'Job, claim, and PayMongo mode are required' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_success, FALSE) THEN
    UPDATE private.paymongo_refund_recovery_jobs AS j
    SET livemode = COALESCE(j.livemode, p_livemode),
        status = CASE
          WHEN NOT COALESCE(p_has_unresolved, FALSE) AND NOW() >= j.scan_until
            THEN 'completed'
          ELSE 'active'
        END,
        next_check_at = CASE
          WHEN NOT COALESCE(p_has_unresolved, FALSE) AND NOW() >= j.scan_until
            THEN NULL
          WHEN COALESCE(p_has_unresolved, FALSE)
            THEN NOW() + INTERVAL '5 minutes'
          ELSE NOW() + INTERVAL '15 minutes'
        END,
        last_checked_at = NOW(),
        last_success_at = NOW(),
        last_refund_count = GREATEST(COALESCE(p_refund_count, 0), 0),
        consecutive_failures = 0,
        last_error = NULL,
        claim_token = NULL,
        claimed_at = NULL,
        updated_at = NOW()
    WHERE j.payment_transaction_id = p_payment_transaction_id
      AND j.claim_token = p_claim_token
      AND (j.livemode IS NULL OR j.livemode = p_livemode);
  ELSE
    UPDATE private.paymongo_refund_recovery_jobs AS j
    SET status = 'active',
        next_check_at = NOW() + make_interval(
          mins => LEAST(
            360,
            5 * (2 ^ LEAST(j.consecutive_failures, 6))::INTEGER
          )
        ),
        last_checked_at = NOW(),
        consecutive_failures = j.consecutive_failures + 1,
        last_error = LEFT(
          COALESCE(NULLIF(BTRIM(p_error), ''), 'PayMongo recovery scan failed'),
          1000
        ),
        claim_token = NULL,
        claimed_at = NULL,
        updated_at = NOW()
    WHERE j.payment_transaction_id = p_payment_transaction_id
      AND j.claim_token = p_claim_token;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.finish_paymongo_refund_recovery_job(
  UUID, UUID, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_paymongo_refund_recovery_job(
  UUID, UUID, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, TEXT
) TO service_role;

-- Operational health is service-only and exposes no provider credentials.
CREATE OR REPLACE FUNCTION public.get_paymongo_refund_recovery_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'activeJobs', COUNT(*) FILTER (WHERE j.status = 'active'),
    'completedJobs', COUNT(*) FILTER (WHERE j.status = 'completed'),
    'dueJobs', COUNT(*) FILTER (
      WHERE j.status = 'active' AND j.next_check_at <= NOW()
    ),
    'jobsInBackoff', COUNT(*) FILTER (WHERE j.consecutive_failures > 0),
    'oldestDueAt', MIN(j.next_check_at) FILTER (
      WHERE j.status = 'active' AND j.next_check_at <= NOW()
    ),
    'lastSuccessfulScanAt', MAX(j.last_success_at),
    'unresolvedRefunds', (
      SELECT COUNT(*)
      FROM public.payment_refunds AS pr
      WHERE pr.status IN ('creating', 'pending', 'processing')
    )
  )
  INTO v_result
  FROM private.paymongo_refund_recovery_jobs AS j;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_paymongo_refund_recovery_health()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_paymongo_refund_recovery_health()
  TO service_role;

-- Use terminal-success language only after the provider has reported
-- `succeeded`. Even then, distinguish provider confirmation from the time the
-- customer's wallet posts the funds.
CREATE OR REPLACE FUNCTION private.notify_refund_succeeded()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_amount_text TEXT;
  v_balance_text TEXT;
BEGIN
  IF NEW.status <> 'succeeded'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'succeeded') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.user_id IS NULL THEN RETURN NEW; END IF;

  v_amount_text := chr(8369) || to_char(NEW.amount, 'FM999,999,999,990.00');
  v_balance_text := chr(8369) || to_char(
    GREATEST(COALESCE(v_order.remaining_balance, 0), 0),
    'FM999,999,999,990.00'
  );

  INSERT INTO public.notifications (
    user_id, title, message, type, reference_id, payment_refund_id
  ) VALUES (
    v_order.user_id,
    'Refund Completed',
    format(
      'PayMongo confirmed the %s refund for order %s as succeeded. The order balance is now %s. Posting to the original GCash account may take additional time.',
      v_amount_text, v_order.tracking_number, v_balance_text
    ),
    'payment_update', v_order.id, NEW.id
  ) ON CONFLICT (payment_refund_id) WHERE payment_refund_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_refund_succeeded()
  FROM PUBLIC, anon, authenticated;

-- pg_cron calls the Edge Function with the service-role token held in Vault.
-- The HTTP request is asynchronous through pg_net; the worker has its own
-- durable leases, provider timeouts, and backoff.
CREATE OR REPLACE FUNCTION private.trigger_paymongo_refund_recovery()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_project_url TEXT;
  v_service_key TEXT;
BEGIN
  SELECT decrypted_secret INTO v_project_url
  FROM vault.decrypted_secrets
  WHERE name = 'project_url'
  LIMIT 1;

  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'PayMongo refund recovery skipped because project_url/service_role_key are not configured in Vault.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/paymongo-refund-recovery',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object('limit', 15),
    timeout_milliseconds := 120000
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.trigger_paymongo_refund_recovery()
  FROM PUBLIC, anon, authenticated;

SELECT CASE
  WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'paymongo_refund_recovery')
    THEN cron.unschedule('paymongo_refund_recovery')
END;
SELECT cron.schedule(
  'paymongo_refund_recovery',
  '*/5 * * * *',
  $cron$SELECT private.trigger_paymongo_refund_recovery()$cron$
);
