import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const sender = read('supabase/functions/send-push/index.ts');
const worker = read('supabase/functions/process-push-deliveries/index.ts');
const inquiry = read('supabase/functions/submit-inquiry/index.ts');
const database = read('src/lib/database.js');
const adminLayout = read('src/components/layout/AdminLayout.jsx');
const adminProfile = read('src/pages/admin/ProfilePage.jsx');
const pushHook = read('src/hooks/usePushNotification.js');
const pushLifecycle = read('src/lib/push-notifications.js');
const outboxMigration = read('supabase/migrations/20260904235457_complete_push_delivery_system.sql');
const registrationMigration = read('supabase/migrations/20260904235511_secure_push_registrations_and_policies.sql');
const coverageMigration = read('supabase/migrations/20260904235517_server_notification_event_coverage.sql');
const orderAtomicityMigration = read('supabase/migrations/20260905003149_complete_order_notification_atomicity.sql');
const paymentCopyMigration = read('supabase/migrations/20260905223244_improve_payment_notification_copy.sql');
const orderDetailPage = read('src/pages/admin/OrderDetailPage.jsx');

assert.ok(existsSync('supabase/functions/process-push-deliveries/index.ts'));
assert.match(sender, /hostname\.endsWith\('\.push\.apple\.com'\)/);
assert.match(sender, /redirect:\s*'error'/);
assert.match(sender, /AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/);
assert.match(sender, /claim_notification_delivery_job/);
assert.match(sender, /complete_notification_delivery_job/);
assert.match(sender, /authHeader !== `Bearer \$\{serviceRoleKey\}`/);
assert.doesNotMatch(sender, /await fetch\(endpoint/);
// Only Firebase's provider-specific FcmError shape identifies an invalid
// registration token. A google.rpc.BadRequest payload error must keep devices.
assert.match(sender, /google\.firebase\.fcm\.v1\.FcmError/);
assert.match(sender, /const invalidRegistration = code === 'INVALID_ARGUMENT'/);
assert.match(sender, /const permanent = stale \|\| err\.status === 'INVALID_ARGUMENT'/);
assert.match(sender, /Service authentication required/);
assert.match(sender, /trustedNotificationPath/);
assert.match(sender, /case 'payment_update':[\s\S]{0,160}\/customer\/orders/);
assert.match(sender, /case 'chat_message':[\s\S]{0,80}\/customer\/support/);
assert.match(sender, /case 'inquiry':[\s\S]{0,80}\/admin\/contact-inquiries/);

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

// Each successful ledger entry must tell the customer what changed. This also
// prevents two same-value payment events from looking like accidental copies:
// the balance is captured when each notification is created.
assert.match(paymentCopyMigration, /'Payment Received'/);
assert.match(paymentCopyMigration, /'Payment Complete'/);
assert.match(paymentCopyMigration, /We received your payment of %s for order %s/);
assert.match(paymentCopyMigration, /Remaining balance: %s\./);
assert.match(paymentCopyMigration, /Your order is now fully paid\./);
assert.match(paymentCopyMigration, /COALESCE\(NEW\.amount, 0\)/);
assert.match(paymentCopyMigration, /COALESCE\(v_order\.remaining_balance, 0\)/);
assert.match(paymentCopyMigration, /SECURITY DEFINER[\s\S]*SET search_path = ''/);
assert.doesNotMatch(paymentCopyMigration, /Open the app/);

assert.doesNotMatch(inquiry, /fetch\(pushUrl/);
assert.doesNotMatch(database, /functions\.invoke\('send-push'/);
assert.doesNotMatch(database, /invokePushWithRetry/);
assert.doesNotMatch(adminLayout, /setTimeout\([\s\S]{0,500}Notification\.requestPermission/);
assert.match(adminLayout, /usePushNotification\(user\?\.id, handleForegroundPush\)/);
assert.match(adminLayout, /onClick=\{handleNotificationBellClick\}/);
// Reading the inbox must never double as consent to browser push. Admins get
// the same explicit per-device control as customers on their Profile page.
assert.doesNotMatch(adminLayout, /handleNotificationBellClick[\s\S]{0,500}enablePush/);
assert.match(adminProfile, /Push Notifications/);
assert.match(adminProfile, /onChange=\{\(event\) => handlePushToggle\(event\.target\.checked\)\}/);
assert.match(pushHook, /onForegroundMessage/);
assert.match(pushLifecycle, /usesAppleWebPush/);
assert.match(pushLifecycle, /isSafariBrowser/);
// Safari on a Mac takes the Apple path without being an iOS device. Reporting
// it as one makes About/Version tell desktop users to Add to Home Screen, and
// call push unsupported, while it is in fact working.
assert.doesNotMatch(pushLifecycle, /isIosDevice: true/);
assert.match(pushLifecycle, /isIosDevice: ios,/);

console.log('Push notification contract tests passed.');
