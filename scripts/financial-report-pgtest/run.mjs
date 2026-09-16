import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.uid', true), '')::uuid
  $$;
  CREATE TABLE profiles(id uuid PRIMARY KEY, role text NOT NULL);
  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
    SELECT COALESCE((SELECT role='admin' FROM profiles WHERE id=auth.uid()), false)
  $$;
  CREATE TABLE orders(
    id uuid PRIMARY KEY, tracking_number text, sender_name text, receiver_name text,
    origin text, destination text, shipping_cost numeric, discount_amount numeric,
    amount_paid numeric, payment_status text, status text, created_at timestamptz
  );
  CREATE TABLE payment_transactions(
    id uuid PRIMARY KEY, order_id uuid REFERENCES orders(id), amount numeric,
    payment_method text, created_at timestamptz, payment_status text,
    transaction_reference text
  );
  CREATE TABLE payment_refunds(
    id uuid PRIMARY KEY, order_id uuid REFERENCES orders(id), amount numeric,
    updated_at timestamptz, payment_id text, refund_id text, status text,
    payment_transaction_id uuid REFERENCES payment_transactions(id)
  );
  CREATE TABLE order_status_events(order_id uuid REFERENCES orders(id), status text, changed_at timestamptz);
`);

for (const file of [
  'supabase/migrations/20260916140000_financial_report_rpc.sql',
  'supabase/migrations/20260916160000_fix_financial_report_runtime.sql',
]) await db.exec(readFileSync(file, 'utf8'));

const ADMIN = '10000000-0000-4000-8000-000000000001';
const CUSTOMER = '10000000-0000-4000-8000-000000000002';
await db.query(`INSERT INTO profiles VALUES ($1,'admin'),($2,'customer')`, [ADMIN, CUSTOMER]);

const asUser = (uid, sql, params = []) => db.transaction(async tx => {
  await tx.query(`SELECT set_config('app.uid',$1,true)`, [uid]);
  return tx.query(sql, params);
});
const report = async (start, end) => (await asUser(ADMIN,
  `SELECT get_financial_report_data($1,$2) AS value`, [start, end])).rows[0].value;

const empty = await report('2026-08-01T00:00:00+08:00', '2026-08-02T00:00:00+08:00');
assert.equal(Number(empty.grossCollected), 0);
assert.equal(Number(empty.successfulRefunds), 0);
assert.deepEqual(empty.methodTotals, []);
assert.deepEqual(empty.dailyChart, []);

const ORDER_A = '20000000-0000-4000-8000-000000000001';
const ORDER_B = '20000000-0000-4000-8000-000000000002';
const ORDER_C = '20000000-0000-4000-8000-000000000003';
await db.query(`INSERT INTO orders VALUES
 ($1,'CE-A','A','RA','Manila','Bohol',500,50,260,'partial','Delivered','2026-08-01T00:00:00Z'),
 ($2,'CE-B','B','RB','Bohol','Manila',200,0,200,'paid','Picked Up','2026-09-02T00:00:00Z'),
 ($3,'CE-C','C','RC','Manila','Bohol',999,0,999,'paid','Picked Up','2026-09-03T00:00:00+08:00')`,
 [ORDER_A, ORDER_B, ORDER_C]);
const CASH = '30000000-0000-4000-8000-000000000001';
const GCASH = '30000000-0000-4000-8000-000000000002';
await db.query(`INSERT INTO payment_transactions VALUES
 ($1,$3,100,'cash','2026-09-01T00:00:00+08:00','paid','cash-1'),
 ($2,$4,200,'gcash','2026-09-02T12:00:00+08:00','paid','gcash-1'),
 ('30000000-0000-4000-8000-000000000003',$3,50,'paylater','2026-09-02T13:00:00+08:00','partial','later-1'),
 ('30000000-0000-4000-8000-000000000004',$5,999,'cash','2026-09-03T00:00:00+08:00','paid','boundary-end')`,
 [CASH, GCASH, ORDER_A, ORDER_B, ORDER_C]);
await db.query(`INSERT INTO payment_refunds VALUES
 ('40000000-0000-4000-8000-000000000001',$1,40,'2026-09-02T14:00:00+08:00','pay-1','ref-1','succeeded',$2),
 ('40000000-0000-4000-8000-000000000002',$1,70,'2026-09-02T15:00:00+08:00','pay-1','ref-2','pending',$2),
 ('40000000-0000-4000-8000-000000000003',$1,80,'2026-09-02T16:00:00+08:00','pay-1','ref-3','failed',$2)`, [ORDER_A, CASH]);
await db.query(`INSERT INTO order_status_events VALUES ($1,'Delivered','2026-09-02T10:00:00+08:00')`, [ORDER_A]);

const data = await report('2026-09-01T00:00:00+08:00', '2026-09-03T00:00:00+08:00');
assert.equal(Number(data.grossCollected), 300, 'booking creation date must not exclude an in-period payment');
assert.equal(Number(data.successfulRefunds), 40, 'pending/failed refunds must not reduce totals');
assert.equal(Number(data.netCollected), 260);
assert.equal(Number(data.deliveredShipmentValue), 450);
assert.deepEqual(Object.fromEntries(data.methodTotals.map(row => [row.method, {
  gross: Number(row.gross), refunds: Number(row.refunds), net: Number(row.net),
  payment_count: Number(row.payment_count), refund_count: Number(row.refund_count),
}])), {
  gcash: { gross: 200, refunds: 0, net: 200, payment_count: 1, refund_count: 0 },
  cash: { gross: 100, refunds: 40, net: 60, payment_count: 1, refund_count: 1 },
});
assert.deepEqual(data.dailyChart.map(row => ({ day: String(row.day).slice(0,10), net: Number(row.net) })), [
  { day: '2026-09-01', net: 100 }, { day: '2026-09-02', net: 160 },
]);
assert.equal(data.completedDeliveries.length, 1);
assert.equal(data.paymentRefundDetail.filter(row => row.type === 'refund').length, 1);
assert.equal(data.paymentRefundDetail.some(row => Number(row.amount) === 999), false, 'exclusive end boundary must hold');

const overview = (await asUser(ADMIN, `SELECT get_sales_overview_data(2026) AS value`)).rows[0].value;
assert.equal(Number(overview.currentUnpaidBalance), 190, 'overview RPC must execute and use current balances');
assert.equal(overview.monthlyChart.length, 12);

for (const fn of [
  `get_financial_report_data('2026-09-01T00:00:00+08','2026-09-03T00:00:00+08')`,
  `get_sales_overview_data(2026)`,
]) {
  await assert.rejects(() => asUser(CUSTOMER, `SELECT ${fn}`), /Admin access required/);
}

console.log('Financial report RPC tests passed (empty, mixed methods, refund states, boundaries, authorization, both RPCs).');
await db.close();
