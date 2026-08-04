-- ============================================================
-- 20260804250000_service_summary_rpc.sql
--
-- get_service_summary() — one admin-gated round trip backing the Service
-- tab in Sales & Reports. Same shape and gating as get_sales_summary().
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
--
-- It does not compare anything to a target. There are no SLA targets yet,
-- because chat support has not carried real customer traffic — the study's
-- original 54-hour median described the developer and testers, not
-- customers. Reporting a "breach" against an invented target would
-- manufacture the same false precision.
--
-- So this returns measurements only. Targets get set once there is a real
-- month of traffic to calibrate against, which is the whole reason the
-- instrumentation shipped before launch.
--
-- ── RESPONSE TIME IS MEASURED AT THE MESSAGE LEVEL ───────────────────────
--
-- Not conversation.first_response_at - created_at, which would only ever
-- describe the FIRST exchange in a thread. A customer who asks something
-- new on day 30 of an open conversation is waiting just as real a wait.
-- Every customer message is therefore paired with the next admin message
-- after it, which is also what the study measured — so the numbers here
-- are comparable to the ones in docs/customer-service-workflow-study.md.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_service_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  WITH
  -- Every customer message paired with the next admin reply, if any.
  asked AS (
    SELECT m.id, m.conversation_id, m.created_at AS asked_at,
           (SELECT MIN(a.created_at)
              FROM public.chat_messages a
             WHERE a.conversation_id = m.conversation_id
               AND a.sender_role = 'admin'
               AND a.created_at > m.created_at) AS answered_at
      FROM public.chat_messages m
     WHERE m.sender_role = 'customer'
  ),
  waits AS (
    SELECT EXTRACT(EPOCH FROM (answered_at - asked_at)) / 60.0 AS minutes
      FROM asked
     WHERE answered_at IS NOT NULL
  ),
  response AS (
    SELECT jsonb_build_object(
      'customerMessages',   (SELECT COUNT(*) FROM asked),
      'answered',           (SELECT COUNT(*) FROM asked WHERE answered_at IS NOT NULL),
      'neverAnswered',      (SELECT COUNT(*) FROM asked WHERE answered_at IS NULL),
      'medianMinutes',      (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY minutes)::numeric, 1) FROM waits),
      'p90Minutes',         (SELECT ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY minutes)::numeric, 1) FROM waits),
      'worstMinutes',       (SELECT ROUND(MAX(minutes)::numeric, 1) FROM waits)
    ) AS value
  ),
  queue AS (
    SELECT jsonb_build_object(
      'total',            COUNT(*),
      'botActive',        COUNT(*) FILTER (WHERE status = 'bot_active'),
      'waiting',          COUNT(*) FILTER (WHERE status = 'waiting'),
      'open',             COUNT(*) FILTER (WHERE status = 'open'),
      'waitingCustomer',  COUNT(*) FILTER (WHERE status = 'waiting_customer'),
      'resolved',         COUNT(*) FILTER (WHERE status = 'resolved'),
      'escalated',        COUNT(*) FILTER (WHERE escalated),
      'unassigned',       COUNT(*) FILTER (WHERE status IN ('waiting','open') AND assigned_admin_id IS NULL),
      'waitingOver24h',   COUNT(*) FILTER (
                            WHERE status = 'waiting'
                              AND COALESCE(last_customer_message_at, created_at) < now() - interval '24 hours'),
      'oldestWaitHours',  COALESCE(ROUND(MAX(
                            CASE WHEN status = 'waiting'
                                 THEN EXTRACT(EPOCH FROM (now() - COALESCE(last_customer_message_at, created_at))) / 3600.0
                            END)::numeric, 1), 0)
    ) AS value
    FROM public.conversations
  ),
  -- Bot deflection. NULL is reported as its own bucket rather than folded
  -- into a denominator: "we never asked" is not the same as "it failed".
  bot AS (
    SELECT jsonb_build_object(
      'helped',    COUNT(*) FILTER (WHERE bot_resolved IS TRUE),
      'notHelped', COUNT(*) FILTER (WHERE bot_resolved IS FALSE),
      'unknown',   COUNT(*) FILTER (WHERE bot_resolved IS NULL),
      'answered',  (SELECT COUNT(*) FROM public.chat_messages WHERE sender_role = 'bot')
    ) AS value
    FROM public.conversations
  ),
  inquiries AS (
    SELECT jsonb_build_object(
      'total',      COUNT(*),
      'new',        COUNT(*) FILTER (WHERE status = 'new'),
      'read',       COUNT(*) FILTER (WHERE status = 'read'),
      'resolved',   COUNT(*) FILTER (WHERE status = 'resolved'),
      'unassigned', COUNT(*) FILTER (WHERE status <> 'resolved' AND assigned_admin_id IS NULL),
      'measured',   COUNT(*) FILTER (WHERE first_response_at IS NOT NULL),
      'medianResponseMinutes', ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60.0
      ) FILTER (WHERE first_response_at IS NOT NULL)::numeric, 1)
    ) AS value
    FROM public.contact_inquiries
  ),
  volume AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.week), '[]'::jsonb) AS value
    FROM (
      SELECT TO_CHAR(DATE_TRUNC('week', created_at), 'YYYY-MM-DD') AS week,
             COUNT(*) FILTER (WHERE sender_role = 'customer') AS customer_msgs,
             COUNT(*) FILTER (WHERE sender_role = 'admin')    AS admin_msgs,
             COUNT(*) FILTER (WHERE sender_role = 'bot')      AS bot_msgs
        FROM public.chat_messages
       WHERE created_at > now() - interval '12 weeks'
       GROUP BY DATE_TRUNC('week', created_at)
    ) v
  ),
  -- Demand by hour, Asia/Manila. Staffing information: it says when
  -- customers actually write, which is not necessarily when anyone is
  -- looking.
  hourly AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.hour), '[]'::jsonb) AS value
    FROM (
      SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Manila')::int AS hour,
             COUNT(*) AS customer_msgs
        FROM public.chat_messages
       WHERE sender_role = 'customer'
       GROUP BY 1
    ) h
  )
  SELECT jsonb_build_object(
    'response',  response.value,
    'queue',     queue.value,
    'bot',       bot.value,
    'inquiries', inquiries.value,
    'volume',    volume.value,
    'hourly',    hourly.value,
    'generatedAt', to_jsonb(now())
  )
  INTO payload
  FROM response, queue, bot, inquiries, volume, hourly;

  RETURN payload;
END;
$$;

REVOKE ALL ON FUNCTION public.get_service_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_service_summary() TO authenticated;


-- ============================================================
-- VERIFY:
--   SELECT jsonb_pretty(public.get_service_summary());
-- ============================================================
