import assert from 'node:assert/strict';
import 'dotenv/config';

const token = process.env.SUPABASE_ACCESS_TOKEN
  || process.env.SUPABASE_PERSONAL_ACCESS_TOKEN
  || process.env.supabase_PAT;
const projectUrl = process.env.VITE_SUPABASE_URL || '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const projectRef = new URL(projectUrl).hostname.split('.')[0];
assert.ok(token && projectRef && anonKey, 'Supabase PAT, project URL, or anon key is missing');

const managementQuery = async sql => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.message || body?.error || JSON.stringify(body));
  return body;
};

const functionsResponse = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/functions`, {
  headers: { Authorization: `Bearer ${token}` },
});
const deployedFunctions = await functionsResponse.json();
assert.ok(functionsResponse.ok, 'Unable to list deployed Edge Functions');
for (const expected of [
  ['send-push', 46, true],
  ['process-push-deliveries', 1, true],
  ['submit-inquiry', 13, false],
]) {
  const [slug, minimumVersion, verifyJwt] = expected;
  const deployed = deployedFunctions.find(item => item.slug === slug);
  assert.ok(deployed, `${slug} is not deployed`);
  assert.equal(deployed.status, 'ACTIVE', `${slug} is not active`);
  assert.ok(deployed.version >= minimumVersion, `${slug} deployment is older than expected`);
  assert.equal(deployed.verify_jwt, verifyJwt, `${slug} has the wrong JWT gateway setting`);
}

const checks = await managementQuery(`
  SELECT 'migrations' AS check_name, count(*)::int AS value
  FROM supabase_migrations.schema_migrations
  WHERE version IN ('20260904235457', '20260904235511', '20260904235517', '20260905003149', '20260905051734')
  UNION ALL
  SELECT 'order_notify_trigger', count(*)::int
  FROM pg_trigger WHERE tgname = 'orders_notify_customer_of_change' AND NOT tgisinternal
  UNION ALL
  SELECT 'worker_cron', count(*)::int FROM cron.job
  WHERE jobname = 'process_push_deliveries' AND active
  UNION ALL
  SELECT 'purge_cron', count(*)::int FROM cron.job
  WHERE jobname = 'purge_old_notification_delivery_jobs' AND active
  UNION ALL
  SELECT 'health_monitor_cron', count(*)::int FROM cron.job
  WHERE jobname = 'monitor_push_delivery_health' AND active
  UNION ALL
  SELECT 'outbox_trigger', count(*)::int
  FROM pg_trigger WHERE tgname = 'notifications_enqueue_delivery_jobs' AND NOT tgisinternal
  UNION ALL
  SELECT 'delivery_jobs', count(*)::int FROM public.notification_delivery_jobs
  UNION ALL
  SELECT 'ready_jobs', count(*)::int FROM public.notification_delivery_jobs
  WHERE status IN ('pending', 'retry') AND available_at <= now()
  UNION ALL
  SELECT 'stuck_jobs', count(*)::int FROM public.notification_delivery_jobs
  WHERE status = 'processing' AND claimed_at < now() - interval '5 minutes';
`);
const values = Object.fromEntries(checks.map(row => [row.check_name, Number(row.value)]));
assert.equal(values.migrations, 5, 'Push migrations are not fully applied');
assert.equal(values.order_notify_trigger, 1, 'Order lifecycle notification trigger is not active');
assert.equal(values.worker_cron, 1, 'Push worker cron is not active');
assert.equal(values.purge_cron, 1, 'Push retention cron is not active');
assert.equal(values.health_monitor_cron, 1, 'Push health monitor cron is not active');
assert.equal(values.outbox_trigger, 1, 'Notification outbox trigger is not active');
assert.equal(values.stuck_jobs, 0, 'Push delivery jobs are stuck in processing');

const unauthorizedWorker = await fetch(`${projectUrl}/functions/v1/process-push-deliveries`, {
  method: 'POST',
  headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ limit: 1 }),
});
assert.equal(unauthorizedWorker.status, 401, 'Push worker accepted a public caller');

const unauthorizedSender = await fetch(`${projectUrl}/functions/v1/send-push`, {
  method: 'POST',
  headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
assert.equal(unauthorizedSender.status, 401, 'Push sender accepted a public caller');

const statusRows = await managementQuery(`
  SELECT status, count(*)::int AS count
  FROM public.notification_delivery_jobs
  GROUP BY status ORDER BY status;
`);
const statuses = Object.fromEntries(statusRows.map(row => [row.status, Number(row.count)]));
assert.equal(statuses.dead || 0, 0, 'One or more push jobs reached the dead-letter state');
console.log(`Push production verification passed (${values.delivery_jobs} jobs; ${values.ready_jobs} ready; statuses=${JSON.stringify(statuses)}).`);
