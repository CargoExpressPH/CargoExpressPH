// Shipping-discount feature — focused regression tests.
//
// Same approach as scripts/payment-ledger-pgtest: a real embedded Postgres
// (PGlite — compiled Postgres, not a mock) running a hand-built "before"
// schema (harness-schema.sql, which is the pre-feature production SQL
// verbatim: prepare_order_insert / guard_order_update / record_pickup_payment
// / update_order_payment_totals / reconcile_paymongo_payment_attempt /
// get_sales_summary as they were BEFORE this feature), then the four REAL new
// migration files are applied verbatim on top. What is tested is therefore
// byte-for-byte the SQL that ships, both before and after, so several
// scenarios diff "before" against "after" to prove the discount is additive
// and does not disturb undiscounted orders.
//
// IMPORTANT: record_pickup_payment is called with NAMED parameter syntax
// (`p_order_id => $1, ...`) everywhere in this file, never bare positional
// arguments. record_pickup_payment now has THREE overloads on this database
// (12-param from 20260803100000, 14-param from 20260909030000, 17-param from
// 20260911030000 — see that migration's own "SIGNATURE NOTE" for why the
// older two were never dropped). A positional call with exactly 12 or 14
// arguments is AMBIGUOUS-LOOKING but actually resolves deterministically to
// whichever overload needs the fewest defaulted parameters for that argument
// count — i.e. a bare positional call will silently hit an OLDER overload
// that has neither discount support nor (for the 12-param one) idempotency-
// key/manual-GCash-verification support. Named parameters are the only way
// to guarantee this test is exercising the CURRENT function.
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
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', $2, true)`, [uid || '', role || 'authenticated']);
    return fn(tx);
  });
}

console.log('== Loading pre-feature harness schema ==');
await db.exec(readFileSync(path.join(HERE, 'harness-schema.sql'), 'utf8'));

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID  = '00000000-0000-0000-0000-000000000002';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);

async function newOrder(tracking, extra = {}) {
  const r = await db.query(
    `INSERT INTO orders (tracking_number, status, user_id) VALUES ($1, 'Assigned', $2) RETURNING id`,
    [tracking, CUST_ID]
  );
  return r.rows[0].id;
}

async function getOrder(orderId) {
  const r = await db.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  return r.rows[0];
}

async function countTx(orderId) {
  const r = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total FROM payment_transactions WHERE order_id=$1`, [orderId]);
  return r.rows[0];
}

/** Named-parameter pickup call against the PRE-migration 14-param overload only — used for the one baseline call below, before the discount migrations are applied. */
function pickupLegacy(tx, params) {
  const p = {
    p_order_id: null, p_actual_weight: null, p_payment_method: 'cash', p_payer_type: 'sender',
    p_pickup_photos: '[]', p_promised_payment_date: null, p_amount: null, p_reference: null,
    p_payment_date: null, p_receipt_url: null, p_payment_type: 'Initial Payment', p_notes: 'test pickup',
    p_idempotency_key: null, p_admin_verified_receipt: false,
    ...params,
  };
  const names = Object.keys(p);
  const args = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  const values = names.map(n => p[n]);
  return tx.query(`SELECT * FROM record_pickup_payment(${args})`, values);
}

/** Named-parameter pickup call against whatever record_pickup_payment overload is live right now (post-migration, 17-param). */
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
  const args = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  const values = names.map(n => p[n]);
  return tx.query(`SELECT * FROM record_pickup_payment(${args})`, values);
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== BASELINE (pre-migration): establish "before" behaviour ==');
let baselineOrderId;
{
  baselineOrderId = await newOrder('TRK-BASE-1');
  await asUser(ADMIN_ID, 'authenticated', tx => pickupLegacy(tx, {
    p_order_id: baselineOrderId, p_actual_weight: 10, p_amount: 700, p_payment_type: 'Initial Payment',
  }));
  const o = await getOrder(baselineOrderId);
  ok('baseline: shipping_cost = 700 (10kg * ₱70)', Number(o.shipping_cost) === 700, o);
  ok('baseline: amount_paid = 700', Number(o.amount_paid) === 700);
  ok('baseline: payment_status = paid', o.payment_status === 'paid');
}

console.log('\n== Applying real shipping-discount migrations verbatim ==');
const migrations = [
  '20260911010000_shipping_discount_schema.sql',
  '20260911020000_shipping_discount_guards.sql',
  '20260911030000_record_pickup_payment_discount.sql',
  '20260911040000_sales_summary_discount_aware.sql',
  '20260911060218_secure_paymongo_order_metadata.sql',
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

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== Scenario: existing historical order is completely unchanged by the migration ==');
{
  const o = await getOrder(baselineOrderId);
  ok('historical order: discount_amount defaulted to 0', Number(o.discount_amount) === 0, o.discount_amount);
  ok('historical order: discount_reason is NULL', o.discount_reason === null);
  ok('historical order: shipping_cost still 700 (not recomputed)', Number(o.shipping_cost) === 700);
  ok('historical order: amount_paid still 700', Number(o.amount_paid) === 700);
  ok('historical order: remaining_balance still 0', Number(o.remaining_balance) === 0);
  ok('historical order: payment_status still paid', o.payment_status === 'paid');
}

console.log('\n== Scenario: NO discount preserves existing behaviour (regression) ==');
{
  const orderId = await newOrder('TRK-NODISC');
  const res = await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: orderId, p_actual_weight: 10, p_amount: 700,
  }));
  const o = res.rows[0];
  ok('no-discount pickup: shipping_cost = 700', Number(o.shipping_cost) === 700);
  ok('no-discount pickup: amount_paid = 700', Number(o.amount_paid) === 700);
  ok('no-discount pickup: remaining_balance = 0', Number(o.remaining_balance) === 0);
  ok('no-discount pickup: payment_status = paid', o.payment_status === 'paid');
  ok('no-discount pickup: discount_amount = 0', Number(o.discount_amount) === 0);
}

console.log('\n== Scenario: the ₱1,000 / ₱100 / ₱400 example produces a ₱500 balance ==');
let exampleOrderId;
{
  exampleOrderId = await newOrder('TRK-EXAMPLE');
  // 1000 = weight(kg) * 70/kg is awkward; use a trip with an explicit rate of
  // 100/kg over 10kg so the original fee is exactly ₱1,000.
  const trip = await db.query(`INSERT INTO trips (price_per_kg, capacity) VALUES (100, 0) RETURNING id`);
  await db.query(`UPDATE orders SET trip_id=$1 WHERE id=$2`, [trip.rows[0].id, exampleOrderId]);

  const res = await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: exampleOrderId, p_actual_weight: 10, p_amount: 400,
    p_discount_amount: 100, p_discount_reason: 'Regular customer',
  }));
  const o = res.rows[0];
  ok('example: original fee (shipping_cost) = 1000', Number(o.shipping_cost) === 1000, o.shipping_cost);
  ok('example: discount_amount = 100', Number(o.discount_amount) === 100);
  ok('example: discount_reason stored', o.discount_reason === 'Regular customer');
  ok('example: discount_applied_by = admin', o.discount_applied_by === ADMIN_ID);
  ok('example: amount_paid = 400', Number(o.amount_paid) === 400);
  ok('example: remaining_balance = 500 (900 payable − 400 paid)', Number(o.remaining_balance) === 500, o.remaining_balance);
  ok('example: payment_status = partial', o.payment_status === 'partial');
  const c = await countTx(exampleOrderId);
  ok('example: exactly one ledger row for ₱400 (not ₱1000, not ₱900)', c.n === 1 && Number(c.total) === 400, c);
}

console.log('\n== Scenario: settling the remaining ₱500 via a later GCash payment (record via reconcile) ==');
{
  const attempt = await db.query(
    `INSERT INTO payment_attempts (source_id, order_id, amount, payment_type, status) VALUES ('src_ex_1',$1,500,'full','pending')`,
    [exampleOrderId]
  );
  await asUser(null, 'service_role', tx =>
    tx.query(`SELECT * FROM reconcile_paymongo_payment_attempt($1,$2,$3,$4)`, ['src_ex_1', 'pay_ex_1', 500, 'paid'])
  );
  const o = await getOrder(exampleOrderId);
  ok('after settling: amount_paid = 900 (400 + 500)', Number(o.amount_paid) === 900, o.amount_paid);
  ok('after settling: remaining_balance = 0', Number(o.remaining_balance) === 0);
  ok('after settling: payment_status = paid (against the DISCOUNTED 900, not 1000)', o.payment_status === 'paid');
  const c = await countTx(exampleOrderId);
  ok('ledger has exactly two payments totalling ₱900, not ₱1000', c.n === 2 && Number(c.total) === 900, c);
}

console.log('\n== Scenario: exact full payment of the discounted fee in one shot ==');
{
  const orderId = await newOrder('TRK-EXACT');
  const res = await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: orderId, p_actual_weight: 10, p_amount: 600,
    p_discount_amount: 100, p_discount_reason: 'Negotiated price',
  }));
  const o = res.rows[0];
  ok('exact payment: shipping_cost = 700, discount = 100, paid = 600 → paid in full', Number(o.shipping_cost) === 700 && Number(o.amount_paid) === 600 && o.payment_status === 'paid' && Number(o.remaining_balance) === 0, o);
}

console.log('\n== Scenario: 100% discount produces no payment due and no payment record ==');
{
  const orderId = await newOrder('TRK-FULLDISC');
  const res = await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: orderId, p_actual_weight: 10, p_amount: null,
    p_discount_amount: 700, p_discount_reason: 'Other', p_discount_notes: 'Damaged in prior shipment — goodwill waiver',
  }));
  const o = res.rows[0];
  ok('100% discount: remaining_balance = 0', Number(o.remaining_balance) === 0);
  ok('100% discount: amount_paid = 0 (a discount is not a payment)', Number(o.amount_paid) === 0);
  ok('100% discount: payment_status is NOT "paid" from money (derive_payment_status: amount_paid<=0 → unpaid; UI renders "No Payment Due" instead — see customer/admin OrderDetailPage)', o.payment_status === 'unpaid');
  const c = await countTx(orderId);
  ok('100% discount: zero ledger rows created', c.n === 0, c);
}

console.log('\n== Scenario: invalid / negative / excessive / missing discount inputs are rejected ==');
{
  const orderId = await newOrder('TRK-INVALID');
  let negRejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 10, p_discount_amount: -50, p_discount_reason: 'Other', p_discount_notes: 'x',
    }));
  } catch (e) { negRejected = /negative/i.test(e.message); }
  ok('negative discount is rejected', negRejected);

  let excessiveRejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 10, p_discount_amount: 5000, p_discount_reason: 'Other', p_discount_notes: 'x',
    }));
  } catch (e) { excessiveRejected = /cannot exceed/i.test(e.message); }
  ok('discount exceeding the original fee (₱700 for 10kg) is rejected', excessiveRejected);

  let missingReasonRejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 10, p_discount_amount: 100, p_discount_reason: null,
    }));
  } catch (e) { missingReasonRejected = /requires a reason/i.test(e.message); }
  ok('a positive discount with no reason is rejected', missingReasonRejected);

  let badReasonRejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 10, p_discount_amount: 100, p_discount_reason: 'Because I felt like it',
    }));
  } catch (e) { badReasonRejected = /requires a reason/i.test(e.message); }
  ok('a reason outside the fixed set is rejected', badReasonRejected);

  let missingNotesRejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 10, p_discount_amount: 100, p_discount_reason: 'Other', p_discount_notes: '   ',
    }));
  } catch (e) { missingNotesRejected = /explain the discount reason/i.test(e.message); }
  ok('"Other" with a blank explanation is rejected', missingNotesRejected);

  // Confirm the order was left completely untouched by every rejected attempt.
  // (newOrder() has no trip_id, so prepare_order_insert leaves status 'Pending'.)
  const o = await getOrder(orderId);
  ok('none of the rejected attempts left the order picked up or discounted', o.status === 'Pending' && Number(o.discount_amount) === 0 && o.actual_weight === null, o);
}

console.log('\n== Scenario: a failed pickup call does not partially save weight, discount, or payment (atomicity) ==');
{
  const orderId = await newOrder('TRK-ATOMIC');
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 10, p_amount: 300, p_payment_method: 'cash',
      p_discount_amount: 9999, p_discount_reason: 'Other', p_discount_notes: 'too much',
    }));
  } catch (e) { rejected = true; }
  ok('the over-limit discount attempt was rejected', rejected);
  const o = await getOrder(orderId);
  ok('actual_weight was NOT saved', o.actual_weight === null, o.actual_weight);
  ok('status is still pre-pickup (Pending)', o.status === 'Pending', o.status);
  ok('discount_amount is still 0', Number(o.discount_amount) === 0);
  const c = await countTx(orderId);
  ok('no ledger row was created for the rejected attempt', c.n === 0, c);
}

console.log('\n== Scenario: toggle OFF clears the effective discount even if reason/notes are (incorrectly) still sent ==');
{
  const orderId = await newOrder('TRK-TOGGLEOFF');
  const res = await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: orderId, p_actual_weight: 10, p_amount: 700,
    // Simulates a client bug: amount is 0 but reason/notes were left set.
    p_discount_amount: 0, p_discount_reason: 'Other', p_discount_notes: 'stale value',
  }));
  const o = res.rows[0];
  ok('discount_amount stays 0', Number(o.discount_amount) === 0);
  ok('discount_reason is forced to NULL server-side, not the stale value', o.discount_reason === null, o.discount_reason);
  ok('discount_notes is forced to NULL server-side', o.discount_notes === null, o.discount_notes);
}

console.log('\n== Scenario: weight change correctly revalidates the discount ==');
{
  // A discount valid for a 10kg/₱700 parcel becomes invalid if it turns out
  // to actually weigh only 1kg (₱70) — the server must reject it, not
  // silently shrink the discount to fit.
  const orderId = await newOrder('TRK-REWEIGH');
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 1, p_discount_amount: 100, p_discount_reason: 'Other', p_discount_notes: 'x',
    }));
  } catch (e) { rejected = /cannot exceed/i.test(e.message); }
  ok('a discount that exceeds the fee for the ACTUAL weight is rejected, not silently reduced', rejected);
}

console.log('\n== Scenario: customer cannot apply a discount (or call record_pickup_payment at all) ==');
{
  const orderId = await newOrder('TRK-CUSTBLOCK');
  let rejected = false;
  try {
    await asUser(CUST_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 10, p_discount_amount: 50, p_discount_reason: 'Other', p_discount_notes: 'x',
    }));
  } catch (e) { rejected = /Admin access required/.test(e.message); }
  ok('a customer session is rejected outright (admin-only)', rejected);
}

console.log('\n== Scenario: confirmed pickup makes the discount read-only, even via a raw UPDATE ==');
{
  const orderId = await newOrder('TRK-LOCKED');
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: orderId, p_actual_weight: 10, p_amount: 700,
  }));
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx =>
      tx.query(`UPDATE orders SET discount_amount = 50, discount_reason = 'Regular customer' WHERE id = $1`, [orderId])
    );
  } catch (e) { rejected = /can only be set or changed before pickup/i.test(e.message); }
  ok('a raw UPDATE to discount_amount after pickup is rejected — not only the UI hiding the field', rejected);

  let secondPickupRejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: orderId, p_actual_weight: 10, p_discount_amount: 50, p_discount_reason: 'Regular customer',
    }));
  } catch (e) { secondPickupRejected = /already been picked up/i.test(e.message); }
  ok('calling record_pickup_payment a second time on an already-picked-up order is rejected', secondPickupRejected);
}

console.log('\n== Scenario: an existing payment blocks a discount edit even at a pre-pickup status (defense in depth) ==');
{
  // Contrived: directly insert a ledger row against a pre-pickup order to
  // exercise the EXISTS(payment_transactions) guard on its own, independent
  // of the status guard above. This state cannot arise through the app (an
  // order is unpriced, and cannot be paid, before pickup) — it proves the
  // second, independent guard actually fires if it ever could.
  const orderId = await newOrder('TRK-HASPAYMENT');
  await db.query(
    `INSERT INTO payment_transactions (order_id, amount, payment_method, payment_status, admin_name) VALUES ($1, 100, 'cash', 'partial', 'Test')`,
    [orderId]
  );
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx =>
      tx.query(`UPDATE orders SET discount_amount = 50, discount_reason = 'Regular customer' WHERE id = $1`, [orderId])
    );
  } catch (e) { rejected = /already has a recorded payment/i.test(e.message); }
  ok('a recorded payment blocks a discount change even before the status guard alone would', rejected);
}

console.log('\n== Scenario: duplicate payment requests still produce one credit (idempotency preserved) ==');
{
  const orderId = await newOrder('TRK-IDEMPOTENT');
  const key = '11111111-1111-1111-1111-111111111111';
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: orderId, p_actual_weight: 10, p_amount: 400,
    p_discount_amount: 100, p_discount_reason: 'Regular customer', p_idempotency_key: key,
  }));
  // Retried submission — same key, e.g. a double-click or a dropped response.
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: orderId, p_actual_weight: 10, p_amount: 400,
    p_discount_amount: 100, p_discount_reason: 'Regular customer', p_idempotency_key: key,
  }));
  const c = await countTx(orderId);
  ok('exactly one ledger row despite the retried call', c.n === 1 && Number(c.total) === 400, c);
  const o = await getOrder(orderId);
  ok('discount is still 100 (unaffected by the retry)', Number(o.discount_amount) === 100);
}

console.log('\n== Scenario: manual GCash duplicate-reference protection still works on the discount-aware function ==');
{
  const order1 = await newOrder('TRK-DUPEREF-1');
  const order2 = await newOrder('TRK-DUPEREF-2');
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: order1, p_actual_weight: 10, p_payment_method: 'gcash', p_amount: 700,
    p_reference: 'GC-DUP-1', p_admin_verified_receipt: true,
  }));
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
      p_order_id: order2, p_actual_weight: 10, p_payment_method: 'gcash', p_amount: 700,
      p_reference: 'gc dup 1', p_admin_verified_receipt: true,
    }));
  } catch (e) { rejected = /already recorded against order|already recorded on another order/i.test(e.message); }
  ok('the same GCash reference cannot fund a second order, even with the new discount params present', rejected);
}

console.log('\n== Scenario: discount-only pickup creates no payment notification; a real payment creates exactly one showing the discounted balance ==');
{
  // Discount-only: no money, no notification.
  const discOnly = await newOrder('TRK-NOTIFY-DISCOUNT-ONLY');
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: discOnly, p_actual_weight: 10, p_amount: null,
    p_discount_amount: 200, p_discount_reason: 'Regular customer',
  }));
  const n1 = await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE reference_id = $1`, [discOnly]);
  ok('a discount-only pickup (no money collected) creates zero notifications', n1.rows[0].n === 0, n1.rows[0]);

  // Discount + partial payment: exactly one notification, showing the
  // DISCOUNTED remaining balance (700 fee − 100 discount − 300 paid = 300).
  const discPlusPay = await newOrder('TRK-NOTIFY-DISCOUNT-PAY');
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: discPlusPay, p_actual_weight: 10, p_amount: 300,
    p_discount_amount: 100, p_discount_reason: 'Negotiated price',
  }));
  const n2 = await db.query(`SELECT message FROM notifications WHERE reference_id = $1`, [discPlusPay]);
  ok('exactly one notification for the one real payment', n2.rows.length === 1, n2.rows);
  ok('the notification states the DISCOUNTED remaining balance (₱300.00), not the pre-discount one (₱400.00)',
    n2.rows[0] && /₱300\.00/.test(n2.rows[0].message) && !/₱400\.00/.test(n2.rows[0].message), n2.rows[0]);

  // A duplicate/retried submission of the SAME payment must still be exactly
  // one notification (ties to the earlier idempotency scenario's ledger dedup).
  const key = '22222222-2222-2222-2222-222222222222';
  const dupeNotify = await newOrder('TRK-NOTIFY-DUPE');
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: dupeNotify, p_actual_weight: 10, p_amount: 700, p_idempotency_key: key,
  }));
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: dupeNotify, p_actual_weight: 10, p_amount: 700, p_idempotency_key: key,
  }));
  const n3 = await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE reference_id = $1`, [dupeNotify]);
  ok('a retried identical payment still produces exactly one notification', n3.rows[0].n === 1, n3.rows[0]);
}

console.log('\n== Scenario: get_sales_summary() reports discount-aware, consistent figures ==');
{
  const r = await asUser(ADMIN_ID, 'authenticated', tx => tx.query(`SELECT get_sales_summary() AS payload`));
  const summary = r.rows[0].payload.summary;
  // Sum of every order's (shipping_cost - discount_amount) across every
  // fixture created above, independently computed here for comparison.
  const check = await db.query(`
    SELECT
      COALESCE(SUM(GREATEST(shipping_cost - discount_amount, 0)), 0)::numeric AS net_revenue,
      COALESCE(SUM(discount_amount), 0)::numeric AS total_discounts,
      COALESCE(SUM(amount_paid), 0)::numeric AS paid_total
    FROM orders WHERE status <> 'Cancelled'
  `);
  const expected = check.rows[0];
  ok('totalRevenue is net of discount and matches an independent SUM', Math.abs(Number(summary.totalRevenue) - Number(expected.net_revenue)) < 0.01, { summary: summary.totalRevenue, expected: expected.net_revenue });
  ok('totalDiscounts matches an independent SUM(discount_amount)', Math.abs(Number(summary.totalDiscounts) - Number(expected.total_discounts)) < 0.01, { summary: summary.totalDiscounts, expected: expected.total_discounts });
  ok('paidTotal is unaffected by discount (pure ledger sum)', Math.abs(Number(summary.paidTotal) - Number(expected.paid_total)) < 0.01);
  ok('a discount never appears as collected money: totalDiscounts + paidTotal are reported separately, not merged', typeof summary.totalDiscounts === 'number' && typeof summary.paidTotal === 'number');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
console.log('All shipping-discount checks passed.');
