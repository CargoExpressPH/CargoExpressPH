// Focused regression tests for the delivery-confirmation payment rule fix
// (20260915100000_allow_cash_at_delivery_confirmation.sql), run against a
// real embedded Postgres (PGlite — compiled Postgres, not a mock). Same
// approach as scripts/shipping-discount-pgtest and
// scripts/photo-gallery-pgtest: a hand-built harness schema gives just enough
// of the real orders/payment_transactions/profiles/auth shape, then the REAL
// migration files are applied verbatim on top — first 20260912010000 (the
// discount-aware baseline that still rejected cash at delivery), then
// 20260915100000 (the actual fix under test) — so what's tested is
// byte-for-byte the SQL that ships.
//
// What this file does NOT cover (see docs/audits/DELIVERY_PARTIAL_CASH_PAYMENT_FIX.md for
// the explicit list of verification gaps): the DeliveryModal/
// PaymentCollectionPanel React UI, the PayMongo webhook's own reconciliation
// path (reconcile_paymongo_payment_attempt — untouched by this fix, not
// re-tested here), and anything requiring a live/staging Supabase project.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const db = new PGlite();
let passed = 0;
let failed = 0;

function ok(desc, cond, extra) {
  if (cond) { passed += 1; console.log(`  ok - ${desc}`); }
  else { failed += 1; console.log(`  FAIL - ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function asAdmin(adminId, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', 'authenticated', true)`, [adminId]);
    return fn(tx);
  });
}

async function asAnon(fn) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', '', true), set_config('app.role', 'anon', true)`);
    return fn(tx);
  });
}

async function expectError(promise, pattern, desc) {
  try {
    await promise;
    ok(desc, false, 'expected an error, got success');
  } catch (err) {
    const msg = String(err?.message || err);
    ok(desc, pattern.test(msg), { message: msg });
  }
}

console.log('== Loading harness schema (real orders/payment_transactions/is_admin shape) ==');
await db.exec(readFileSync(path.join(HERE, 'harness-schema.sql'), 'utf8'));

console.log('== Applying 20260912010000 verbatim (discount-aware baseline, still cash-rejecting at delivery) ==');
await db.exec(readFileSync(
  path.join(REPO, 'supabase/migrations/20260912010000_discount_aware_manual_settlement.sql'), 'utf8'
));

console.log('== Applying 20260915100000 verbatim (the fix under test) ==');
await db.exec(readFileSync(
  path.join(REPO, 'supabase/migrations/20260915100000_allow_cash_at_delivery_confirmation.sql'), 'utf8'
));

const ADMIN_ID = randomUUID();
const OTHER_ADMIN_ID = randomUUID();
const CUSTOMER_ID = randomUUID();

await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin Two', 'admin')`, [OTHER_ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer', 'customer')`, [CUSTOMER_ID]);

let orderSeq = 0;
/** A fresh 'Out for Delivery' order with a given shipping_cost/discount, ready for record_delivery_payment. */
const makeOrder = async ({ shippingCost = 5496, discount = 0, amountAlreadyPaid = 0, promisedDate = null } = {}) => {
  orderSeq += 1;
  const tn = `CEX-TEST-${String(orderSeq).padStart(4, '0')}`;
  // remaining_balance/payment_status are normally maintained by
  // guard_order_update() at INSERT time (not defined in this harness — it
  // isn't touched by the fix under test), so seed the value that function
  // would already have produced for a freshly-weighed, unpaid order.
  const { rows } = await db.query(
    `INSERT INTO orders (user_id, tracking_number, receiver_name, actual_weight, shipping_cost, discount_amount, status, promised_payment_date, remaining_balance)
     VALUES ($1, $2, 'Test Receiver', 10, $3, $4, 'Out for Delivery', $5, $6)
     RETURNING id`,
    [CUSTOMER_ID, tn, shippingCost, discount, promisedDate, shippingCost - discount]
  );
  const orderId = rows[0].id;
  if (amountAlreadyPaid > 0) {
    // Seed a prior pickup-time payment directly into the ledger (bypasses
    // record_pickup_payment, which this harness doesn't define — the trigger
    // still recomputes amount_paid/remaining_balance/payment_status from it).
    await db.query(
      `INSERT INTO payment_transactions (order_id, amount, payment_method, payment_status, admin_name, payment_type)
       VALUES ($1, $2, 'cash', 'partial', 'Seed', 'Initial Payment')`,
      [orderId, amountAlreadyPaid]
    );
  }
  return orderId;
};

const deliverCash = (tx, orderId, amount, idem) => tx.query(
  `SELECT * FROM record_delivery_payment($1, $2::jsonb, 'cash', $3, NULL, CURRENT_DATE, NULL, 'Balance Settlement', 'test', NULL, $4::uuid, false)`,
  [orderId, JSON.stringify(['delivery-proofs/x/1.jpg']), amount, idem]
);

const deliverGcashManual = (tx, orderId, amount, ref, verified, idem) => tx.query(
  `SELECT * FROM record_delivery_payment($1, $2::jsonb, 'gcash', $3, $4, CURRENT_DATE, NULL, 'Balance Settlement', 'test', NULL, $5::uuid, $6)`,
  [orderId, JSON.stringify(['delivery-proofs/x/1.jpg']), amount, ref, idem, verified]
);

const additionalGcash = (tx, orderId, amount, ref, verified, idem) => tx.query(
  `SELECT * FROM record_additional_payment($1, $2, 'gcash', $3, 'settlement', CURRENT_DATE, NULL, $4::uuid, $5)`,
  [orderId, amount, ref, idem, verified]
);

const orderRow = async (orderId) => {
  const { rows } = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  return rows[0];
};

const txCount = async (orderId) => {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM payment_transactions WHERE order_id = $1`, [orderId]);
  return rows[0].n;
};

// ── 1. Full cash payment during delivery ────────────────────────────────
{
  console.log('\n-- Full cash payment during delivery --');
  const orderId = await makeOrder({ shippingCost: 1200 });
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 1200, randomUUID()));
  const order = await orderRow(orderId);
  ok('status becomes Delivered', order.status === 'Delivered');
  ok('payment_status becomes paid', order.payment_status === 'paid');
  ok('remaining_balance is 0', Number(order.remaining_balance) === 0);
  ok('amount_paid is 1200', Number(order.amount_paid) === 1200);
  const { rows } = await db.query(`SELECT payment_method, gcash_channel FROM payment_transactions WHERE order_id = $1`, [orderId]);
  ok('exactly one ledger row', rows.length === 1);
  ok('payment_method stored as cash (not mislabeled gcash)', rows[0].payment_method === 'cash');
  ok('gcash_channel is NULL for a cash row', rows[0].gcash_channel === null);
}

// ── 2. Partial cash at delivery, then GCash settlement after — the ₱5,496 example ──
{
  console.log('\n-- ₱5,496 example: ₱3,000 cash at delivery + ₱2,496 GCash after --');
  const orderId = await makeOrder({ shippingCost: 5496, promisedDate: '2099-01-01' });
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 3000, randomUUID()));
  let order = await orderRow(orderId);
  ok('Delivered after partial cash', order.status === 'Delivered');
  ok('payment_status is partial', order.payment_status === 'partial');
  ok('₱2,496 left owing', Math.abs(Number(order.remaining_balance) - 2496) < 0.005);

  await asAdmin(ADMIN_ID, (tx) => additionalGcash(tx, orderId, 2496, 'GCASH-REF-001', true, randomUUID()));
  order = await orderRow(orderId);
  ok('fully paid after the GCash settlement', order.payment_status === 'paid');
  ok('remaining_balance is 0 after settlement', Number(order.remaining_balance) === 0);
  ok('Delivered status unchanged by the later settlement', order.status === 'Delivered');

  const { rows } = await db.query(
    `SELECT amount, payment_method FROM payment_transactions WHERE order_id = $1 ORDER BY created_at`, [orderId]
  );
  ok('exactly two successful transactions', rows.length === 2);
  ok('first transaction is ₱3,000 cash', Number(rows[0].amount) === 3000 && rows[0].payment_method === 'cash');
  ok('second transaction is ₱2,496 gcash', Number(rows[1].amount) === 2496 && rows[1].payment_method === 'gcash');
  ok('totals sum to ₱5,496', Number(rows[0].amount) + Number(rows[1].amount) === 5496);

  const { rows: notifs } = await db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE reference_id = $1`, [orderId]
  );
  ok('exactly two payment notifications (one per real payment)', notifs[0].n === 2);
}

// ── 3. Pay Later, no amount collected ───────────────────────────────────
{
  console.log('\n-- Pay Later, ₱0 collected now --');
  const orderId = await makeOrder({ shippingCost: 2000, promisedDate: '2099-01-01' });
  await asAdmin(ADMIN_ID, (tx) => tx.query(
    `SELECT * FROM record_delivery_payment($1, $2::jsonb, NULL, NULL, NULL, NULL, NULL, 'Balance Settlement', 'test', $3, $4::uuid, false)`,
    [orderId, JSON.stringify(['delivery-proofs/x/1.jpg']), '2099-01-01', randomUUID()]
  ));
  const order = await orderRow(orderId);
  ok('Delivered with nothing collected', order.status === 'Delivered');
  ok('balance untouched at ₱2,000', Number(order.remaining_balance) === 2000);
  ok('payment_status stays unpaid', order.payment_status === 'unpaid');
  ok('no ledger row created', (await txCount(orderId)) === 0);
  const { rows: notifs } = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE reference_id = $1`, [orderId]);
  ok('no payment notification when nothing was collected', notifs[0].n === 0);
}

// ── 4. Verified GCash (manual reference) during delivery ───────────────
{
  console.log('\n-- Verified GCash during delivery --');
  const orderId = await makeOrder({ shippingCost: 900 });
  await asAdmin(ADMIN_ID, (tx) => deliverGcashManual(tx, orderId, 900, 'GC-DELIVERY-1', true, randomUUID()));
  const order = await orderRow(orderId);
  ok('paid in full via verified GCash', order.payment_status === 'paid' && Number(order.remaining_balance) === 0);
  const { rows } = await db.query(`SELECT payment_method, gcash_channel FROM payment_transactions WHERE order_id = $1`, [orderId]);
  ok('recorded as gcash / manual channel', rows[0].payment_method === 'gcash' && rows[0].gcash_channel === 'manual');
}

// ── 5. Unverified GCash reference is rejected (no phantom payment) ─────
{
  console.log('\n-- Unverified GCash reference is rejected --');
  const orderId = await makeOrder({ shippingCost: 900 });
  await expectError(
    asAdmin(ADMIN_ID, (tx) => deliverGcashManual(tx, orderId, 900, 'GC-UNVERIFIED', false, randomUUID())),
    /verified receipt/i,
    'unverified GCash reference raises and records nothing'
  );
  const order = await orderRow(orderId);
  ok('order NOT marked Delivered by the rejected attempt', order.status === 'Out for Delivery');
  ok('no ledger row from the rejected attempt', (await txCount(orderId)) === 0);
}

// ── 6. Previously partially paid booking — cap at the remaining balance ─
{
  console.log('\n-- Collecting only against the remaining balance --');
  const orderId = await makeOrder({ shippingCost: 5000, amountAlreadyPaid: 3000 });
  const before = await orderRow(orderId);
  ok('remaining balance is ₱2,000 before delivery', Number(before.remaining_balance) === 2000);
  await expectError(
    asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 2500, randomUUID())),
    /exceeds the outstanding balance/i,
    'collecting more than the remaining balance is rejected'
  );
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 2000, randomUUID()));
  const after = await orderRow(orderId);
  ok('exact remaining balance settles the order', after.payment_status === 'paid' && Number(after.remaining_balance) === 0);
}

// ── 7. Discounted booking uses the discounted payable amount ───────────
{
  console.log('\n-- Discounted booking: correct final payable amount --');
  const orderId = await makeOrder({ shippingCost: 1000, discount: 200 });
  // Payable is 800, not 1000 — collecting 800 in cash must fully settle it.
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 800, randomUUID()));
  const order = await orderRow(orderId);
  ok('discounted payable (₱800) is what settles the order', order.payment_status === 'paid');
  ok('remaining_balance is 0 after paying the discounted amount', Number(order.remaining_balance) === 0);
}

// ── 8. Double-click / retry of delivery confirmation — one cash tx only ─
{
  console.log('\n-- Retried delivery confirmation (same idempotency key) --');
  const orderId = await makeOrder({ shippingCost: 1500 });
  const idem = randomUUID();
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 1500, idem));
  // Simulate a dropped response / double-click: same key, same call, again.
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 1500, idem));
  ok('exactly one cash transaction despite the retry', (await txCount(orderId)) === 1);
  const order = await orderRow(orderId);
  ok('order settled correctly (not double-credited)', order.payment_status === 'paid' && Number(order.amount_paid) === 1500);
}

// ── 9. The same idempotency key cannot be reused across two different orders ──
{
  console.log('\n-- Idempotency key bound to one order --');
  const orderA = await makeOrder({ shippingCost: 500 });
  const orderB = await makeOrder({ shippingCost: 500 });
  const idem = randomUUID();
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderA, 500, idem));
  await expectError(
    asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderB, 500, idem)),
    /already associated with another order/i,
    'reusing the key for a different order is rejected, not silently accepted'
  );
  ok('order B received no ledger row', (await txCount(orderB)) === 0);
}

// ── 10. Unauthorized users cannot record cash ───────────────────────────
{
  console.log('\n-- Unauthorized access --');
  const orderId = await makeOrder({ shippingCost: 500 });
  await expectError(
    asAdmin(CUSTOMER_ID, (tx) => deliverCash(tx, orderId, 500, randomUUID())),
    /Admin access required/i,
    'a customer session cannot record a cash delivery payment'
  );
  await expectError(
    asAnon((tx) => deliverCash(tx, orderId, 500, randomUUID())),
    /Admin access required/i,
    'an anonymous session cannot record a cash delivery payment'
  );
  ok('no ledger row from either rejected attempt', (await txCount(orderId)) === 0);
}

// ── 11. Delivered booking with a balance still offers GCash settlement ──
{
  console.log('\n-- Delivered + balance owing -> GCash settlement still works --');
  const orderId = await makeOrder({ shippingCost: 4000, promisedDate: '2099-01-01' });
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 1000, randomUUID()));
  let order = await orderRow(orderId);
  ok('Delivered with ₱3,000 still owing', order.status === 'Delivered' && Number(order.remaining_balance) === 3000);
  await asAdmin(ADMIN_ID, (tx) => additionalGcash(tx, orderId, 3000, 'GC-POST-DELIVERY', true, randomUUID()));
  order = await orderRow(orderId);
  ok('fully paid via post-delivery GCash settlement', order.payment_status === 'paid');
}

// ── 12. Fully paid booking rejects a further settlement ─────────────────
{
  console.log('\n-- Fully paid booking cannot be settled again --');
  const orderId = await makeOrder({ shippingCost: 750 });
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 750, randomUUID()));
  await expectError(
    asAdmin(ADMIN_ID, (tx) => additionalGcash(tx, orderId, 1, 'GC-EXTRA', true, randomUUID())),
    /exceeds the outstanding balance/i,
    'a fully paid order rejects an additional settlement attempt'
  );
}

// ── 13. record_additional_payment still rejects cash unconditionally ────
{
  console.log('\n-- Post-delivery settlement stays GCash-only --');
  const orderId = await makeOrder({ shippingCost: 1000, promisedDate: '2099-01-01' });
  await asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, 400, randomUUID()));
  await expectError(
    asAdmin(ADMIN_ID, (tx) => tx.query(
      `SELECT * FROM record_additional_payment($1, 600, 'cash', NULL, 'test', CURRENT_DATE, NULL, $2::uuid, false)`,
      [orderId, randomUUID()]
    )),
    /Cash is no longer accepted/i,
    'cash is still rejected for a later, out-of-band settlement'
  );
}

// ── 14. Invalid inputs are rejected ─────────────────────────────────────
{
  console.log('\n-- Invalid amounts / methods --');
  const orderId = await makeOrder({ shippingCost: 500 });
  await expectError(
    asAdmin(ADMIN_ID, (tx) => deliverCash(tx, orderId, -50, randomUUID())),
    /cannot be negative/i,
    'a negative amount is rejected'
  );
  await expectError(
    asAdmin(ADMIN_ID, (tx) => tx.query(
      `SELECT * FROM record_delivery_payment($1, $2::jsonb, 'check', $3, NULL, CURRENT_DATE, NULL, 'Balance Settlement', 'test', NULL, $4::uuid, false)`,
      [orderId, JSON.stringify(['delivery-proofs/x/1.jpg']), 500, randomUUID()]
    )),
    /Unsupported payment method/i,
    "a method that is neither cash nor gcash is rejected"
  );
}

// ── 15. Delivery lifecycle guard is untouched by this fix ──────────────
{
  console.log('\n-- Lifecycle guard (not Out for Delivery) --');
  const { rows } = await db.query(
    `INSERT INTO orders (user_id, tracking_number, shipping_cost, status) VALUES ($1, 'CEX-TEST-PENDING', 500, 'Pending') RETURNING id`,
    [CUSTOMER_ID]
  );
  await expectError(
    asAdmin(ADMIN_ID, (tx) => deliverCash(tx, rows[0].id, 500, randomUUID())),
    /Out for Delivery/i,
    'an order not yet Out for Delivery cannot be delivered'
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
