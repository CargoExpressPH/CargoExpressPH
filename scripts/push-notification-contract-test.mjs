import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const sender = read('supabase/functions/send-push/index.ts');
const worker = read('supabase/functions/process-push-deliveries/index.ts');
const inquiry = read('supabase/functions/submit-inquiry/index.ts');
const database = read('src/lib/database.js');
const adminLayout = read('src/components/layout/AdminLayout.jsx');
const pushHook = read('src/hooks/usePushNotification.js');
const pushLifecycle = read('src/lib/push-notifications.js');
const outboxMigration = read('supabase/migrations/20260904235457_complete_push_delivery_system.sql');
const registrationMigration = read('supabase/migrations/20260904235511_secure_push_registrations_and_policies.sql');
const coverageMigration = read('supabase/migrations/20260904235517_server_notification_event_coverage.sql');
const orderAtomicityMigration = read('supabase/migrations/20260905003149_complete_order_notification_atomicity.sql');
const orderDetailPage = read('src/pages/admin/OrderDetailPage.jsx');

assert.ok(existsSync('supabase/functions/process-push-deliveries/index.ts'));
assert.match(sender, /hostname\.endsWith\('\.push\.apple\.com'\)/);
assert.match(sender, /redirect:\s*'error'/);
assert.match(sender, /AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/);
assert.match(sender, /claim_notification_delivery_job/);
assert.match(sender, /complete_notification_delivery_job/);
assert.match(sender, /authHeader === `Bearer \$\{serviceRoleKey\}`/);
assert.doesNotMatch(sender, /await fetch\(endpoint/);

assert.match(worker, /claim_notification_delivery_jobs/);
assert.match(worker, /CONCURRENCY = 5/);
assert.match(worker, /retry_scheduled/);
assert.match(outboxMigration, /AFTER INSERT ON public\.notifications/);
assert.match(outboxMigration, /FOR UPDATE SKIP LOCKED/);
assert.match(outboxMigration, /attempt_count >= 5/);
assert.match(outboxMigration, /cron\.schedule\([\s\S]*process_push_deliveries/);

assert.match(registrationMigration, /approved Apple push endpoint/);
assert.match(registrationMigration, /REVOKE INSERT, UPDATE ON TABLE public\.user_device_tokens FROM authenticated/);
assert.match(registrationMigration, /p256dh !~ '\^\[A-Za-z0-9_-\]\{87\}\$'/);

for (const trigger of [
  'orders_notify_new_booking',
  'announcements_notify_customers',
  'customer_feedback_notify_admins',
  'zz_chat_messages_notify_humans',
  'zz_payment_transactions_notify_customer',
  'payment_attempts_notify_failure',
  'trips_cascade_status_and_notify',
  'trips_notify_reschedule',
]) {
  assert.match(coverageMigration, new RegExp(trigger));
}

// Order lifecycle events belong to the transaction that changes the order, not
// to whichever admin tab happened to be open. The trigger only earns that if it
// also stays quiet for the nested writes a trip cascade makes.
assert.match(orderAtomicityMigration, /orders_notify_customer_of_change/);
assert.match(orderAtomicityMigration, /AFTER UPDATE OF user_id, service_area_status, trip_id, status/);
assert.match(orderAtomicityMigration, /pg_trigger_depth\(\) > 1/);
assert.match(orderAtomicityMigration, /'Pending Cancellation'/);
assert.doesNotMatch(orderDetailPage, /await createNotification\(/);
assert.doesNotMatch(database, /await createNotification\(/);

assert.doesNotMatch(inquiry, /fetch\(pushUrl/);
assert.doesNotMatch(database, /functions\.invoke\('send-push'/);
assert.doesNotMatch(database, /invokePushWithRetry/);
assert.doesNotMatch(adminLayout, /setTimeout\([\s\S]{0,500}Notification\.requestPermission/);
assert.match(adminLayout, /usePushNotification\(user\?\.id, handleForegroundPush\)/);
assert.match(adminLayout, /onClick=\{handleNotificationBellClick\}/);
// The bell is the admin's only way to opt in, and signing out deletes the
// device row while leaving browser permission granted. Gating the click on
// permission alone strands every admin who logs out and back in.
assert.doesNotMatch(adminLayout, /permissionState !== 'default'/);
assert.match(adminLayout, /permissionState === 'denied' \|\| isSubscribed/);
assert.match(pushHook, /onForegroundMessage/);
assert.match(pushLifecycle, /usesAppleWebPush/);
assert.match(pushLifecycle, /isSafariBrowser/);

console.log('Push notification contract tests passed.');
