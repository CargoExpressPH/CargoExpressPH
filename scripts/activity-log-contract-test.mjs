import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const migration = read('supabase/migrations/20260902020000_complete_activity_log_module_coverage.sql');
const reliabilityMigration = read('supabase/migrations/20260902030000_reliable_realtime_activity_logs.sql');
const schema = read('supabase/schema.sql');
const page = read('src/pages/admin/ActivityLogsPage.jsx');
const database = read('src/lib/database.js');
const logger = read('src/lib/activityLog.js');
const feedback = read('src/pages/admin/FeedbackPage.jsx');

assert.match(migration, /CREATE OR REPLACE FUNCTION public\.log_payment_transaction_activity\(\)/);
assert.match(migration, /AFTER INSERT ON public\.payment_transactions/);
assert.match(migration, /'Payments'/);
assert.match(migration, /'payment',\s*NEW\.id/);
assert.match(migration, /NEW\.record_type = 'order'/);
assert.match(migration, /existing\.record_type = 'payment'/);
assert.match(migration, /RETURN NULL/);
assert.match(migration, /t\.created_at >= now\(\) - INTERVAL '7 days'/);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.log_feedback_visibility_activity\(\)/);
assert.match(migration, /AFTER UPDATE OF is_hidden ON public\.customer_feedback/);
assert.match(migration, /'Feedback'/);
assert.match(migration, /IS NOT DISTINCT FROM/);

assert.match(reliabilityMigration, /ADD COLUMN IF NOT EXISTS client_event_id UUID/);
assert.match(reliabilityMigration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_logs_actor_client_event/);
assert.match(reliabilityMigration, /CREATE OR REPLACE FUNCTION public\.record_activity\(/);
assert.match(reliabilityMigration, /ON CONFLICT \(admin_id, client_event_id\) DO NOTHING/);
assert.match(reliabilityMigration, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.activity_logs/);
assert.match(reliabilityMigration, /GRANT EXECUTE ON FUNCTION public\.record_activity[\s\S]*TO authenticated/);

assert.match(schema, /CREATE OR REPLACE FUNCTION public\.log_payment_transaction_activity\(\)/);
assert.match(schema, /CREATE TRIGGER payment_transactions_log_activity AFTER INSERT ON payment_transactions/);
assert.match(schema, /CREATE OR REPLACE FUNCTION public\.log_feedback_visibility_activity\(\)/);
assert.match(schema, /CREATE TRIGGER customer_feedback_log_visibility_activity AFTER UPDATE OF is_hidden ON customer_feedback/);
assert.match(schema, /client_event_id UUID/);
assert.match(schema, /CREATE OR REPLACE FUNCTION public\.record_activity\(/);
assert.match(schema, /ADD TABLE IF NOT EXISTS public\.activity_logs/);

assert.match(database, /if \(module\) query = query\.eq\('module', module\)/);
assert.match(database, /export const getActivityLogsForExport/);
assert.match(database, /const batchSize = 1000/);
assert.match(database, /\.order\('id', \{ ascending: false \}\)/);
assert.match(database, /created_at\.lt\.\$\{cursor\.created_at\}/);
assert.doesNotMatch(database, /logPayment\(/);
assert.doesNotMatch(feedback, /logActivity\(/);
assert.match(logger, /cargoexpress\.activity-log\.queue\.v1/);
assert.match(logger, /supabase\.rpc\('record_activity'/);
assert.match(logger, /window\.addEventListener\('online'/);
assert.match(logger, /ON CONFLICT|idempotency key/);
assert.match(page, /'All', 'Orders', 'Trips', 'Payments', 'Chat', 'Authentication', 'System', 'Sales & Reports', 'Feedback'/);
assert.doesNotMatch(page, /const MODULES = \[[^\]]*'Customers'/);
assert.match(page, /7-day retention period/);
assert.match(page, /table: 'activity_logs'/);
assert.match(page, /event: '\*'/);
assert.match(page, /window\.addEventListener\('online'/);
assert.match(page, /setInterval\(scheduleRefresh, 60000\)/);
assert.match(page, /getActivityLogsForExport/);
assert.match(page, /Exporting all\.\.\./);
assert.match(page, /\^\[=\+\\-@\\t\\r\]/);
assert.doesNotMatch(page, /aria-label="Refresh activity logs"/);

console.log('Activity log contract tests passed.');
