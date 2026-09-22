// ── record_pickup_payment() amount boundaries ──────────────────────────────
// Executable database test (PGlite — real compiled Postgres, in-memory, one
// connection). It reuses the shipping-discount harness's pre-feature schema
// and then applies the REAL migration files verbatim, ending with
// 20260922150000_pickup_payment_amount_guards.sql, so what is exercised is
// byte-for-byte the SQL that ships.
//
// Covers audit F-02 (negative amount accepted) and P-01 (no upper bound
// against the final post-weighing, post-discount payable).
//
// NOT covered here: concurrency. PGlite runs a single Postgres backend, so
// nothing in this file says anything about simultaneous sessions.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const HARNESS = path.join(REPO, 'scripts/shipping-discount-pgtest/harness-schema.sql');

const db = new PGlite();
let passed = 0, failed = 0;
const failures = [];
const ok = (desc, cond, extra) => {
  if (cond) { passed++; console.log(`  ok   ${desc}`); }
  else { failed++; failures.push(desc); console.log(`  FAIL ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
};

const asUser = (uid, fn) => db.transaction(async (tx) => {
  await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', 'authenticated', true)`, [uid || '']);
  return fn(tx);
});

console.log('== Loading harness schema + real migrations ==');
await db.exec(readFileSync(HARNESS, 'utf8'));

// payment_refunds is not part of the discount harness, but the new guard is
// refund-aware, so the real shape of the table it reads is provided here.
await db.exec(`
  CREATE TABLE payment_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    payment_transaction_id UUID,
    amount NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'succeeded',
    created_at TIMESTAMPTZ DEFAULT now()
  );
`);

for (const m of [
  '20260911010000_shipping_discount_schema.sql',
  '20260911020000_shipping_discount_guards.sql',
  '20260911030000_record_pickup_payment_discount.sql',
  '20260920120000_fix_pickup_payment_discount_race.sql',
  '20260911040000_sales_summary_discount_aware.sql',
  '20260911060218_secure_paymongo_order_metadata.sql',
  '20260912010000_discount_aware_manual_settlement.sql',
  // ── the fix under test ──
  '20260922150000_pickup_payment_amount_guards.sql',
]) {
  try { await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', m), 'utf8')); console.log(`  applied ${m}`); }
  catch (e) { console.error(`  ERROR applying ${m}: ${e.message}`); process.exit(1); }
}

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID  = '00000000-0000-0000-0000-000000000002';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);

let seq = 0;
const newOrder = async (extra = {}) => {
  const cols = ['tracking_number', 'status', 'user_id', ...Object.keys(extra)];
  const vals = [`TRK-AMT-${++seq}`, 'Assigned', CUST_ID, ...Object.values(extra)];
  const r = await db.query(
    `INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, vals);
  return r.rows[0].id;
};
const getOrder = async (id) => (await db.query(`SELECT * FROM orders WHERE id=$1`, [id])).rows[0];
const ledger = async (id) => (await db.query(
  `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total FROM payment_transactions WHERE order_id=$1`, [id])).rows[0];

function pickup(tx, params) {
  const p = {
    p_order_id: null, p_actual_weight: null, p_payment_method: 'cash', p_payer_type: 'sender',
    p_pickup_photos: '[]', p_promised_payment_date: null, p_amount: null, p_reference: null,
    p_payment_date: null, p_receipt_url: null, p_payment_type: 'Initial Payment', p_notes: 'test pickup',
    p_idempotency_key: null, p_admin_verified_receipt: false,
    p_discount_amount: 0, p_discount_reason: null, p_discount_notes: null,
    ...params,
  };
  const names = Object.keys(p);
  return tx.query(
    `SELECT * FROM record_pickup_payment(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`,
    names.map(n => p[n]));
}
const attempt = async (params) => {
  try { await asUser(ADMIN_ID, tx => pickup(tx, params)); return { ok: true, message: null }; }
  catch (e) { return { ok: false, message: e.message }; }
};

// The harness rate is ₱70/kg, so 10 kg = a ₱700 authoritative fee.
const RATE = 70;

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== F-02: negative p_amount is rejected before any mutation ==');
for (const bad of [-0.01, -25]) {
  const id = await newOrder();
  // prepare_order_insert() derives the status itself (no trip => 'Pending'),
  // so the "unchanged" assertion is against what the row ACTUALLY holds
  // before the call, not against what the INSERT asked for.
  const statusBefore = (await getOrder(id)).status;
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: bad });
  const o = await getOrder(id);
  const l = await ledger(id);
  ok(`p_amount = ${bad} is rejected`, r.ok === false, r);
  ok(`p_amount = ${bad} error names the problem`, /cannot be negative/i.test(r.message || ''), r.message);
  ok(`p_amount = ${bad} leaves status unchanged (still ${'$'}{statusBefore})`, o.status === statusBefore, o.status);
  ok(`p_amount = ${bad} leaves the order unweighed`, o.actual_weight === null, o.actual_weight);
  ok(`p_amount = ${bad} leaves the fee at 0`, Number(o.shipping_cost) === 0, o.shipping_cost);
  ok(`p_amount = ${bad} writes no ledger row`, l.n === 0, l);
}

console.log('\n== Zero / NULL keep following the existing business rules ==');
{
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: null, p_payment_method: null,
    p_promised_payment_date: '2026-10-05' });
  const o = await getOrder(id);
  ok('Pay Later (NULL amount + promise date) still succeeds', r.ok === true, r);
  ok('Pay Later records the pickup', o.status === 'Picked Up');
  ok('Pay Later prices the order from the measured weight', Number(o.shipping_cost) === 10 * RATE, o.shipping_cost);
  ok('Pay Later leaves the full fee owing', Number(o.remaining_balance) === 700, o.remaining_balance);
  ok('Pay Later writes no payment row', (await ledger(id)).n === 0);
}
{
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 0 });
  const o = await getOrder(id);
  ok('explicit zero collection still succeeds', r.ok === true, r);
  ok('zero collection records the pickup', o.status === 'Picked Up');
  ok('zero collection writes no payment row', (await ledger(id)).n === 0);
}
{
  const id = await newOrder({ payer_type: 'receiver' });
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_payer_type: 'receiver',
    p_amount: null, p_payment_method: null, p_promised_payment_date: '2026-10-05' });
  const o = await getOrder(id);
  ok('Freight Collect (payer_type receiver, nothing collected) still succeeds', r.ok === true, r);
  ok('Freight Collect keeps the receiver as payer', o.payer_type === 'receiver');
}
{
  // Fully discounted: 10 kg * ₱70 = ₱700 fee, ₱700 discount, nothing payable.
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 0,
    p_discount_amount: 700, p_discount_reason: 'Negotiated price' });
  const o = await getOrder(id);
  ok('fully discounted booking still picks up with a zero collection', r.ok === true, r);
  ok('fully discounted booking keeps its discount', Number(o.discount_amount) === 700, o.discount_amount);
  ok('fully discounted booking owes nothing', Number(o.remaining_balance) === 0, o.remaining_balance);
}

console.log('\n== Valid collections still succeed ==');
{
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700 });
  const o = await getOrder(id);
  ok('exact payment of the full ₱700 fee succeeds', r.ok === true, r);
  ok('exact payment settles the order', o.payment_status === 'paid' && Number(o.remaining_balance) === 0, o);
  ok('exact payment writes one ledger row of ₱700', (await ledger(id)).n === 1 && Number((await ledger(id)).total) === 700);
}
{
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 300,
    p_promised_payment_date: '2026-10-05' });
  const o = await getOrder(id);
  ok('partial payment of ₱300 against ₱700 succeeds', r.ok === true, r);
  ok('partial payment leaves ₱400 owing', Number(o.remaining_balance) === 400, o.remaining_balance);
  ok('partial payment is labelled partial', o.payment_status === 'partial', o.payment_status);
}
{
  // A collection ABOVE the client's pre-weighing estimate but at or below the
  // authoritative fee must still go through — this is why PickupModal does
  // not cap against its estimate.
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 12, p_amount: 840 });
  ok('a collection above a lower client estimate but equal to the real ₱840 fee succeeds', r.ok === true, r);
}
{
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 200,
    p_discount_amount: 500, p_discount_reason: 'Regular customer', p_promised_payment_date: '2026-10-05' });
  const o = await getOrder(id);
  ok('discounted booking accepts a payment of exactly the discounted ₱200 payable', r.ok === true, r);
  ok('discounted booking is fully settled by it', Number(o.remaining_balance) === 0, o.remaining_balance);
}

console.log('\n== P-01: a collection above the FINAL payable is refused ==');
{
  const id = await newOrder();
  const statusBefore = (await getOrder(id)).status;
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 1100 });
  const o = await getOrder(id);
  ok('₱1,100 against a ₱700 fee is rejected', r.ok === false, r);
  ok('the error states the excess and refuses to treat it as a tip',
    /exceeds the amount still payable by/i.test(r.message || '') && /not automatically recorded as a tip/i.test(r.message || ''),
    r.message);
  ok('the rejection names the exact ₱400.00 excess', /400\.00/.test(r.message || ''), r.message);
  ok('the rejected pickup leaves status unchanged', o.status === statusBefore && o.status !== 'Picked Up', o.status);
  ok('the rejected pickup leaves the order unweighed', o.actual_weight === null, o.actual_weight);
  ok('the rejected pickup writes no ledger row', (await ledger(id)).n === 0);
}
{
  // The cap uses the POST-DISCOUNT payable, not the gross fee.
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700,
    p_discount_amount: 500, p_discount_reason: 'Regular customer' });
  ok('the ₱700 gross fee is NOT the cap once a ₱500 discount applies', r.ok === false, r);
  ok('the excess is measured against the ₱200 discounted payable', /by ₱500\.00/.test(r.message || ''), r.message);
}
{
  // The 0.005 tolerance: a sub-half-centavo difference is rounding in the
  // weight x rate product, not a real overpayment, and must not be refused.
  // (The fee itself is ₱700.00 here — orders.shipping_cost is DECIMAL(10,2),
  // so the fractional part can only ever come from the comparison, which is
  // exactly what the tolerance exists for.)
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700.004 });
  ok('a sub-half-centavo difference is tolerated, not rejected', r.ok === true, r);
}
{
  // ...but a real centavo of excess is still an excess.
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700.01 });
  ok('one centavo above the payable is still rejected', r.ok === false, r);
}

console.log('\n== A payment already confirmed by PayMongo is preserved, never erased ==');
{
  const id = await newOrder();
  // The webhook reconciled ₱700 before the admin pressed Confirm Pickup.
  await db.query(
    `INSERT INTO payment_transactions (order_id, amount, payment_method, payment_status, payment_type, notes)
     VALUES ($1, 700, 'gcash', 'paid', 'Initial Payment', 'PayMongo webhook')`, [id]);
  // The client then finishes the pickup sending NO amount, as it does today.
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: null,
    p_payment_method: 'gcash', p_discount_amount: null });
  const o = await getOrder(id);
  const l = await ledger(id);
  ok('the pickup completes after a PayMongo settlement', r.ok === true, r);
  ok('the confirmed ₱700 payment is still on the ledger', l.n === 1 && Number(l.total) === 700, l);
  ok('the confirmed payment is not relabelled failed',
    (await db.query(`SELECT payment_status FROM payment_transactions WHERE order_id=$1`, [id])).rows[0].payment_status === 'paid');
  ok('the order is settled', o.payment_status === 'paid' && Number(o.remaining_balance) === 0, o);
}
{
  // Money already received counts toward what is owed, so a SECOND collection
  // on top of a full PayMongo settlement is the excess case and is refused —
  // without touching the settled row.
  const id = await newOrder();
  await db.query(
    `INSERT INTO payment_transactions (order_id, amount, payment_method, payment_status, payment_type, notes)
     VALUES ($1, 700, 'gcash', 'paid', 'Initial Payment', 'PayMongo webhook')`, [id]);
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 100, p_payment_method: 'cash' });
  const l = await ledger(id);
  ok('extra cash on top of a fully settled PayMongo payment is rejected', r.ok === false, r);
  ok('the already-received ₱700 is untouched by the rejection', l.n === 1 && Number(l.total) === 700, l);
}
{
  // Refund-awareness: ₱700 paid then ₱700 refunded means ₱700 is payable again.
  const id = await newOrder();
  const tx = await db.query(
    `INSERT INTO payment_transactions (order_id, amount, payment_method, payment_status, payment_type)
     VALUES ($1, 700, 'gcash', 'paid', 'Initial Payment') RETURNING id`, [id]);
  await db.query(
    `INSERT INTO payment_refunds (order_id, payment_transaction_id, amount, status)
     VALUES ($1, $2, 700, 'succeeded')`, [id, tx.rows[0].id]);
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700, p_payment_method: 'cash' });
  ok('a succeeded refund restores headroom — ₱700 is accepted again', r.ok === true, r);
}

console.log('\n== Retries do not duplicate a payment ==');
{
  const id = await newOrder();
  const key = '11111111-2222-3333-4444-555555555555';
  const first  = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700, p_idempotency_key: key });
  const second = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700, p_idempotency_key: key });
  const l = await ledger(id);
  ok('the first submission succeeds', first.ok === true, first);
  ok('the retry with the same idempotency key is a no-op, not an error', second.ok === true, second);
  ok('exactly one ledger row exists after the retry', l.n === 1 && Number(l.total) === 700, l);
}
{
  // A rejected overpayment must not consume its idempotency key — the admin
  // has to be able to correct the amount and submit again.
  const id = await newOrder();
  const key = '99999999-8888-7777-6666-555555555555';
  const bad  = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 1100, p_idempotency_key: key });
  const good = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700,  p_idempotency_key: key });
  const l = await ledger(id);
  ok('the overpayment is rejected', bad.ok === false, bad);
  ok('the corrected amount is then accepted with the same key', good.ok === true, good);
  ok('the corrected submission records exactly ₱700 once', l.n === 1 && Number(l.total) === 700, l);
}

console.log('\n== Unrelated pickup rules are unchanged ==');
{
  const id = await newOrder();
  const r = await attempt({ p_order_id: id, p_actual_weight: 0, p_amount: 100 });
  ok('a zero actual_weight is still rejected', r.ok === false && /weight must be greater than zero/i.test(r.message || ''), r);
}
{
  const id = await newOrder();
  await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 700 });
  const r = await attempt({ p_order_id: id, p_actual_weight: 10, p_amount: 100 });
  ok('a second pickup on an already-picked-up order is still rejected',
    r.ok === false && /already been picked up/i.test(r.message || ''), r);
}
{
  let denied = false;
  const custOrderId = await newOrder();
  try { await asUser(CUST_ID, tx => pickup(tx, { p_order_id: custOrderId, p_actual_weight: 10, p_amount: 700 })); }
  catch (e) { denied = /admin access required/i.test(e.message); }
  ok('a non-admin still cannot record a pickup payment', denied);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
await db.close();
if (failed) process.exit(1);
