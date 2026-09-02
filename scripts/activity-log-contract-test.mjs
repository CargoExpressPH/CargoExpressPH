import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const migration = read('supabase/migrations/20260902020000_complete_activity_log_module_coverage.sql');
const schema = read('supabase/schema.sql');
const page = read('src/pages/admin/ActivityLogsPage.jsx');
const database = read('src/lib/database.js');
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

assert.match(schema, /CREATE OR REPLACE FUNCTION public\.log_payment_transaction_activity\(\)/);
assert.match(schema, /CREATE TRIGGER payment_transactions_log_activity AFTER INSERT ON payment_transactions/);
assert.match(schema, /CREATE OR REPLACE FUNCTION public\.log_feedback_visibility_activity\(\)/);
assert.match(schema, /CREATE TRIGGER customer_feedback_log_visibility_activity AFTER UPDATE OF is_hidden ON customer_feedback/);

assert.match(database, /if \(module\) query = query\.eq\('module', module\)/);
assert.doesNotMatch(database, /logPayment\(/);
assert.doesNotMatch(feedback, /logActivity\(/);
assert.match(page, /'All', 'Orders', 'Trips', 'Payments', 'Chat', 'Authentication', 'System', 'Sales & Reports', 'Feedback'/);
assert.doesNotMatch(page, /const MODULES = \[[^\]]*'Customers'/);
assert.match(page, /7-day retention period/);

console.log('Activity log contract tests passed.');
