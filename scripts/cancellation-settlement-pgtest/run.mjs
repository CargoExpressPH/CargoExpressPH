import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const db = new PGlite();
let passed = 0;
let failed = 0;

const query = (sql, params = []) => db.query(sql, params);
const one = async (sql, params = []) => (await query(sql, params)).rows[0];
const ok = (description, condition, extra = null) => {
  if (condition) {
    passed += 1;
    console.log('  ok - ' + description);
  } else {
    failed += 1;
    console.log('  FAIL - ' + description + (extra ? ' :: ' + JSON.stringify(extra) : ''));
  }
};
const rejects = async (description, operation, pattern) => {
  let error = null;
  try { await operation(); } catch (caught) { error = caught; }
  ok(description, Boolean(error && pattern.test(error.message)), error?.message);
};

console.log('== Loading cancellation settlement harness ==');
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
  CREATE TABLE public.activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID, admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
    module TEXT NOT NULL, action TEXT NOT NULL,
    record_type TEXT, record_id UUID, record_ref TEXT,
    previous_value JSONB, new_value JSONB, details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE public.order_status_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE SCHEMA IF NOT EXISTS cron;
  CREATE TABLE cron.job (jobid BIGSERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT, command TEXT);
  CREATE OR REPLACE FUNCTION cron.schedule(p_jobname TEXT, p_schedule TEXT, p_command TEXT)
  RETURNS BIGINT LANGUAGE plpgsql AS $$
  DECLARE v_id BIGINT;
  BEGIN
    INSERT INTO cron.job(jobname, schedule, command) VALUES (p_jobname, p_schedule, p_command)
    ON CONFLICT (jobname) DO UPDATE SET schedule=EXCLUDED.schedule, command=EXCLUDED.command
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
  '20260920110000_cancellation_settlement_workflow.sql',
]) {
  await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', migration), 'utf8'));
  console.log('  applied ' + migration);
}

const ADMIN = '10000000-0000-4000-8000-000000000001';
const ADMIN2 = '10000000-0000-4000-8000-000000000002';
const CUSTOMER = '10000000-0000-4000-8000-000000000003';
await query(`INSERT INTO profiles (id,name,role) VALUES
  ($1,'Admin One','admin'),($2,'Admin Two','admin'),($3,'Customer One','customer')`, [ADMIN, ADMIN2, CUSTOMER]);

const asUser = async (uid, role = 'authenticated') => {
  await query(`SELECT set_config('app.uid',$1,false), set_config('app.role',$2,false)`, [uid || '', role]);
};

// Exact two-booking fixture.
const active = await one(`
  INSERT INTO orders (tracking_number,shipping_cost,discount_amount,actual_weight,status,user_id)
  VALUES ('CE-20260920-9475',70000,5000,10,'Picked Up',$1) RETURNING id
`, [CUSTOMER]);
await query(`
  INSERT INTO payment_transactions (order_id,amount,payment_method,payment_status,transaction_reference,admin_name,created_at)
  VALUES ($1,20000,'cash','partial','cash-active-20000','Admin One','2026-09-20 13:12:00+08')
`, [active.id]);

const cancelled = await one(`
  INSERT INTO orders (tracking_number,shipping_cost,discount_amount,actual_weight,status,user_id,promised_payment_date)
  VALUES ('CE-20260917-3506',35000,1000,10,'Cancelled',$1,'2026-09-25') RETURNING id
`, [CUSTOMER]);
const cash = await one(`
  INSERT INTO payment_transactions (order_id,amount,payment_method,payment_status,transaction_reference,admin_name,created_at)
  VALUES ($1,20000,'cash','paid','cash-cancelled-20000','Admin One','2026-09-18 09:00:00+08') RETURNING id
`, [cancelled.id]);
const gcash = await one(`
  INSERT INTO payment_transactions (order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name,created_at)
  VALUES ($1,10000,'gcash','paid','1001 543 610277','manual','Admin One','2026-09-18 09:05:00+08') RETURNING id
`, [cancelled.id]);

await asUser('', 'service_role');
await query(`SELECT public.record_manual_refund($1,10000,'requested_by_customer','Cash received by customer','cash',NULL,NOW(),$2,$3)`,
  [cash.id, '20000000-0000-4000-8000-000000000001', ADMIN]);
await query(`SELECT public.record_manual_refund($1,10000,'requested_by_customer','Manual GCash return','gcash','009912345678',NOW(),$2,$3)`,
  [gcash.id, '20000000-0000-4000-8000-000000000002', ADMIN]);

const totals = await one(`
  SELECT
    (SELECT SUM(amount) FROM payment_transactions WHERE payment_status IN ('paid','partial')) AS gross,
    (SELECT SUM(amount) FROM payment_refunds WHERE status='succeeded') AS refunds,
    (SELECT SUM(amount) FROM payment_transactions WHERE payment_status IN ('paid','partial'))
      - (SELECT SUM(amount) FROM payment_refunds WHERE status='succeeded') AS net,
    (SELECT SUM(GREATEST(shipping_cost-discount_amount-amount_paid,0)) FROM orders
      WHERE status IN ('Picked Up','In Transit','Arrived at Hub','Out for Delivery','Delivered')) AS active_unpaid,
    (SELECT SUM(amount) FROM payment_transactions
      WHERE payment_status IN ('paid','partial')
        AND (created_at AT TIME ZONE 'Asia/Manila')::date='2026-09-20') AS sep20_gross
`);
ok('two-booking fixture reconciles gross/refunds/net/active unpaid/Sep 20',
  Number(totals.gross) === 50000
  && Number(totals.refunds) === 20000
  && Number(totals.net) === 30000
  && Number(totals.active_unpaid) === 45000
  && Number(totals.sep20_gross) === 20000, totals);

await asUser(CUSTOMER);
let summary = (await one(`SELECT public.get_cancellation_settlement_summary($1) AS value`, [cancelled.id])).value;
ok('legacy/no-decision cancellation is For Review with unknown fee/due',
  summary.settlement_status === 'for_review'
  && summary.agreed_cancellation_fee === null
  && summary.refund_still_due === null
  && Number(summary.net_retained) === 10000, summary);

await rejects('customer cannot record a settlement decision',
  () => query(`SELECT public.record_cancellation_settlement_decision($1,'full_refund',0,false,NULL,$2)`,
    [cancelled.id, '30000000-0000-4000-8000-000000000001']),
  /Admin access required/);

const grants = await one(`
  SELECT COUNT(*)::int AS count
  FROM information_schema.role_table_grants
  WHERE grantee='authenticated'
    AND table_name IN ('cancellation_settlements','cancellation_settlement_history')
`);
ok('authenticated clients have no direct settlement-table privileges', grants.count === 0, grants);

await asUser(ADMIN);
const paymentCountBefore = await one(`SELECT COUNT(*)::int AS payments FROM payment_transactions;`);
const refundCountBefore = await one(`SELECT COUNT(*)::int AS refunds FROM payment_refunds;`);
const RECORD_KEY = '30000000-0000-4000-8000-000000000002';
summary = (await one(`SELECT public.record_cancellation_settlement_decision($1,'full_refund',0,false,'Finance review',$2) AS value`,
  [cancelled.id, RECORD_KEY])).value;
ok('full-refund decision shows the remaining ₱10,000 due',
  summary.settlement_status === 'refund_due'
  && Number(summary.agreed_cancellation_fee) === 0
  && Number(summary.refund_still_due) === 10000, summary);

const paymentCountAfter = await one(`SELECT COUNT(*)::int AS payments FROM payment_transactions;`);
const refundCountAfter = await one(`SELECT COUNT(*)::int AS refunds FROM payment_refunds;`);
ok('decision confirmation creates no payment or refund',
  paymentCountBefore.payments === paymentCountAfter.payments
  && refundCountBefore.refunds === refundCountAfter.refunds,
  { paymentCountBefore, paymentCountAfter, refundCountBefore, refundCountAfter });

await one(`SELECT public.record_cancellation_settlement_decision($1,'full_refund',0,false,'Finance review',$2) AS value`,
  [cancelled.id, RECORD_KEY]);
let historyCount = await one(`SELECT COUNT(*)::int AS count FROM cancellation_settlement_history WHERE order_id=$1`, [cancelled.id]);
ok('record retry is idempotent', historyCount.count === 1, historyCount);

const AMEND_KEY = '30000000-0000-4000-8000-000000000003';
summary = (await one(`SELECT public.amend_cancellation_settlement_decision($1,'retained_fee',10000,true,'Customer agreement recorded',$2) AS value`,
  [cancelled.id, AMEND_KEY])).value;
ok('agreed ₱10,000 fee settles the remaining obligation',
  summary.settlement_status === 'refund_settled'
  && Number(summary.agreed_cancellation_fee) === 10000
  && Number(summary.refund_still_due) === 0, summary);
await one(`SELECT public.amend_cancellation_settlement_decision($1,'retained_fee',10000,true,'Customer agreement recorded',$2) AS value`,
  [cancelled.id, AMEND_KEY]);
historyCount = await one(`SELECT COUNT(*)::int AS count FROM cancellation_settlement_history WHERE order_id=$1`, [cancelled.id]);
ok('amendment retry is idempotent and durable history has old/new events', historyCount.count === 2, historyCount);

await rejects('retained-fee decision requires a positive fee',
  () => query(`SELECT public.amend_cancellation_settlement_decision($1,'retained_fee',0,true,NULL,$2)`,
    [cancelled.id, '30000000-0000-4000-8000-000000000004']),
  /positive/);
await rejects('retained-fee decision requires recorded customer agreement',
  () => query(`SELECT public.amend_cancellation_settlement_decision($1,'retained_fee',10000,false,NULL,$2)`,
    [cancelled.id, '30000000-0000-4000-8000-000000000005']),
  /confirm the customer agreement/);
await rejects('fee cannot exceed retained money or historical final charge',
  () => query(`SELECT public.amend_cancellation_settlement_decision($1,'retained_fee',34001,true,NULL,$2)`,
    [cancelled.id, '30000000-0000-4000-8000-000000000006']),
  /conflicts|exceeds/);

await asUser('', 'service_role');
await rejects('manual refund path enforces the confirmed order-level fee',
  () => query(`SELECT public.record_manual_refund($1,1,'others','Customer acknowledgement','cash',NULL,NOW(),$2,$3)`,
    [cash.id, '20000000-0000-4000-8000-000000000003', ADMIN]),
  /agreed cancellation fee|needs reconciliation/);

const providerOrder = await one(`
  INSERT INTO orders (tracking_number,shipping_cost,discount_amount,actual_weight,status,user_id)
  VALUES ('SETTLEMENT-PROVIDER-001',1000,0,10,'Cancelled',$1) RETURNING id
`, [CUSTOMER]);
const providerPayment = await one(`
  INSERT INTO payment_transactions (order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name)
  VALUES ($1,1000,'gcash','paid','pay_settlement_provider_001','paymongo','Payment System') RETURNING id
`, [providerOrder.id]);

await asUser(ADMIN);
await one(`SELECT public.record_cancellation_settlement_decision($1,'retained_fee',600,true,NULL,$2)`,
  [providerOrder.id, '30000000-0000-4000-8000-000000000007']);
await asUser('', 'service_role');
await rejects('provider refund path enforces the confirmed order-level fee',
  () => query(`SELECT public.prepare_paymongo_refund($1,500,'requested_by_customer',NULL,$2,$3)`,
    [providerPayment.id, '20000000-0000-4000-8000-000000000004', ADMIN]),
  /agreed cancellation fee/);

const PROVIDER_KEY = '20000000-0000-4000-8000-000000000005';
await one(`SELECT public.prepare_paymongo_refund($1,400,'requested_by_customer',NULL,$2,$3)`,
  [providerPayment.id, PROVIDER_KEY, ADMIN]);
await asUser(ADMIN);
summary = (await one(`SELECT public.get_cancellation_settlement_summary($1) AS value`, [providerOrder.id])).value;
ok('active provider reservation remains due and displays Refund Pending',
  summary.settlement_status === 'refund_pending'
  && Number(summary.refund_still_due) === 400
  && Number(summary.refund_in_progress) === 400
  && Number(summary.refund_not_initiated) === 0, summary);
await rejects('ordinary amendment is blocked while a refund is active',
  () => query(`SELECT public.amend_cancellation_settlement_decision($1,'retained_fee',500,true,NULL,$2)`,
    [providerOrder.id, '30000000-0000-4000-8000-000000000008']),
  /cannot be amended while a refund is pending/);

await asUser('', 'service_role');
await one(`SELECT public.mark_paymongo_refund_uncertain($1,'timeout')`, [PROVIDER_KEY]);
await asUser(ADMIN);
summary = (await one(`SELECT public.get_cancellation_settlement_summary($1) AS value`, [providerOrder.id])).value;
ok('uncertain outcome remains reserved and pending', summary.settlement_status === 'refund_pending' && Number(summary.refund_in_progress) === 400, summary);

await asUser('', 'service_role');
await one(`SELECT public.mark_paymongo_refund_failed($1,'declined','Refund failed')`, [PROVIDER_KEY]);
await asUser(ADMIN);
summary = (await one(`SELECT public.get_cancellation_settlement_summary($1) AS value`, [providerOrder.id])).value;
ok('failed refund releases reservation without counting as successful',
  summary.settlement_status === 'refund_due'
  && Number(summary.successful_refunds) === 0
  && Number(summary.refund_in_progress) === 0
  && Number(summary.refund_still_due) === 400, summary);

await asUser('', 'service_role');
const SUCCESS_KEY = '20000000-0000-4000-8000-000000000006';
await one(`SELECT public.prepare_paymongo_refund($1,400,'requested_by_customer',NULL,$2,$3)`,
  [providerPayment.id, SUCCESS_KEY, ADMIN]);
await one(`SELECT public.reconcile_paymongo_refund(
  'ref_settlement_provider_001','pay_settlement_provider_001',400,'succeeded',
  'requested_by_customer',NULL,false,'evt_settlement_success',NOW(),NOW(),$1
)`, [SUCCESS_KEY]);
await asUser(ADMIN);
summary = (await one(`SELECT public.get_cancellation_settlement_summary($1) AS value`, [providerOrder.id])).value;
ok('genuine provider success is retained and completes the obligation',
  summary.settlement_status === 'refund_settled'
  && Number(summary.successful_refunds) === 400
  && Number(summary.refund_still_due) === 0, summary);

await asUser(CUSTOMER);
summary = (await one(`SELECT public.get_cancellation_settlement_summary($1) AS value`, [cancelled.id])).value;
ok('customer sees agreed fee but database API redacts internal notes/admin id',
  Number(summary.agreed_cancellation_fee) === 10000
  && summary.internal_notes === null
  && summary.decided_by === null, summary);

const zeroOrder = await one(`
  INSERT INTO orders (tracking_number,shipping_cost,discount_amount,actual_weight,status,user_id)
  VALUES ('SETTLEMENT-ZERO-001',0,0,0,'Cancelled',$1) RETURNING id
`, [CUSTOMER]);
await asUser(ADMIN);
summary = (await one(`SELECT public.record_cancellation_settlement_decision($1,'full_refund',0,false,NULL,$2) AS value`,
  [zeroOrder.id, '30000000-0000-4000-8000-000000000009'])).value;
ok('zero-payment cancellation can settle without creating money movement',
  summary.settlement_status === 'refund_settled'
  && Number(summary.gross_collected) === 0
  && Number(summary.refund_still_due) === 0, summary);

const corruptOrder = await one(`
  INSERT INTO orders (tracking_number,shipping_cost,discount_amount,actual_weight,status,user_id)
  VALUES ('SETTLEMENT-CORRUPT-001',100,0,1,'Cancelled',$1) RETURNING id
`, [CUSTOMER]);
const corruptPayment = await one(`
  INSERT INTO payment_transactions (order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name)
  VALUES ($1,100,'gcash','paid','pay_settlement_corrupt_001','paymongo','Payment System') RETURNING id
`, [corruptOrder.id]);
await query(`
  INSERT INTO payment_refunds (
    payment_transaction_id,order_id,payment_id,refund_id,amount,status,reason,
    refund_channel,succeeded_at
  ) VALUES ($1,$2,'pay_settlement_corrupt_001','ref_settlement_corrupt_001',150,'succeeded','others','paymongo',NOW())
`, [corruptPayment.id, corruptOrder.id]);
summary = (await one(`SELECT public.get_cancellation_settlement_summary($1) AS value`, [corruptOrder.id])).value;
ok('invalid legacy arithmetic surfaces Needs Reconciliation without clamping',
  summary.settlement_status === 'needs_reconciliation'
  && Number(summary.net_retained) === -50, summary);

const definitions = await one(`
  SELECT
    pg_get_functiondef('public.record_cancellation_settlement_decision(uuid,text,numeric,boolean,text,uuid)'::regprocedure) AS decision_def,
    pg_get_functiondef('public.prepare_paymongo_refund(uuid,numeric,text,text,uuid,uuid)'::regprocedure) AS provider_def,
    pg_get_functiondef('public.record_manual_refund(uuid,numeric,text,text,text,text,timestamptz,uuid,uuid)'::regprocedure) AS manual_def
`);
ok('decision and both refund paths use the parent order serialization lock',
  /FOR UPDATE/i.test(definitions.decision_def)
  && /orders[\s\S]*FOR UPDATE/i.test(definitions.provider_def)
  && /orders[\s\S]*FOR UPDATE/i.test(definitions.manual_def));
console.log('  note - lock-order assertions are structural; embedded PGlite is not a multi-session concurrency proof.');

console.log('\\n' + passed + ' passed, ' + failed + ' failed');
await db.close();
if (failed) process.exit(1);
