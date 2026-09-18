// Manual Cash / manual-GCash Refund Recording — database-layer regression
// tests for 20260918020000_manual_refund_recording.sql. Runs the real
// migration files against embedded Postgres.
//
// What this file proves: ledger correctness (amounts, locking, idempotency,
// reporting inclusion) and that the RPC itself independently rechecks admin
// eligibility, rejects non-service_role callers, and never touches
// PayMongo-channel refunds. What it does NOT and CANNOT prove: that the
// record-manual-refund Edge Function's password verification actually works
// against a real Supabase Auth server — Postgres has no GoTrue server to
// talk to. That is covered separately (statically) by
// scripts/manual-refund-edge-function-contract-test.mjs, and needs a live
// Supabase project for genuine end-to-end proof (documented as a limitation
// in the feature report, not silently assumed).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const db = new PGlite();
let passed = 0;
let failed = 0;

const ok = (description, condition, extra = null) => {
  if (condition) { passed += 1; console.log(`  ok - ${description}`); return; }
  failed += 1;
  console.log(`  FAIL - ${description}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);
};

const query = (sql, params = []) => db.query(sql, params);
const value = async (sql, params = []) => (await query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await query(sql, params)).rows;

const asRole = async (role, uid) => {
  await query(`SELECT set_config('app.role',$1,false)`, [role]);
  await query(`SELECT set_config('app.uid',$1,false)`, [uid || '']);
};

console.log('== Loading manual refund harness ==');
await db.exec(readFileSync(path.join(REPO, 'scripts/payment-ledger-pgtest/harness-schema.sql'), 'utf8'));
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20260909010000_payment_ledger_integrity_columns.sql'), 'utf8'));
await db.exec(`
  CREATE SCHEMA IF NOT EXISTS private;
  ALTER TABLE public.orders ADD COLUMN discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
  ALTER TABLE public.orders ADD COLUMN sender_name TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_name TEXT;
  ALTER TABLE public.orders ADD COLUMN origin TEXT;
  ALTER TABLE public.orders ADD COLUMN destination TEXT;
  CREATE TABLE public.order_status_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION public.order_payable_amount(p_shipping_cost numeric, p_discount numeric)
  RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT GREATEST(COALESCE(p_shipping_cost, 0) - COALESCE(p_discount, 0), 0)
  $$;
  CREATE OR REPLACE FUNCTION public.update_updated_at()
  RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN NEW.updated_at := NOW(); RETURN NEW; END $$;
  CREATE TABLE public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, title TEXT,
    message TEXT, type TEXT, reference_id UUID,
    payment_transaction_id UUID REFERENCES public.payment_transactions(id)
  );
  CREATE TABLE public.activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID, admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
    module TEXT NOT NULL, action TEXT NOT NULL,
    record_type TEXT, record_id UUID, record_ref TEXT,
    previous_value JSONB, new_value JSONB, details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE SCHEMA IF NOT EXISTS cron;
  CREATE TABLE cron.job (jobid BIGSERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT, command TEXT);
  CREATE OR REPLACE FUNCTION cron.schedule(p_jobname TEXT, p_schedule TEXT, p_command TEXT)
  RETURNS BIGINT LANGUAGE plpgsql AS $$
  DECLARE v_id BIGINT;
  BEGIN
    INSERT INTO cron.job(jobname, schedule, command) VALUES (p_jobname, p_schedule, p_command)
    ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
    RETURNING jobid INTO v_id;
    RETURN v_id;
  END $$;
  CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname TEXT)
  RETURNS BOOLEAN LANGUAGE plpgsql AS $$
  BEGIN DELETE FROM cron.job WHERE jobname=p_jobname; RETURN FOUND; END $$;
`);

for (const migration of [
  '20260912184434_paymongo_refunds_and_failures.sql',
  '20260912184816_optimize_payment_refund_select_policy.sql',
  '20260912185652_harden_paymongo_webhook_linkage.sql',
  '20260913000441_add_paymongo_refund_recovery.sql',
  '20260913090000_refund_ux_privacy_recovery_hardening.sql',
  '20260913100000_show_admin_name_to_customers.sql',
  '20260913110000_restore_payment_privacy_and_recovery_efficiency.sql',
  '20260913120000_show_refund_initiator_to_customers.sql',
  '20260913113126_customer_refund_notification_copy.sql',
  '20260913170000_serialize_order_payment_totals.sql',
  '20260918010000_refund_period_bucketing_fix.sql',
  '20260918020000_manual_refund_recording.sql',
  '20260919000000_manual_refund_reference_validation.sql',
]) {
  await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', migration), 'utf8'));
  console.log(`  applied ${migration}`);
}

const ADMIN = '10000000-0000-4000-8000-000000000001';
const ADMIN2 = '10000000-0000-4000-8000-000000000002';
const CUSTOMER = '10000000-0000-4000-8000-000000000003';
await query(`INSERT INTO profiles (id,name,role) VALUES ($1,'Admin One','admin'),($2,'Admin Two','admin'),($3,'Customer One','customer')`, [ADMIN, ADMIN2, CUSTOMER]);

// ------------------------------------------------------------------
// 1. Schema guards
// ------------------------------------------------------------------

{
  let rejected = false;
  try {
    await query(`INSERT INTO payment_refunds (
      payment_transaction_id, order_id, payment_id, refund_id, amount, status, reason, refund_channel, return_method, notes
    ) SELECT gen_random_uuid(), gen_random_uuid(), 'man_' || gen_random_uuid()::text, NULL, 100, 'succeeded', 'others', 'manual', 'cash', 'evidence note'`);
  } catch (error) {
    rejected = /payment_refunds_channel_identity/.test(error.message) || /violates check constraint/.test(error.message);
  }
  ok('a manual refund cannot carry a fabricated PayMongo-shaped payment_id (channel identity CHECK)', rejected);
}

{
  let rejected = false;
  try {
    await query(`INSERT INTO payment_refunds (
      payment_transaction_id, order_id, payment_id, refund_id, amount, status, reason, refund_channel, return_method, return_reference
    ) SELECT gen_random_uuid(), gen_random_uuid(), NULL, NULL, 100, 'succeeded', 'others', 'manual', 'gcash', 'x'`);
  } catch (error) {
    rejected = /payment_refunds_manual_return_evidence/.test(error.message) || /violates check constraint/.test(error.message);
  }
  ok('a manual GCash return needs a transfer reference of at least 4 characters (evidence CHECK)', rejected);
}

// ------------------------------------------------------------------
// 2. Base fixtures: a Cash order and a manual-GCash order
// ------------------------------------------------------------------

const cashOrder = await value(`
  INSERT INTO orders (tracking_number,shipping_cost,actual_weight,status,user_id)
  VALUES ('MANUAL-CASH-001',1000,10,'Picked Up',$1) RETURNING id
`, [CUSTOMER]);
const cashPayment = await value(`
  INSERT INTO payment_transactions (
    order_id,amount,payment_method,payment_status,transaction_reference,admin_name
  ) VALUES ($1,1000,'cash','paid','cash-receipt-001','Admin One') RETURNING id
`, [cashOrder.id]);

const manualGcashOrder = await value(`
  INSERT INTO orders (tracking_number,shipping_cost,actual_weight,status,user_id)
  VALUES ('MANUAL-GCASH-001',500,5,'Picked Up',$1) RETURNING id
`, [CUSTOMER]);
const manualGcashPayment = await value(`
  INSERT INTO payment_transactions (
    order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name
  ) VALUES ($1,500,'gcash','paid','GCASH-MANUAL-REF-01','manual','Admin One') RETURNING id
`, [manualGcashOrder.id]);

const paymongoOrder = await value(`
  INSERT INTO orders (tracking_number,shipping_cost,actual_weight,status,user_id)
  VALUES ('MANUAL-PAYMONGO-001',700,7,'Picked Up',$1) RETURNING id
`, [CUSTOMER]);
const paymongoPayment = await value(`
  INSERT INTO payment_transactions (
    order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name
  ) VALUES ($1,700,'gcash','paid','pay_manual_guard_001','paymongo','System Webhook') RETURNING id
`, [paymongoOrder.id]);

// Dedicated fixture for the reference-format validation tests below, so the
// two cases that actually SUCCEED there don't eat into manualGcashPayment's
// balance ahead of the full-amount refund test further down.
const referenceFormatOrder = await value(`
  INSERT INTO orders (tracking_number,shipping_cost,actual_weight,status,user_id)
  VALUES ('MANUAL-GCASH-REFFMT-001',300,3,'Picked Up',$1) RETURNING id
`, [CUSTOMER]);
// A realistic, mostly-numeric original reference (matching the documented
// "Ref No." shape) — needed so the "matches the original payment's own
// reference" check actually gets exercised; a reference with too few
// digits would be rejected earlier by the generic digit-content check
// instead, before ever reaching that specific comparison.
const referenceFormatPayment = await value(`
  INSERT INTO payment_transactions (
    order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name
  ) VALUES ($1,300,'gcash','paid','1001 543 610277','manual','Admin One') RETURNING id
`, [referenceFormatOrder.id]);

// ------------------------------------------------------------------
// 3. Direct-call / authorization guards
// ------------------------------------------------------------------

await asRole('authenticated', ADMIN);
{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer','ack note','cash',NULL,NOW(),$2,$3)`,
      [cashPayment.id, '30000000-0000-4000-8000-000000000001', ADMIN]);
  } catch (error) {
    rejected = /Service role required/.test(error.message);
  }
  ok('the browser/authenticated role cannot call record_manual_refund directly (bypassing reauthentication)', rejected);
}

await asRole('service_role', null);
{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer','ack note','cash',NULL,NOW(),$2,$3)`,
      [cashPayment.id, '30000000-0000-4000-8000-000000000002', CUSTOMER]);
  } catch (error) {
    rejected = /Admin access required/.test(error.message);
  }
  ok('record_manual_refund rechecks eligibility itself and rejects a non-admin p_admin_id, even from service_role', rejected);
}

{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer','ack note','cash',NULL,NOW(),$2,$3)`,
      [paymongoPayment.id, '30000000-0000-4000-8000-000000000003', ADMIN]);
  } catch (error) {
    rejected = /Use the provider refund instead/.test(error.message);
  }
  ok('record_manual_refund refuses a verified PayMongo GCash payment (must use the provider flow)', rejected);
}

{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer',NULL,'cash',NULL,NOW(),$2,$3)`,
      [cashPayment.id, '30000000-0000-4000-8000-000000000004', ADMIN]);
  } catch (error) {
    rejected = /acknowledgement note is required/.test(error.message);
  }
  ok('a Cash return without an acknowledgement note is rejected server-side (not just by the modal)', rejected);
}

{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer',NULL,'gcash',NULL,NOW(),$2,$3)`,
      [manualGcashPayment.id, '30000000-0000-4000-8000-000000000005', ADMIN]);
  } catch (error) {
    rejected = /transfer reference is required/.test(error.message);
  }
  ok('a GCash return without a transfer reference is rejected server-side', rejected);
}

// ------------------------------------------------------------------
// 3b. GCash reference format validation — the actual bug this migration
// fixes (an email/phone/internal-id previously passed the old 4-character
// minimum check). Every case here is rejected server-side, independent of
// whatever the browser modal does or does not catch.
// ------------------------------------------------------------------

{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer',NULL,'gcash','admin@cargoexpressph.com',NOW(),$2,$3)`,
      [manualGcashPayment.id, '30000000-0000-4000-8000-000000000030', ADMIN]);
  } catch (error) {
    rejected = /email address/.test(error.message);
  }
  ok('an email address entered as the GCash reference is rejected server-side', rejected);
}

{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer',NULL,'gcash','09171234567',NOW(),$2,$3)`,
      [manualGcashPayment.id, '30000000-0000-4000-8000-000000000031', ADMIN]);
  } catch (error) {
    rejected = /phone number/.test(error.message);
  }
  ok('a phone number entered as the GCash reference is rejected server-side', rejected);
}

{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer',NULL,'gcash','pay_9f8a7b6c5d4e3f2a1b0c',NOW(),$2,$3)`,
      [manualGcashPayment.id, '30000000-0000-4000-8000-000000000032', ADMIN]);
  } catch (error) {
    rejected = /internal payment system ID/.test(error.message);
  }
  ok('a PayMongo-shaped payment/refund ID entered as the GCash reference is rejected server-side', rejected);
}

{
  // referenceFormatPayment's own transaction_reference is
  // '1001 543 610277' (the ORIGINAL payment) — entering that exact value
  // back as the refund's OWN reference must be rejected, since it would
  // misrepresent the original payment as if it were the new outgoing
  // refund transfer.
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer',NULL,'gcash','1001 543 610277',NOW(),$2,$3)`,
      [referenceFormatPayment.id, '30000000-0000-4000-8000-000000000033', ADMIN]);
  } catch (error) {
    rejected = /own reference/.test(error.message);
  }
  ok('a reference identical to the ORIGINAL payment\'s own reference is rejected (would misrepresent it as the refund transfer)', rejected);
}

{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,100,'requested_by_customer',NULL,'gcash','no digits here',NOW(),$2,$3)`,
      [manualGcashPayment.id, '30000000-0000-4000-8000-000000000034', ADMIN]);
  } catch (error) {
    rejected = /completed GCash transfer receipt/.test(error.message);
  }
  ok('a reference with no meaningful digit content is rejected (every documented GCash-adjacent reference format is numeric-based)', rejected);
}

{
  // Leading zeros must survive storage — this is a TEXT column, and nothing
  // in the accepted path may coerce it to a number or strip characters.
  const LEADING_ZERO_IDEM = '30000000-0000-4000-8000-000000000035';
  const leadingZeroResult = await value(
    `SELECT record_manual_refund($1,50,'requested_by_customer',NULL,'gcash','0091 234 567890',NOW(),$2,$3) AS payload`,
    [referenceFormatPayment.id, LEADING_ZERO_IDEM, ADMIN]
  );
  ok('a valid reference with leading zeros is accepted and stored exactly as pasted, with no digits stripped', leadingZeroResult.payload.created === true && leadingZeroResult.payload.return_reference === '0091 234 567890', leadingZeroResult.payload);
}

{
  // Whitespace is trimmed at the edges only — not collapsed or removed
  // internally, since that could turn one valid-looking reference into a
  // different one.
  const TRIM_IDEM = '30000000-0000-4000-8000-000000000036';
  const trimResult = await value(
    `SELECT record_manual_refund($1,25,'requested_by_customer',NULL,'gcash','  1234 567 890123  ',NOW(),$2,$3) AS payload`,
    [referenceFormatPayment.id, TRIM_IDEM, ADMIN]
  );
  ok('surrounding whitespace is trimmed but internal spacing is preserved exactly', trimResult.payload.created === true && trimResult.payload.return_reference === '1234 567 890123', trimResult.payload);
}

// ------------------------------------------------------------------
// 4. Successful Cash refund — the primary path from the bug report
// ------------------------------------------------------------------

const CASH_IDEM = '30000000-0000-4000-8000-000000000010';
const cashResult = await value(
  `SELECT record_manual_refund($1,400,'requested_by_customer','Handed cash back to customer in person, order cancelled.','cash',NULL,'2024-01-15T10:00:00Z',$2,$3) AS payload`,
  [cashPayment.id, CASH_IDEM, ADMIN]
);
ok('manual cash refund is created', cashResult.payload.created === true, cashResult.payload);
ok('status is succeeded immediately (money was already handed back)', cashResult.payload.status === 'succeeded', cashResult.payload);
ok('refund_channel is manual, not paymongo', cashResult.payload.refund_channel === 'manual', cashResult.payload);
ok('refund_id/payment_id stay NULL — no fabricated PayMongo id', cashResult.payload.refund_id === null && cashResult.payload.payment_id === null, cashResult.payload);
ok('initiated_by is the server-verified admin id, not a browser-supplied value', cashResult.payload.initiated_by === ADMIN, cashResult.payload);
ok('succeeded_at is set from the actual returned_at time', new Date(cashResult.payload.succeeded_at).getTime() === new Date('2024-01-15T10:00:00Z').getTime(), cashResult.payload);

let orderTotals = await value(`SELECT amount_paid,remaining_balance,payment_status FROM orders WHERE id=$1`, [cashOrder.id]);
ok('order totals reflect the manual refund via the existing update_order_payment_totals trigger', Number(orderTotals.amount_paid) === 600 && Number(orderTotals.remaining_balance) === 400 && orderTotals.payment_status === 'partial', orderTotals);

const auditRow = await value(`SELECT admin_id, admin_name, module, action, details FROM activity_logs WHERE record_id=$1 AND action='Manual Refund Recorded'`, [cashOrder.id]);
ok('activity_logs records which admin recorded the manual refund, with the verified identity (not derived from auth.uid(), which is NULL under service_role)', auditRow.admin_id === ADMIN && auditRow.admin_name === 'Admin One' && auditRow.module === 'Payments', auditRow);

const cashNotification = await value(`SELECT message FROM notifications WHERE payment_refund_id=$1`, [cashResult.payload.id]);
ok('customer notification for a manual cash refund does not falsely claim it "may take additional time to appear in your GCash account"', !/GCash account/.test(cashNotification.message), cashNotification);

// ------------------------------------------------------------------
// 5. Idempotency and duplicate/concurrent submission
// ------------------------------------------------------------------

const retryResult = await value(
  `SELECT record_manual_refund($1,400,'requested_by_customer','Handed cash back to customer in person, order cancelled.','cash',NULL,'2024-01-15T10:00:00Z',$2,$3) AS payload`,
  [cashPayment.id, CASH_IDEM, ADMIN]
);
ok('resubmitting the exact same idempotency key does not create a second row', retryResult.payload.created === false && retryResult.payload.id === cashResult.payload.id, retryResult.payload);

const dupCount = await value(`SELECT COUNT(*)::int AS count FROM payment_refunds WHERE payment_transaction_id=$1`, [cashPayment.id]);
ok('exactly one refund row exists for the cash payment after the retry', dupCount.count === 1, dupCount);

{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,601,'requested_by_customer','different amount attempt','cash',NULL,NOW(),$2,$3)`,
      [cashPayment.id, CASH_IDEM, ADMIN]);
  } catch (error) {
    rejected = /already used for a different refund request/.test(error.message);
  }
  ok('reusing the same idempotency key for a different amount is rejected, not silently overwritten', rejected);
}

// Concurrent/duplicate refund attempt: the remaining refundable is 600 (1000 - 400).
// Two admins try to refund the remainder at the same time.
const CONCURRENT_IDEM_A = '30000000-0000-4000-8000-000000000011';
const CONCURRENT_IDEM_B = '30000000-0000-4000-8000-000000000012';
await value(
  `SELECT record_manual_refund($1,600,'requested_by_customer','Second cash handover, remaining balance fully returned.','cash',NULL,NOW(),$2,$3) AS payload`,
  [cashPayment.id, CONCURRENT_IDEM_A, ADMIN]
);
{
  let rejected = false;
  try {
    await query(`SELECT record_manual_refund($1,1,'requested_by_customer','a second admin tries to refund one more peso','cash',NULL,NOW(),$2,$3)`,
      [cashPayment.id, CONCURRENT_IDEM_B, ADMIN2]);
  } catch (error) {
    rejected = /remaining refundable amount/.test(error.message);
  }
  ok('a second admin cannot refund past the fully-reserved amount (row locking + reservation math prevents over-refund)', rejected);
}

orderTotals = await value(`SELECT amount_paid,remaining_balance,payment_status FROM orders WHERE id=$1`, [cashOrder.id]);
ok('after both cash refunds, the order is fully unwound: amount_paid 0, remaining_balance = shipping_cost', Number(orderTotals.amount_paid) === 0 && Number(orderTotals.remaining_balance) === 1000 && orderTotals.payment_status === 'unpaid', orderTotals);

// ------------------------------------------------------------------
// 6. Successful manual GCash return
// ------------------------------------------------------------------

const GCASH_IDEM = '30000000-0000-4000-8000-000000000020';
const gcashResult = await value(
  `SELECT record_manual_refund($1,500,'requested_by_customer','Returned in full via GCash transfer.','gcash','1001 543 610299','2024-01-16T08:00:00Z',$2,$3) AS payload`,
  [manualGcashPayment.id, GCASH_IDEM, ADMIN]
);
ok('manual GCash-return refund is created with its transfer reference recorded', gcashResult.payload.created === true && gcashResult.payload.return_reference === '1001 543 610299', gcashResult.payload);

const gcashNotification = await value(`SELECT message FROM notifications WHERE payment_refund_id=$1`, [gcashResult.payload.id]);
ok('a manual GCash return notification says our team returned it, not "your original GCash account" (which implies an automated provider posting)', /recorded as returned by our team/.test(gcashNotification.message), gcashNotification);

// ------------------------------------------------------------------
// 7. Manual refunds are excluded from provider-only paths
// ------------------------------------------------------------------

const uncertainAttempt = await value(`SELECT mark_paymongo_refund_uncertain($1,'should not apply to a manual refund') AS payload`, [CASH_IDEM]);
ok('mark_paymongo_refund_uncertain (provider-only) does not touch a manual refund row', uncertainAttempt.payload === null, uncertainAttempt);

const failedAttempt = await value(`SELECT mark_paymongo_refund_failed($1,'should not apply','should not apply') AS payload`, [GCASH_IDEM]);
ok('mark_paymongo_refund_failed (provider-only) does not touch a manual refund row', failedAttempt.payload === null, failedAttempt);

const stillSucceeded = await value(`SELECT status, outcome_uncertain FROM payment_refunds WHERE idempotency_key=$1`, [CASH_IDEM]);
ok('the manual refund itself is unaffected — still succeeded, never marked uncertain', stillSucceeded.status === 'succeeded' && stillSucceeded.outcome_uncertain === false, stillSucceeded);

const recoveryJobExists = await value(`SELECT COUNT(*)::int AS count FROM private.paymongo_refund_recovery_jobs WHERE payment_transaction_id=$1`, [cashPayment.id]);
ok('the Cash payment was never queued for PayMongo refund recovery in the first place', recoveryJobExists.count === 0, recoveryJobExists);

// ------------------------------------------------------------------
// 8. Reporting integration — prove it, do not assume it
// ------------------------------------------------------------------

await asRole('authenticated', ADMIN);
// Wide window: the first cash refund and the manual GCash return were
// deliberately dated 2024-01 (to sidestep the sandbox's real wall clock —
// see the comment above `asRole`), while the payments and the second cash
// refund default to NOW(). Period-bucketing itself (does a refund land in
// the period it actually succeeded in) is already the dedicated subject of
// scripts/refund-period-bucketing-pgtest — this section's job is only to
// prove manual refunds are picked up by the report at all, with correct
// method attribution and no double counting, so a window wide enough to
// contain every fixture is the right tool here.
const financialReport = await value(
  `SELECT get_financial_report_data('2000-01-01T00:00:00Z','2100-01-01T00:00:00Z') AS payload`
);
const report = financialReport.payload;
// Fixtures in scope: cash 1000 (refunded 400+600), manual-GCash 500
// (refunded 500), the PayMongo-channel 700 fixture created earlier only to
// prove record_manual_refund refuses it (never refunded), and
// referenceFormatPayment 300 (refunded 50+25 by the leading-zero/whitespace
// format-validation tests above).
ok('period financial report gross collected includes every payment fixture (1000 cash + 500 manual-GCash + 700 PayMongo-channel + 300 reference-format)', Number(report.grossCollected) === 2500, report.grossCollected);
ok('period financial report successful refunds include every manual refund in full (400 + 600 cash + 500 gcash + 50 + 25 = 1575)', Number(report.successfulRefunds) === 1575, report.successfulRefunds);
ok('net collected is gross minus refunds (2500 - 1575 = 925) — manual refunds are not silently excluded from the RPC', Number(report.netCollected) === 925, report.netCollected);

const cashMethodRow = report.methodTotals.find(row => row.method === 'cash');
ok('the Cash method bucket specifically is fully reduced by the manual cash refunds (was inflating Cash Sales before this feature existed)', Number(cashMethodRow.gross) === 1000 && Number(cashMethodRow.refunds) === 1000 && Number(cashMethodRow.net) === 0, cashMethodRow);

const gcashMethodRow = report.methodTotals.find(row => row.method === 'gcash');
ok('the GCash method bucket is reduced by the manual GCash returns, but not by the unrelated never-refunded PayMongo fixture (gross 500+700+300=1500, refunds 500+75=575, net 925)', Number(gcashMethodRow.gross) === 1500 && Number(gcashMethodRow.refunds) === 575 && Number(gcashMethodRow.net) === 925, gcashMethodRow);

const refundDetailRows = report.paymentRefundDetail.filter(row => row.type === 'refund');
ok('all five manual refunds appear individually in the combined payment/refund detail ledger (no double counting, no join fan-out)', refundDetailRows.length === 5, refundDetailRows.length);

// ------------------------------------------------------------------
// 9. Cancelled-order settlement stays correct after a manual refund
// ------------------------------------------------------------------

await asRole('service_role', null);
await query(`UPDATE orders SET status='Cancelled' WHERE id=$1`, [manualGcashOrder.id]);
const cancelledOrder = await value(`SELECT status, amount_paid, remaining_balance FROM orders WHERE id=$1`, [manualGcashOrder.id]);
ok('a cancelled order that was fully manually refunded settles at amount_paid=0 (the trigger has no status branch, so this is the same math as an active order — the UI layer is what special-cases Cancelled, tested separately)', cancelledOrder.status === 'Cancelled' && Number(cancelledOrder.amount_paid) === 0, cancelledOrder);

// ------------------------------------------------------------------
// 10. Reauthentication rate limiting
// ------------------------------------------------------------------

await asRole('authenticated', ADMIN);
{
  let rejected = false;
  try { await query(`SELECT check_manual_refund_reauth_lockout($1)`, [ADMIN]); }
  catch (error) { rejected = /Service role required/.test(error.message); }
  ok('the browser cannot call the reauth lockout check directly either', rejected);
}

await asRole('service_role', null);
let lockoutState = await value(`SELECT check_manual_refund_reauth_lockout($1) AS payload`, [ADMIN2]);
ok('a fresh admin starts unlocked', lockoutState.payload.locked === false && lockoutState.payload.failed_count === 0, lockoutState.payload);

for (let i = 0; i < 4; i++) {
  await query(`SELECT record_manual_refund_reauth_attempt($1, false)`, [ADMIN2]);
}
lockoutState = await value(`SELECT check_manual_refund_reauth_lockout($1) AS payload`, [ADMIN2]);
ok('4 failed password attempts do not lock the admin out yet', lockoutState.payload.locked === false && lockoutState.payload.failed_count === 4, lockoutState.payload);

const fifthFailure = await value(`SELECT record_manual_refund_reauth_attempt($1, false) AS payload`, [ADMIN2]);
ok('the 5th failed password attempt locks re-authentication for this admin', fifthFailure.payload.locked === true && fifthFailure.payload.failed_count === 5, fifthFailure.payload);

const afterSuccess = await value(`SELECT record_manual_refund_reauth_attempt($1, true) AS payload`, [ADMIN2]);
ok('a successful verification resets the lockout counter', afterSuccess.payload.locked === false && afterSuccess.payload.failed_count === 0, afterSuccess.payload);

console.log(`\n${passed} passed, ${failed} failed`);
await db.close();
if (failed) process.exit(1);
