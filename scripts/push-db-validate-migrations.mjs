import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'dotenv/config';

const token = process.env.SUPABASE_ACCESS_TOKEN
  || process.env.SUPABASE_PERSONAL_ACCESS_TOKEN
  || process.env.supabase_PAT;
const projectUrl = process.env.VITE_SUPABASE_URL || '';
const projectRef = new URL(projectUrl).hostname.split('.')[0];
assert.ok(token, 'Supabase PAT is missing');
assert.ok(projectRef, 'Supabase project URL is missing');

// Only migrations that are not recorded in production yet. The applied ones are
// already part of the schema this transaction runs against — replaying their
// CREATE TABLE would fail on the objects they successfully created.
const migrations = [
  'supabase/migrations/20260905003149_complete_order_notification_atomicity.sql',
];
const behavioralChecks = String.raw`
DO $push_contract$
DECLARE
  v_user_id UUID;
  v_device_id UUID;
  v_notification_id UUID;
  v_job_id UUID;
  v_claim_id UUID;
  v_outcome TEXT;
  v_rejected BOOLEAN := FALSE;
BEGIN
  SELECT user_id, id INTO v_user_id, v_device_id
  FROM public.user_device_tokens
  ORDER BY created_at
  LIMIT 1;
  IF v_user_id IS NULL OR v_device_id IS NULL THEN
    RAISE EXCEPTION 'A registered device is required for the push contract check';
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type)
  VALUES (v_user_id, 'Push migration contract check', 'Rolled back automatically', 'general')
  RETURNING id INTO v_notification_id;

  SELECT id INTO v_job_id
  FROM public.notification_delivery_jobs
  WHERE notification_id = v_notification_id AND device_token_id = v_device_id;
  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'Notification insert did not create its device outbox job';
  END IF;

  SELECT job_id, job_claim_id INTO v_job_id, v_claim_id
  FROM public.claim_notification_delivery_job(v_notification_id, v_device_id);
  IF v_claim_id IS NULL THEN
    RAISE EXCEPTION 'Outbox job could not be claimed';
  END IF;

  SELECT public.complete_notification_delivery_job(v_job_id, v_claim_id, 'sent', NULL)
  INTO v_outcome;
  IF v_outcome IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'Outbox job did not complete as sent';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user_id::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_id)::TEXT, TRUE);
  BEGIN
    PERFORM public.claim_push_device_registration(
      'push-contract-check-device',
      'webpush:' || jsonb_build_object(
        'endpoint', 'https://127.0.0.1/internal',
        'keys', jsonb_build_object(
          'p256dh', repeat('A', 87),
          'auth', repeat('A', 22)
        )
      )::TEXT
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%approved Apple push endpoint%' THEN
      v_rejected := TRUE;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Untrusted Web Push endpoint was accepted';
  END IF;
END;
$push_contract$;

DO $order_contract$
DECLARE
  v_order_id UUID;
  v_user_id UUID;
  v_trip_id UUID;
  v_observed TEXT;
BEGIN
  -- The block above impersonates a customer to test registration policy, and
  -- set_config(..., TRUE) lasts for the whole transaction. Drop back to an
  -- unauthenticated context before touching trips, whose transition guard
  -- rejects a signed-in non-admin.
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('request.jwt.claims', '', TRUE);

  SELECT o.id, o.user_id INTO v_order_id, v_user_id
  FROM public.orders AS o
  JOIN public.profiles AS p ON p.id = o.user_id AND p.role = 'customer'
  WHERE o.status NOT IN ('Pending Cancellation', 'Cancelled', 'Delivered', 'In Transit')
  ORDER BY o.created_at DESC
  LIMIT 1;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'A customer-owned order is required for the order notification contract check';
  END IF;

  CREATE TEMP TABLE order_contract_seen ON COMMIT DROP AS
    SELECT id FROM public.notifications;

  -- A plain admin status write must produce exactly one customer notification,
  -- inside this transaction, with no help from the browser that started it.
  UPDATE public.orders SET status = 'In Transit' WHERE id = v_order_id;

  SELECT string_agg(n.title, ', ' ORDER BY n.title) INTO v_observed
  FROM public.notifications AS n
  WHERE n.id NOT IN (SELECT id FROM order_contract_seen);
  IF v_observed IS DISTINCT FROM 'Order Updated' THEN
    RAISE EXCEPTION 'Order status change produced [%] instead of one "Order Updated"', COALESCE(v_observed, 'nothing');
  END IF;

  -- And it must reach the durable outbox whenever that customer has a device.
  IF EXISTS (SELECT 1 FROM public.user_device_tokens WHERE user_id = v_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.notification_delivery_jobs AS j
       WHERE j.notification_id IN (
         SELECT n.id FROM public.notifications AS n
         WHERE n.id NOT IN (SELECT id FROM order_contract_seen)
       )
     ) THEN
    RAISE EXCEPTION 'Order notification did not enqueue a device delivery job';
  END IF;

  -- A trip status change updates its orders as a nested write. That path has
  -- its own, more useful trip message; the order trigger must stay silent
  -- rather than adding a second generic one per customer.
  SELECT t.id INTO v_trip_id
  FROM public.trips AS t
  JOIN public.orders AS o ON o.trip_id = t.id
  JOIN public.profiles AS p ON p.id = o.user_id AND p.role = 'customer'
  WHERE t.status = 'scheduled'
    AND NOT EXISTS (
      SELECT 1 FROM public.orders AS blocked
      WHERE blocked.trip_id = t.id AND blocked.status = 'Pending Cancellation'
    )
  GROUP BY t.id
  ORDER BY count(o.id) DESC
  LIMIT 1;

  IF v_trip_id IS NULL THEN
    RAISE EXCEPTION 'A scheduled trip with a customer-owned order is required for the cascade check';
  END IF;

  UPDATE public.orders SET status = 'Picked Up'
   WHERE trip_id = v_trip_id AND status NOT IN ('Cancelled', 'Picked Up');

  DELETE FROM order_contract_seen;
  INSERT INTO order_contract_seen SELECT id FROM public.notifications;

  UPDATE public.trips SET status = 'in_progress' WHERE id = v_trip_id;

  SELECT string_agg(DISTINCT n.type, ', ' ORDER BY n.type) INTO v_observed
  FROM public.notifications AS n
  WHERE n.id NOT IN (SELECT id FROM order_contract_seen);
  IF v_observed IS DISTINCT FROM 'trip_update' THEN
    RAISE EXCEPTION 'Trip cascade produced [%] notification types; expected only trip_update', COALESCE(v_observed, 'none');
  END IF;
END;
$order_contract$;
`;
const sql = `BEGIN;\n${migrations.map(path => readFileSync(path, 'utf8')).join('\n')}\n${behavioralChecks}\nROLLBACK;`;

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const body = await response.json();
if (!response.ok) throw new Error(body?.message || body?.error || JSON.stringify(body));
console.log('Push migrations and core database delivery contracts passed in a rolled-back production transaction.');
