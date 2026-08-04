-- ============================================================
-- 20260804270000_service_summary_four_states.sql
--
-- Follow-up to 20260804260000: get_service_summary() still counted 'open',
-- a status that no longer exists. Left alone it would report a permanent
-- zero, and 'unassigned' would miss every answered-but-unclaimed thread
-- because those are now 'waiting_customer'.
--
-- Only the queue block changes; response times, bot outcomes, inquiries and
-- the volume series are untouched.
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
      'waitingCustomer',  COUNT(*) FILTER (WHERE status = 'waiting_customer'),
      'resolved',         COUNT(*) FILTER (WHERE status = 'resolved'),
      'escalated',        COUNT(*) FILTER (WHERE escalated),
      -- An unclaimed thread is one a person is involved in but nobody owns.
      'unassigned',       COUNT(*) FILTER (
                            WHERE status IN ('waiting', 'waiting_customer')
                              AND assigned_admin_id IS NULL),
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
