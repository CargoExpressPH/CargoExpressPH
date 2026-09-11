// Payment-confirmation notification regression tests (BUG-02 fix).
// See PAYMENT_NOTIFICATION_FIX_REPORT.md for the full analysis.
//
// Runs the ACTUAL migration files in supabase/migrations verbatim (the same
// three BUG-01 migrations the payment-ledger suite uses, plus the new
// 20260909120000 notification-hardening migration) against a real embedded
// Postgres (PGlite), on top of a hand-built harness: the existing
// payment-ledger-pgtest base schema plus notification-harness-additions.sql,
// whose function bodies are verbatim copies of what is live in production
// today (fetched via pg_get_functiondef against the linked project on
// 2026-09-09) — not a reimplementation.
//
// Known limitation (shared with payment-ledger-pgtest): PGlite serializes all
// transactions through one connection, so the "concurrent" scenario proves
// the trigger/RPC logic is correct once Postgres's own row lock has
// serialized two callers — it does not exercise true multi-backend lock
// contention. See the report for what remains unverified.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..');

const db = new PGlite();

let passed = 0, failed = 0;
const failures = [];

function ok(desc, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${desc}`); }
  else { failed++; failures.push(desc); console.log(`  FAIL - ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function asUser(uid, role, fn) {
  return db.transaction(async (tx) => {
    const pgRole = role || 'authenticated';
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', $2, true)`, [uid || '', pgRole]);
    // Actually become this Postgres role (not just set the app.role stand-in
    // GUC) so RLS policies are evaluated for real, the same way Supabase's
    // PostgREST/Auth layer always connects as 'authenticated' or
    // 'service_role' and lets row_security decide the rest. Every RPC called
    // under asUser() is SECURITY DEFINER, so it still runs with its definer's
    // privileges regardless of this — only a raw table query issued while
    // "as" a user is affected, which is exactly what the RLS test below relies on.
    await tx.query(`SET LOCAL ROLE ${pgRole}`);
    return fn(tx);
  });
}

console.log('== Loading base harness schema (payment-ledger-pgtest) ==');
await db.exec(readFileSync(path.join(REPO, 'scripts/payment-ledger-pgtest/harness-schema.sql'), 'utf8'));

console.log('== Loading notification-system harness additions ==');
await db.exec(readFileSync(path.join(HERE, 'notification-harness-additions.sql'), 'utf8'));

console.log('== Applying real migrations verbatim ==');
const migrations = [
  '20260909010000_payment_ledger_integrity_columns.sql',
  '20260909020000_fix_paymongo_reconciliation_idempotency.sql',
  '20260909030000_manual_payment_hardening.sql',
  '20260909120000_payment_confirmation_notification_hardening.sql',
  '20260911130000_secure_paymongo_order_metadata.sql',
];
for (const m of migrations) {
  const sql = readFileSync(path.join(REPO, 'supabase/migrations', m), 'utf8');
  try {
    await db.exec(sql);
    console.log(`  applied ${m}`);
  } catch (e) {
    console.error(`  ERROR applying ${m}:`, e.message);
    process.exit(1);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────
const ADMIN_ID  = '00000000-0000-0000-0000-000000000001';
const CUST_A_ID = '00000000-0000-0000-0000-000000000002';
const CUST_B_ID = '00000000-0000-0000-0000-000000000003';

await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer A', 'customer')`, [CUST_A_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer B', 'customer')`, [CUST_B_ID]);

async function newOrder(tracking, shippingCost = 1000, userId = CUST_A_ID) {
  const r = await db.query(
    `INSERT INTO orders (tracking_number, shipping_cost, status, user_id) VALUES ($1, $2, 'Assigned', $3) RETURNING id`,
    [tracking, shippingCost, userId]
  );
  return r.rows[0].id;
}

async function newAttempt(sourceId, orderId, amount, paymentType = 'full') {
  await db.query(
    `INSERT INTO payment_attempts (source_id, order_id, amount, payment_type, status) VALUES ($1,$2,$3,$4,'pending')`,
    [sourceId, orderId, amount, paymentType]
  );
}

async function reconcile(sourceId, paymentId, amount, status = 'paid') {
  return asUser(null, 'service_role', (tx) =>
    tx.query(`SELECT * FROM reconcile_paymongo_payment_attempt($1,$2,$3,$4)`, [sourceId, paymentId, amount, status])
  );
}

async function pickupCash(orderId, amount, opts = {}) {
  return asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(
      `SELECT * FROM record_pickup_payment($1, 10, 'cash', 'sender', '[]'::jsonb, $2, $3, NULL, CURRENT_DATE, NULL, 'Initial Payment', 'pickup cash', $4, false)`,
      [orderId, opts.promiseDate ?? null, amount, opts.idempotencyKey ?? null]
    )
  );
}

async function additionalGcash(orderId, amount, reference, idempotencyKey = null) {
  return asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(
      `SELECT * FROM record_additional_payment($1, $2, 'gcash', $3, 'settle', CURRENT_DATE, NULL, $4, true)`,
      [orderId, amount, reference, idempotencyKey]
    )
  );
}

async function paymentNotifications(orderId) {
  const r = await db.query(
    `SELECT id, user_id, title, message, reference_id, payment_transaction_id
       FROM notifications
      WHERE type = 'payment_update' AND reference_id = $1
      ORDER BY created_at`,
    [orderId]
  );
  return r.rows;
}

let customerSeq = 0;
async function newCustomer(name) {
  customerSeq += 1;
  const id = `00000000-0000-0000-0000-0000000009${String(customerSeq).padStart(2, '0')}`;
  await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, $2, 'customer')`, [id, name]);
  return id;
}

async function registerDevice(userId, token) {
  const r = await db.query(
    `INSERT INTO user_device_tokens (user_id, token) VALUES ($1, $2) RETURNING id`,
    [userId, token]
  );
  return r.rows[0].id;
}

async function deliveryJobsFor(notificationId) {
  const r = await db.query(
    `SELECT * FROM notification_delivery_jobs WHERE notification_id = $1 ORDER BY device_token_id NULLS LAST`,
    [notificationId]
  );
  return r.rows;
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== Scenario: a successful pickup payment creates exactly one in-app notification ==');
{
  const orderId = await newOrder('NTF-001', 1000);
  await pickupCash(orderId, 400);
  const notifs = await paymentNotifications(orderId);
  ok('exactly one payment_update notification', notifs.length === 1, notifs.length);
  ok('notification belongs to the order\'s customer, not the admin', notifs[0]?.user_id === CUST_A_ID);
  ok('reference_id is the order id (so the customer app can navigate to it)', notifs[0]?.reference_id === orderId);
  ok('message states THIS payment\'s amount (₱400.00), not any cumulative figure', /₱400\.00/.test(notifs[0]?.message || ''));
  ok('message names the payment method (cash)', /cash/i.test(notifs[0]?.message || ''));
  ok('message states the remaining balance after this payment (₱600.00)', /₱600\.00/.test(notifs[0]?.message || ''));
  ok('title is "Payment Received" for a partial payment', notifs[0]?.title === 'Payment Received');
}

console.log('\n== Scenario: a full payment says the order is fully paid, not "delivered" ==');
{
  const orderId = await newOrder('NTF-002', 500);
  await pickupCash(orderId, 500);
  const notifs = await paymentNotifications(orderId);
  ok('exactly one notification for a single full payment', notifs.length === 1, notifs.length);
  ok('title is "Payment Complete" once the balance reaches zero', notifs[0]?.title === 'Payment Complete');
  ok('message says fully paid, and does not mention delivery/dispatch', /fully paid/i.test(notifs[0]?.message) && !/deliver/i.test(notifs[0]?.message));
}

console.log('\n== Scenario: manual GCash transfer and PayMongo GCash are labeled differently ==');
{
  const orderIdManual = await newOrder('NTF-003A', 1000);
  await pickupCash(orderIdManual, 0, { promiseDate: '2030-01-01' });
  await additionalGcash(orderIdManual, 1000, 'GC-LABEL-1');
  const manualNotifs = await paymentNotifications(orderIdManual);
  ok('manual GCash transfer is labeled "GCash transfer"', /GCash transfer/.test(manualNotifs[0]?.message || ''), manualNotifs[0]?.message);

  const orderIdAuto = await newOrder('NTF-003B', 1000);
  await newAttempt('src_ntf_003b', orderIdAuto, 1000);
  await reconcile('src_ntf_003b', 'pay_ntf_003b', 1000, 'paid');
  const autoNotifs = await paymentNotifications(orderIdAuto);
  ok('automatic PayMongo GCash is labeled plain "GCash" (not "transfer")', /\bGCash\b(?! transfer)/.test(autoNotifs[0]?.message || ''), autoNotifs[0]?.message);
}

console.log('\n== Scenario: a repeated payment request (same idempotency key) creates NO additional notification ==');
{
  const orderId = await newOrder('NTF-004', 1000);
  await pickupCash(orderId, 0, { promiseDate: '2030-01-01' });
  const idem = '11111111-1111-1111-1111-000000000004';
  await additionalGcash(orderId, 1000, 'GC-IDEM-4', idem);
  await additionalGcash(orderId, 1000, 'GC-IDEM-4', idem); // double-click retry
  await additionalGcash(orderId, 1000, 'GC-IDEM-4', idem); // dropped-response retry
  const notifs = await paymentNotifications(orderId);
  ok('three submissions with the same idempotency key produce ONE notification', notifs.length === 1, notifs.length);
}

console.log('\n== Scenario: a repeated/redelivered PayMongo webhook creates NO additional notification ==');
{
  const orderId = await newOrder('NTF-005', 750);
  await newAttempt('src_ntf_005', orderId, 750);
  await reconcile('src_ntf_005', 'pay_ntf_005', 750, 'paid');
  await reconcile('src_ntf_005', 'pay_ntf_005', 750, 'paid'); // redelivered webhook
  await reconcile('src_ntf_005', 'pay_ntf_005', 750, 'paid'); // redelivered again
  const notifs = await paymentNotifications(orderId);
  ok('a redelivered webhook for an already-reconciled payment creates no extra notification', notifs.length === 1, notifs.length);
}

console.log('\n== Scenario: concurrent processing of the same payment still creates ONE notification ==');
{
  const orderId = await newOrder('NTF-006', 500);
  await newAttempt('src_ntf_006', orderId, 500);
  await Promise.all([
    reconcile('src_ntf_006', 'pay_ntf_006', 500, 'paid'),
    reconcile('src_ntf_006', 'pay_ntf_006', 500, 'paid'),
  ]);
  const notifs = await paymentNotifications(orderId);
  ok('two concurrent reconcile calls for the same payment produce ONE notification', notifs.length === 1, notifs.length);
}

console.log('\n== Scenario: two legitimate payments on the same order create TWO notifications, even with matching amounts ==');
{
  const orderId = await newOrder('NTF-007', 1000);
  await newAttempt('src_ntf_007a', orderId, 500);
  await reconcile('src_ntf_007a', 'pay_ntf_007a', 500, 'paid');
  await newAttempt('src_ntf_007b', orderId, 500);
  await reconcile('src_ntf_007b', 'pay_ntf_007b', 500, 'paid');
  const notifs = await paymentNotifications(orderId);
  ok('two distinct ₱500 payments produce two distinct notifications', notifs.length === 2, notifs.length);
  ok('each notification is tied to a different payment_transactions row', notifs[0].payment_transaction_id !== notifs[1].payment_transaction_id);
  ok('the first payment\'s notification reports a remaining balance (₱500.00), not zero', /₱500\.00/.test(notifs[0].message));
  ok('the second (final) payment\'s notification reports the order fully paid', /fully paid/i.test(notifs[1].message));
}

console.log('\n== Scenario: a failed/pending/ambiguous PayMongo response creates NO notification ==');
{
  const orderId = await newOrder('NTF-008', 300);
  await newAttempt('src_ntf_008', orderId, 300);
  await reconcile('src_ntf_008', null, 300, 'pending'); // status-check only, no capture
  const notifs = await paymentNotifications(orderId);
  ok('no payment_id (not actually captured) creates no notification', notifs.length === 0, notifs.length);
}

console.log('\n== Scenario: an unverified manual GCash entry creates NO notification (rejected before the ledger insert) ==');
{
  const orderId = await newOrder('NTF-009', 500);
  await pickupCash(orderId, 0, { promiseDate: '2030-01-01' });
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_additional_payment($1, 500, 'gcash', 'REF-UNVERIFIED-9', NULL, CURRENT_DATE, NULL, NULL, false)`, [orderId])
    );
  } catch (e) {
    rejected = /verified receipt/.test(e.message);
  }
  ok('the unverified submission was rejected server-side', rejected);
  const notifs = await paymentNotifications(orderId);
  ok('no notification exists for the rejected, unverified submission', notifs.length === 0, notifs.length);
}

console.log('\n== Scenario: a zero-payment action (promise date only, no money) creates NO notification ==');
{
  const orderId = await newOrder('NTF-010', 1000);
  await pickupCash(orderId, 0, { promiseDate: '2030-06-01' });
  const notifs = await paymentNotifications(orderId);
  ok('setting a promised payment date with no money collected creates no payment confirmation', notifs.length === 0, notifs.length);
}

console.log('\n== Scenario: the correct customer receives the notification (not the admin, not another customer) ==');
{
  const orderIdA = await newOrder('NTF-011A', 500, CUST_A_ID);
  const orderIdB = await newOrder('NTF-011B', 500, CUST_B_ID);
  await pickupCash(orderIdA, 500);
  await pickupCash(orderIdB, 500);
  const notifsA = await paymentNotifications(orderIdA);
  const notifsB = await paymentNotifications(orderIdB);
  ok('Customer A\'s order notification is addressed to Customer A', notifsA[0]?.user_id === CUST_A_ID);
  ok('Customer B\'s order notification is addressed to Customer B, not Customer A', notifsB[0]?.user_id === CUST_B_ID);
  ok('no notification was created for the admin who recorded the payments', (await db.query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'payment_update'`, [ADMIN_ID]
  )).rows[0].n === 0);
}

console.log('\n== Scenario: a customer cannot read another customer\'s payment notification (RLS) ==');
{
  const orderId = await newOrder('NTF-012', 500, CUST_A_ID);
  await pickupCash(orderId, 500);
  const asA = await asUser(CUST_A_ID, 'authenticated', (tx) =>
    tx.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE reference_id = $1`, [orderId])
  );
  const asB = await asUser(CUST_B_ID, 'authenticated', (tx) =>
    tx.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE reference_id = $1`, [orderId])
  );
  ok('Customer A (the order owner) can see the notification via RLS', asA.rows[0].n === 1);
  ok('Customer B (not the order owner) sees zero rows for the same query under RLS', asB.rows[0].n === 0);
}

console.log('\n== Scenario: no registered device still results in an in-app notification (skipped delivery job, not blocked) ==');
{
  const cust = await newCustomer('No-Device Customer');
  const orderId = await newOrder('NTF-013', 500, cust);
  await pickupCash(orderId, 500);
  const notifs = await paymentNotifications(orderId);
  ok('the in-app notification exists even with zero registered devices', notifs.length === 1);
  const jobs = await deliveryJobsFor(notifs[0].id);
  ok('exactly one delivery-job placeholder was created', jobs.length === 1, jobs.length);
  ok('that placeholder is a terminal "skipped" job, not a stuck pending retry', jobs[0].status === 'skipped' && jobs[0].device_token_id === null);
}

console.log('\n== Scenario: one notification fans out to multiple registered devices without duplicating the in-app notification ==');
{
  const cust = await newCustomer('Two-Device Customer');
  const orderId = await newOrder('NTF-014', 500, cust);
  await registerDevice(cust, 'device-token-A1');
  await registerDevice(cust, 'device-token-A2');
  await pickupCash(orderId, 500);
  const notifs = await paymentNotifications(orderId);
  ok('still exactly ONE in-app notification for two devices', notifs.length === 1);
  const jobs = await deliveryJobsFor(notifs[0].id);
  ok('exactly TWO delivery jobs were fanned out, one per device', jobs.length === 2, jobs.length);
  ok('both delivery jobs start pending (ready for the async push worker)', jobs.every(j => j.status === 'pending'));
}

console.log('\n== Scenario: a push failure leaves the payment intact and the delivery retryable ==');
{
  const cust = await newCustomer('Push-Failure Customer');
  const orderId = await newOrder('NTF-015', 500, cust);
  await registerDevice(cust, 'device-token-A15');
  await pickupCash(orderId, 500);
  const notifs = await paymentNotifications(orderId);
  const before = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total FROM payment_transactions WHERE order_id=$1`, [orderId]);

  const claimed = await db.query(
    `SELECT * FROM claim_notification_delivery_jobs(10) WHERE notification_id = $1`, [notifs[0].id]
  );
  ok('the pending delivery job was claimed', claimed.rows.length === 1);
  const outcome = await db.query(
    `SELECT complete_notification_delivery_job($1, $2, 'retry', 'simulated push-provider outage') AS status`,
    [claimed.rows[0].job_id, claimed.rows[0].job_claim_id]
  );
  ok('the failed delivery is marked retryable, not abandoned', outcome.rows[0].status === 'retry');

  const after = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total FROM payment_transactions WHERE order_id=$1`, [orderId]);
  ok('the payment ledger is completely untouched by the push failure', after.rows[0].n === before.rows[0].n && Number(after.rows[0].total) === Number(before.rows[0].total));
  const job = await db.query(`SELECT status, available_at > now() AS scheduled_in_future FROM notification_delivery_jobs WHERE id = $1`, [claimed.rows[0].job_id]);
  ok('the job is scheduled for a future retry rather than dropped', job.rows[0].status === 'retry' && job.rows[0].scheduled_in_future);
}

console.log('\n== Scenario: retrying a delivery does not create a duplicate delivery job for the same notification+device ==');
{
  const cust = await newCustomer('Retry Customer');
  const orderId = await newOrder('NTF-016', 500, cust);
  await registerDevice(cust, 'device-token-A16');
  await pickupCash(orderId, 500);
  const notifs = await paymentNotifications(orderId);

  for (let i = 0; i < 3; i++) {
    // Force the job "available now" between iterations to simulate time
    // passing past its exponential-backoff window (already-existing,
    // unmodified retry-pacing logic in complete_notification_delivery_job) —
    // what this test actually checks is job IDENTITY across repeated
    // claim/retry cycles, not the backoff timing itself.
    await db.query(`UPDATE notification_delivery_jobs SET available_at = now() WHERE notification_id = $1`, [notifs[0].id]);
    const claimed = await db.query(`SELECT * FROM claim_notification_delivery_jobs(10) WHERE notification_id = $1`, [notifs[0].id]);
    if (claimed.rows.length) {
      await db.query(`SELECT complete_notification_delivery_job($1, $2, 'retry', 'transient failure')`, [claimed.rows[0].job_id, claimed.rows[0].job_claim_id]);
    }
  }
  const jobs = await deliveryJobsFor(notifs[0].id);
  ok('three claim/retry cycles still leave exactly ONE delivery job row', jobs.length === 1, jobs.length);
  ok('its attempt_count reflects the retries (not duplicated rows)', jobs[0].attempt_count === 3, jobs[0].attempt_count);
}

console.log('\n== Scenario: the database itself refuses a second notification for the same payment_transactions row ==');
{
  const orderId = await newOrder('NTF-017', 500, CUST_A_ID);
  await pickupCash(orderId, 500);
  const pt = await db.query(`SELECT id FROM payment_transactions WHERE order_id = $1`, [orderId]);
  const ptId = pt.rows[0].id;
  // Directly attempt a second notification for the SAME payment_transactions
  // row, bypassing the trigger entirely, to prove the constraint itself (not
  // just "the trigger happens to only run once") is what prevents this.
  await db.query(
    `INSERT INTO notifications (user_id, title, message, type, reference_id, payment_transaction_id)
     VALUES ($1, 'Payment Received', 'duplicate attempt', 'payment_update', $2, $3)
     ON CONFLICT (payment_transaction_id) DO NOTHING`,
    [CUST_A_ID, orderId, ptId]
  );
  const notifs = await paymentNotifications(orderId);
  ok('a second notification insert for the same payment_transactions.id is refused by the database, not just avoided by convention', notifs.length === 1, notifs.length);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
