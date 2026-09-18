// Regression test for the 20260918010000 fix: get_financial_report_data()
// used to bucket a successful refund by payment_refunds.updated_at, which
// drifts on any later touch to the row (e.g. a duplicate/delayed webhook
// redelivery for an already-succeeded refund still runs an UPDATE, and the
// BEFORE UPDATE trigger bumps updated_at regardless of whether any value
// actually changed). This proves the refund now stays in the period it
// actually succeeded in, using succeeded_at (set once, on first success).
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

console.log('== Loading refund period-bucketing harness ==');
await db.exec(readFileSync(path.join(REPO, 'scripts/payment-ledger-pgtest/harness-schema.sql'), 'utf8'));
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20260909010000_payment_ledger_integrity_columns.sql'), 'utf8'));
await db.exec(`
  CREATE SCHEMA IF NOT EXISTS private;
  ALTER TABLE public.orders ADD COLUMN discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
  ALTER TABLE public.orders ADD COLUMN sender_name TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_name TEXT;
  ALTER TABLE public.orders ADD COLUMN origin TEXT;
  ALTER TABLE public.orders ADD COLUMN destination TEXT;
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
  CREATE TABLE public.order_status_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

for (const migration of [
  '20260912184434_paymongo_refunds_and_failures.sql',
  '20260912184816_optimize_payment_refund_select_policy.sql',
  '20260912185652_harden_paymongo_webhook_linkage.sql',
  '20260913170000_serialize_order_payment_totals.sql',
  '20260918010000_refund_period_bucketing_fix.sql',
]) {
  await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', migration), 'utf8'));
  console.log(`  applied ${migration}`);
}

const ADMIN = '10000000-0000-4000-8000-000000000001';
const CUSTOMER = '10000000-0000-4000-8000-000000000002';
await query(`INSERT INTO profiles (id,name,role) VALUES ($1,'Admin One','admin'),($2,'Customer One','customer')`, [ADMIN, CUSTOMER]);

const order = await value(`
  INSERT INTO orders (tracking_number,shipping_cost,actual_weight,status,user_id)
  VALUES ('PERIOD-TEST-001',1000,10,'Picked Up',$1) RETURNING id
`, [CUSTOMER]);
const payment = await value(`
  INSERT INTO payment_transactions (
    order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name,created_at
  ) VALUES ($1,1000,'gcash','paid','pay_period_test_001','paymongo','System Webhook','2026-09-10T10:00:00Z') RETURNING id
`, [order.id]);

const IDEM = '20000000-0000-4000-8000-000000000009';
await query(`SELECT prepare_paymongo_refund($1,400,'requested_by_customer','Partial refund',$2,$3)`, [payment.id, IDEM, ADMIN]);

// Refund succeeds on 2026-09-20 (September window).
await query(`SELECT reconcile_paymongo_refund(
  'ref_period_001','pay_period_test_001',400,'succeeded','requested_by_customer','Partial refund',
  false,'evt_success','2026-09-20T08:00:00Z','2026-09-20T08:00:00Z',$1
)`, [IDEM]);

let refundRow = await value(`SELECT status, succeeded_at, updated_at, provider_updated_at FROM payment_refunds WHERE refund_id='ref_period_001'`);
ok('succeeded_at is set at success time', refundRow.status === 'succeeded' && refundRow.succeeded_at != null, refundRow);
const firstSucceededAt = refundRow.succeeded_at;

// Simulate a delayed/duplicate webhook redelivery of the SAME succeeded
// refund arriving on 2026-10-05 (October) — this still runs a real UPDATE
// (provider_updated_at moves forward), so the old updated_at-based bucketing
// would have re-dated the refund into October.
await query(`SELECT reconcile_paymongo_refund(
  'ref_period_001','pay_period_test_001',400,'succeeded','requested_by_customer','Partial refund',
  false,'evt_redelivery_late','2026-09-20T08:00:00Z','2026-10-05T09:00:00Z',$1
)`, [IDEM]);

refundRow = await value(`SELECT status, succeeded_at, updated_at, provider_updated_at FROM payment_refunds WHERE refund_id='ref_period_001'`);
ok('succeeded_at does not move on a later redelivery touch', new Date(refundRow.succeeded_at).getTime() === new Date(firstSucceededAt).getTime(), refundRow);
ok('provider_updated_at DID move forward (proves the touch was real, not a no-op)', new Date(refundRow.provider_updated_at).getTime() === new Date('2026-10-05T09:00:00Z').getTime(), refundRow);
// updated_at is stamped by the BEFORE UPDATE trigger using real wall-clock
// NOW() (the moment this test ran), not the simulated provider date — which
// is exactly the point: it reflects "when was this row last touched", not
// "when did the refund succeed". That is precisely why it was the wrong
// column for period bucketing, and why succeeded_at (fixed at 2026-09-20
// above) is used instead.
ok('updated_at moved to a real touch timestamp, independent of succeeded_at (proves it was the wrong column for period bucketing)', new Date(refundRow.updated_at).getTime() !== new Date(refundRow.succeeded_at).getTime(), refundRow);

await query(`SELECT set_config('app.uid',$1,false), set_config('app.role','authenticated',false)`, [ADMIN]);

const septReport = await value(`SELECT get_financial_report_data('2026-09-01T00:00:00Z','2026-10-01T00:00:00Z') AS payload`);
const sept = septReport.payload;
ok('September report includes the September payment', Number(sept.grossCollected) === 1000, sept.grossCollected);
ok('September report includes the refund that succeeded in September (not moved to October)', Number(sept.successfulRefunds) === 400, sept.successfulRefunds);
ok('September net = 1000 - 400 = 600', Number(sept.netCollected) === 600, sept.netCollected);

const octReport = await value(`SELECT get_financial_report_data('2026-10-01T00:00:00Z','2026-11-01T00:00:00Z') AS payload`);
const oct = octReport.payload;
ok('October report has zero gross collected (payment was in September)', Number(oct.grossCollected) === 0, oct.grossCollected);
ok('October report does NOT re-count the September refund merely because it was touched again in October', Number(oct.successfulRefunds) === 0, oct.successfulRefunds);
ok('October net can legitimately be zero here (nothing happened in October) — not clamped, just genuinely empty', Number(oct.netCollected) === 0, oct.netCollected);

console.log(`\n${passed} passed, ${failed} failed`);
await db.close();
if (failed) process.exit(1);
