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

const query = async sql => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
  return body;
};

const result = await query(`
  SELECT 'duplicate_announcement' AS check_name, count(*)::int AS problem_count
  FROM (
    SELECT user_id, reference_id FROM public.notifications
    WHERE type = 'announcement' GROUP BY user_id, reference_id HAVING count(*) > 1
  ) AS duplicates
  UNION ALL
  SELECT 'duplicate_new_booking', count(*)::int
  FROM (
    SELECT user_id, reference_id FROM public.notifications
    WHERE type = 'order_update' AND title = 'New Booking'
    GROUP BY user_id, reference_id HAVING count(*) > 1
  ) AS duplicates
  UNION ALL
  SELECT 'duplicate_booking_received', count(*)::int
  FROM (
    SELECT user_id, reference_id FROM public.notifications
    WHERE type = 'general' AND title = 'Booking Received'
    GROUP BY user_id, reference_id HAVING count(*) > 1
  ) AS duplicates
  UNION ALL
  SELECT 'duplicate_feedback', count(*)::int
  FROM (
    SELECT user_id, reference_id FROM public.notifications
    WHERE type = 'feedback' AND title = 'New Customer Feedback'
    GROUP BY user_id, reference_id HAVING count(*) > 1
  ) AS duplicates
  UNION ALL
  SELECT 'null_order_users', count(*)::int FROM public.orders WHERE user_id IS NULL
  UNION ALL
  SELECT 'invalid_notification_types', count(*)::int FROM public.notifications
  WHERE type NOT IN ('order_update','trip_update','announcement','general','inquiry','feedback','chat_message','system_alert','payment_update')
  UNION ALL
  -- The migration currently being rolled out. Already-recorded earlier
  -- versions are fine and expected; only re-applying the pending one is not.
  SELECT 'target_migration_already_applied', count(*)::int
  FROM supabase_migrations.schema_migrations
  WHERE version = '20260905003149';
`);

for (const row of result) console.log(`${row.check_name}: ${row.problem_count}`);
const migrationState = result.find(row => row.check_name === 'target_migration_already_applied');
assert.ok(Number(migrationState?.problem_count || 0) <= 1, 'Target migration history is inconsistent');
const problems = result.filter(row => (
  row.check_name !== 'target_migration_already_applied'
  && Number(row.problem_count) > 0
));
assert.equal(problems.length, 0, `Push migration preflight failed: ${problems.map(row => row.check_name).join(', ')}`);
console.log(`Push database preflight passed (target migration ${Number(migrationState?.problem_count || 0) ? 'already applied' : 'pending'}).`);
