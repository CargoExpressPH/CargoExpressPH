// Automatic refund recovery database tests. Applies the real migration to an
// embedded Postgres harness and exercises queue creation, leases, mode
// isolation, retry backoff, wake-up, expiry, and service-role boundaries.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
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

console.log('== Loading refund recovery harness ==');
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
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20260912184434_paymongo_refunds_and_failures.sql'), 'utf8'));

// Local stand-ins for extensions already installed in the live Supabase
// project. They record scheduling without making network requests.
await db.exec(`
  CREATE SCHEMA IF NOT EXISTS cron;
  CREATE TABLE cron.job (jobid BIGSERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT, command TEXT);
  CREATE OR REPLACE FUNCTION cron.schedule(p_jobname TEXT, p_schedule TEXT, p_command TEXT)
  RETURNS BIGINT LANGUAGE plpgsql AS $$
  DECLARE v_id BIGINT;
  BEGIN
    INSERT INTO cron.job(jobname, schedule, command)
    VALUES (p_jobname, p_schedule, p_command)
    ON CONFLICT (jobname) DO UPDATE SET schedule=EXCLUDED.schedule, command=EXCLUDED.command
    RETURNING jobid INTO v_id;
    RETURN v_id;
  END $$;
  CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname TEXT)
  RETURNS BOOLEAN LANGUAGE plpgsql AS $$
  BEGIN DELETE FROM cron.job WHERE jobname=p_jobname; RETURN FOUND; END $$;

  CREATE SCHEMA IF NOT EXISTS vault;
  CREATE TABLE vault.decrypted_secrets (name TEXT, decrypted_secret TEXT);

  CREATE SCHEMA IF NOT EXISTS net;
  CREATE OR REPLACE FUNCTION net.http_post(
    url TEXT,
    headers JSONB DEFAULT '{}'::JSONB,
    body JSONB DEFAULT '{}'::JSONB,
    timeout_milliseconds INTEGER DEFAULT 5000
  ) RETURNS BIGINT LANGUAGE sql AS $$ SELECT 1::BIGINT $$;
`);

const migration = '20260913000441_add_paymongo_refund_recovery.sql';
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', migration), 'utf8'));
console.log(`  applied ${migration}`);

const ADMIN = '10000000-0000-4000-8000-000000000001';
const CUSTOMER = '10000000-0000-4000-8000-000000000002';
await query(`INSERT INTO profiles (id,name,role) VALUES ($1,'Admin One','admin'),($2,'Customer One','customer')`, [ADMIN, CUSTOMER]);
const order = await value(`
  INSERT INTO orders (tracking_number,shipping_cost,actual_weight,status,user_id)
  VALUES ('RECOVERY-TEST-001',1000,10,'Picked Up',$1) RETURNING id
`, [CUSTOMER]);

await query(`
  INSERT INTO payment_transactions (
    order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name
  ) VALUES ($1,50,'gcash','paid','MANUAL-REF-001','manual','Admin One')
`, [order.id]);
let jobs = await value(`SELECT COUNT(*)::INT AS count FROM private.paymongo_refund_recovery_jobs`);
ok('manual GCash payment is not queued', jobs.count === 0, jobs);

const payment = await value(`
  INSERT INTO payment_transactions (
    order_id,amount,payment_method,payment_status,transaction_reference,gcash_channel,admin_name
  ) VALUES ($1,1000,'gcash','paid','pay_recovery_test_001','paymongo','System Webhook')
  RETURNING id
`, [order.id]);
jobs = await value(`SELECT COUNT(*)::INT AS count, MIN(status) AS status FROM private.paymongo_refund_recovery_jobs`);
ok('verified PayMongo payment is durably queued', jobs.count === 1 && jobs.status === 'active', jobs);

const cron = await value(`SELECT schedule, command FROM cron.job WHERE jobname='paymongo_refund_recovery'`);
ok('five-minute recovery cron is registered', cron.schedule === '*/5 * * * *' && /trigger_paymongo_refund_recovery/.test(cron.command), cron);

await query(`UPDATE private.paymongo_refund_recovery_jobs SET next_check_at=NOW() WHERE payment_transaction_id=$1`, [payment.id]);
await query(`SELECT set_config('app.role','authenticated',false)`);
let clientClaimRejected = false;
try {
  await query(`SELECT * FROM claim_paymongo_refund_recovery_jobs(15,FALSE)`);
} catch (error) {
  clientClaimRejected = /Service role required/.test(error.message);
}
ok('authenticated client cannot claim recovery work', clientClaimRejected);

await query(`SELECT set_config('app.role','service_role',false)`);
let claim = await value(`SELECT * FROM claim_paymongo_refund_recovery_jobs(15,FALSE)`);
ok('service worker claims an unclassified test-mode job', claim?.payment_id === 'pay_recovery_test_001' && claim.livemode === null, claim);
let duplicateClaim = await value(`SELECT COUNT(*)::INT AS count FROM claim_paymongo_refund_recovery_jobs(15,FALSE)`);
ok('active lease prevents a concurrent duplicate scan', duplicateClaim.count === 0, duplicateClaim);

let finished = await value(`SELECT finish_paymongo_refund_recovery_job($1,$2,TRUE,FALSE,FALSE,0,NULL) AS done`, [payment.id, claim.claim_token]);
let state = await value(`SELECT livemode,status,consecutive_failures,next_check_at FROM private.paymongo_refund_recovery_jobs WHERE payment_transaction_id=$1`, [payment.id]);
ok('successful scan records test mode and schedules the next scan', finished.done === true && state.livemode === false && state.status === 'active' && state.next_check_at, state);

await query(`UPDATE private.paymongo_refund_recovery_jobs SET next_check_at=NOW() WHERE payment_transaction_id=$1`, [payment.id]);
const liveClaim = await value(`SELECT COUNT(*)::INT AS count FROM claim_paymongo_refund_recovery_jobs(15,TRUE)`);
ok('live worker cannot claim a test-mode payment', liveClaim.count === 0, liveClaim);

claim = await value(`SELECT * FROM claim_paymongo_refund_recovery_jobs(15,FALSE)`);
finished = await value(`SELECT finish_paymongo_refund_recovery_job($1,$2,FALSE,FALSE,FALSE,0,'provider unavailable') AS done`, [payment.id, claim.claim_token]);
state = await value(`SELECT status,consecutive_failures,last_error,claim_token FROM private.paymongo_refund_recovery_jobs WHERE payment_transaction_id=$1`, [payment.id]);
ok('provider failure releases the lease and remains retryable', finished.done === true && state.status === 'active' && state.consecutive_failures === 1 && /provider unavailable/.test(state.last_error) && state.claim_token === null, state);

await query(`
  UPDATE private.paymongo_refund_recovery_jobs
  SET scan_until=NOW()-INTERVAL '1 minute', next_check_at=NOW()
  WHERE payment_transaction_id=$1
`, [payment.id]);
claim = await value(`SELECT * FROM claim_paymongo_refund_recovery_jobs(15,FALSE)`);
await query(`SELECT finish_paymongo_refund_recovery_job($1,$2,TRUE,FALSE,FALSE,0,NULL)`, [payment.id, claim.claim_token]);
state = await value(`SELECT status,next_check_at FROM private.paymongo_refund_recovery_jobs WHERE payment_transaction_id=$1`, [payment.id]);
ok('expired payment completes only after a successful final scan', state.status === 'completed' && state.next_check_at === null, state);

const IDEMPOTENCY_KEY = '20000000-0000-4000-8000-000000000777';
await query(`SELECT prepare_paymongo_refund($1,100,'requested_by_customer','Recovery wake test',$2,$3)`, [payment.id, IDEMPOTENCY_KEY, ADMIN]);
state = await value(`SELECT status,next_check_at,scan_until FROM private.paymongo_refund_recovery_jobs WHERE payment_transaction_id=$1`, [payment.id]);
ok('unresolved refund reactivates a completed payment job', state.status === 'active' && state.next_check_at !== null && Date.parse(state.scan_until) > Date.now(), state);

await query(`UPDATE private.paymongo_refund_recovery_jobs SET next_check_at=NOW() WHERE payment_transaction_id=$1`, [payment.id]);
claim = await value(`SELECT * FROM claim_paymongo_refund_recovery_jobs(15,FALSE)`);
await query(`SELECT finish_paymongo_refund_recovery_job($1,$2,TRUE,FALSE,TRUE,0,NULL)`, [payment.id, claim.claim_token]);
state = await value(`SELECT status,next_check_at FROM private.paymongo_refund_recovery_jobs WHERE payment_transaction_id=$1`, [payment.id]);
ok('unresolved refund keeps recovery active regardless of expiry', state.status === 'active' && state.next_check_at !== null, state);

await query(`SELECT mark_paymongo_refund_request($1,'failed','test complete')`, [IDEMPOTENCY_KEY]);
const health = await value(`SELECT get_paymongo_refund_recovery_health() AS payload`);
ok('service health reports no unresolved refund after terminal failure', Number(health.payload.unresolvedRefunds) === 0, health.payload);

await query(`SELECT reconcile_paymongo_refund(
  'ref_recovery_message_001','pay_recovery_test_001',100,'succeeded',
  'requested_by_customer','Recovery wake test',FALSE,NULL,NOW(),NOW(),$1
)`, [IDEMPOTENCY_KEY]);
const notice = await value(`
  SELECT title,message FROM notifications WHERE payment_refund_id IS NOT NULL
  ORDER BY id DESC LIMIT 1
`);
ok(
  'customer notification reserves confirmation wording for provider success',
  notice.title === 'Refund Completed'
    && /PayMongo confirmed/.test(notice.message)
    && /posting to the original GCash account may take additional time/i.test(notice.message),
  notice,
);

console.log(`\n${passed} passed, ${failed} failed`);
await db.close();
if (failed) process.exit(1);
