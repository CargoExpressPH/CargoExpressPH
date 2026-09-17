// F-002 refund regression tests. Runs the real migration against embedded
// Postgres, then exercises partial/full refunds, redelivery, reservation
// limits, report totals, and payment.failed reconciliation.
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

console.log('== Loading payment refund harness ==');
await db.exec(readFileSync(path.join(REPO, 'scripts/payment-ledger-pgtest/harness-schema.sql'), 'utf8'));
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20260909010000_payment_ledger_integrity_columns.sql'), 'utf8'));
await db.exec(`
  CREATE SCHEMA IF NOT EXISTS private;
  ALTER TABLE public.orders ADD COLUMN discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
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
`);

const migration = '20260912184434_paymongo_refunds_and_failures.sql';
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', migration), 'utf8'));
console.log(`  applied ${migration}`);
const policyMigration = '20260912184816_optimize_payment_refund_select_policy.sql';
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', policyMigration), 'utf8'));
console.log(`  applied ${policyMigration}`);
const linkageMigration = '20260912185652_harden_paymongo_webhook_linkage.sql';
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', linkageMigration), 'utf8'));
console.log(`  applied ${linkageMigration}`);
const paymentTotalsMigration = '20260913170000_serialize_order_payment_totals.sql';
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', paymentTotalsMigration), 'utf8'));
console.log(`  applied ${paymentTotalsMigration}`);

const paymentTotalsFunction = await value(`
  SELECT pg_get_functiondef('public.update_order_payment_totals()'::regprocedure) AS definition
`);
ok(
  'payment totals recalculate only after locking the parent order',
  paymentTotalsFunction.definition.indexOf('FOR UPDATE') < paymentTotalsFunction.definition.indexOf('SUM(amount)'),
  paymentTotalsFunction,
);

const ADMIN = '10000000-0000-4000-8000-000000000001';
const CUSTOMER = '10000000-0000-4000-8000-000000000002';
await query(`INSERT INTO profiles (id,name,role) VALUES ($1,'Admin One','admin'),($2,'Customer One','customer')`, [ADMIN, CUSTOMER]);

const order = await value(`
  INSERT INTO orders (tracking_number,shipping_cost,actual_weight,status,user_id)
  VALUES ('REFUND-TEST-001',1000,10,'Picked Up',$1) RETURNING id
`, [CUSTOMER]);
const payment = await value(`
  INSERT INTO payment_transactions (
    order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name
  ) VALUES ($1,1000,'gcash','paid','pay_refund_test_001','paymongo','System Webhook') RETURNING id
`, [order.id]);

let totals = await value(`SELECT amount_paid,remaining_balance,payment_status FROM orders WHERE id=$1`, [order.id]);
ok('original payment fully settles the order', Number(totals.amount_paid) === 1000 && totals.payment_status === 'paid', totals);

const IDEM1 = '20000000-0000-4000-8000-000000000001';
await query(`SELECT prepare_paymongo_refund($1,400,'requested_by_customer','Partial refund',$2,$3)`, [payment.id, IDEM1, ADMIN]);
totals = await value(`SELECT amount_paid,remaining_balance FROM orders WHERE id=$1`, [order.id]);
ok('creating refund does not move financial totals', Number(totals.amount_paid) === 1000 && Number(totals.remaining_balance) === 0, totals);

await query(`SELECT reconcile_paymongo_refund(
  'ref_test_001','pay_refund_test_001',400,'pending','requested_by_customer','Partial refund',false,'evt_pending',NOW(),NOW(),$1
)`, [IDEM1]);
totals = await value(`SELECT amount_paid FROM orders WHERE id=$1`, [order.id]);
ok('pending refund does not move financial totals', Number(totals.amount_paid) === 1000, totals);

await query(`SELECT reconcile_paymongo_refund(
  'ref_test_001','pay_refund_test_001',400,'succeeded','requested_by_customer','Partial refund',false,'evt_success',NOW(),NOW(),$1
)`, [IDEM1]);
totals = await value(`SELECT amount_paid,remaining_balance,payment_status FROM orders WHERE id=$1`, [order.id]);
ok('successful partial refund reverses collected amount', Number(totals.amount_paid) === 600 && Number(totals.remaining_balance) === 400 && totals.payment_status === 'partial', totals);

await query(`SELECT reconcile_paymongo_refund(
  'ref_test_001','pay_refund_test_001',400,'succeeded','requested_by_customer','Partial refund',false,'evt_redelivery',NOW(),NOW(),$1
)`, [IDEM1]);
const duplicate = await value(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS total FROM payment_refunds WHERE payment_id='pay_refund_test_001'`);
totals = await value(`SELECT amount_paid FROM orders WHERE id=$1`, [order.id]);
ok('webhook redelivery is idempotent', duplicate.count === 1 && Number(duplicate.total) === 400 && Number(totals.amount_paid) === 600, { duplicate, totals });

const notice = await value(`SELECT COUNT(*)::int AS count FROM notifications WHERE payment_refund_id IS NOT NULL`);
ok('successful refund creates exactly one customer notification', notice.count === 1, notice);

const IDEM2 = '20000000-0000-4000-8000-000000000002';
await query(`SELECT prepare_paymongo_refund($1,600,'duplicate',NULL,$2,$3)`, [payment.id, IDEM2, ADMIN]);
let overRefundRejected = false;
try {
  await query(`SELECT prepare_paymongo_refund($1,1,'others',NULL,'20000000-0000-4000-8000-000000000003',$2)`, [payment.id, ADMIN]);
} catch (error) {
  overRefundRejected = /remaining refundable amount/.test(error.message);
}
ok('active reservations prevent concurrent over-refunds', overRefundRejected);

await query(`SELECT reconcile_paymongo_refund(
  'ref_test_002','pay_refund_test_001',600,'succeeded','duplicate',NULL,false,'evt_full',NOW(),NOW(),$1
)`, [IDEM2]);
totals = await value(`SELECT amount_paid,remaining_balance,payment_status FROM orders WHERE id=$1`, [order.id]);
ok('successful full remainder refund returns order to unpaid', Number(totals.amount_paid) === 0 && Number(totals.remaining_balance) === 1000 && totals.payment_status === 'unpaid', totals);

await query(`SELECT set_config('app.uid',$1,false), set_config('app.role','authenticated',false)`, [ADMIN]);
const sales = await value(`SELECT get_sales_summary() AS payload`);
const summary = sales.payload.summary;
ok('sales report separates gross, refunds, and net', Number(summary.grossCollected) === 1000 && Number(summary.refundTotal) === 1000 && Number(summary.netCollected) === 0, summary);

await query(`INSERT INTO payment_attempts (source_id,order_id,amount,status) VALUES ('src_failed_test_001',$1,100,'pending')`, [order.id]);
await query(`SELECT reconcile_paymongo_payment_failure('src_failed_test_001','pay_failed_test_001','test decline')`);
const attempt = await value(`SELECT status,payment_status,last_error FROM payment_attempts WHERE source_id='src_failed_test_001'`);
ok('payment.failed marks the registered attempt without crediting money', attempt.status === 'failed' && attempt.payment_status === 'failed' && /test decline/.test(attempt.last_error), attempt);

await query(`INSERT INTO payment_attempts (source_id,order_id,amount,status,payment_id) VALUES ('src_failed_test_002',$1,125,'pending','pay_failed_test_002')`, [order.id]);
await query(`SELECT reconcile_paymongo_payment_failure(NULL,'pay_failed_test_002','provider declined')`);
const paymentOnlyAttempt = await value(`SELECT status,payment_status,last_error FROM payment_attempts WHERE source_id='src_failed_test_002'`);
ok('payment.failed can link by payment id when its payload omits the source', paymentOnlyAttempt.status === 'failed' && paymentOnlyAttempt.payment_status === 'failed' && /provider declined/.test(paymentOnlyAttempt.last_error), paymentOnlyAttempt);

await query(`SELECT set_config('app.uid',$1,false), set_config('app.role','authenticated',false)`, [CUSTOMER]);
const customerAttempt = await value(`SELECT * FROM get_payment_attempt_history(ARRAY[$1]::uuid[])`, [order.id]);
ok('customer history exposes the failed attempt without its internal provider error', customerAttempt.status === 'failed' && customerAttempt.failure_message === null, customerAttempt);

let unpaidRejected = false;
await query(`INSERT INTO payment_attempts (source_id,order_id,amount,status) VALUES ('src_unpaid_guard_001',$1,50,'pending')`, [order.id]);
try {
  await query(`SELECT * FROM reconcile_paymongo_payment_attempt('src_unpaid_guard_001','pay_unpaid_guard_001',50,'failed')`);
} catch (error) {
  unpaidRejected = /Only a paid PayMongo payment/.test(error.message);
}
ok('non-paid provider response cannot write the payment ledger', unpaidRejected);

console.log(`\n${passed} passed, ${failed} failed`);
await db.close();
if (failed) process.exit(1);
