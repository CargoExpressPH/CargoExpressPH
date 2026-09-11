// Payment ledger integrity regression tests — BUG-01 fix + manual payment
// hardening (see PAYMENT_DUPLICATE_PREVENTION_FIX.md).
//
// Runs the ACTUAL migration files in supabase/migrations verbatim against a
// real embedded Postgres (PGlite — a full Postgres compiled to WASM, not a
// mock), on top of a minimal hand-built schema (harness-schema.sql) covering
// just what the payment RPCs touch. This exercises the real trigger/RPC SQL,
// not a JS re-implementation of it.
//
// Known limitation: PGlite serializes all transactions through one
// connection, so tests that use `Promise.all([...])` to model "concurrent"
// calls prove the FUNCTION's logic is correct once Postgres's row lock has
// serialized two callers (which is what SELECT ... FOR UPDATE guarantees in
// real Postgres) — they do not exercise true multi-backend lock contention.
// See PAYMENT_DUPLICATE_PREVENTION_FIX.md for what remains unverified.
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

console.log('== Loading base harness schema ==');
await db.exec(readFileSync(path.join(HERE, 'harness-schema.sql'), 'utf8'));

console.log('== Applying real migrations verbatim ==');
const migrations = [
  '20260909010000_payment_ledger_integrity_columns.sql',
  '20260909020000_fix_paymongo_reconciliation_idempotency.sql',
  '20260909030000_manual_payment_hardening.sql',
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
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID  = '00000000-0000-0000-0000-000000000002';

await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);

async function newOrder(tracking, shippingCost = 1000) {
  const r = await db.query(
    `INSERT INTO orders (tracking_number, shipping_cost, status, user_id) VALUES ($1, $2, 'Assigned', $3) RETURNING id`,
    [tracking, shippingCost, CUST_ID]
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
    tx.query(
      `SELECT * FROM reconcile_paymongo_payment_attempt($1,$2,$3,$4)`,
      [sourceId, paymentId, amount, status]
    )
  );
}

async function countTx(orderId) {
  const r = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total FROM payment_transactions WHERE order_id=$1`, [orderId]);
  return r.rows[0];
}

async function getOrder(orderId) {
  const r = await db.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  return r.rows[0];
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== Scenario: same successful PayMongo payment processed twice (identical id) ==');
{
  const orderId = await newOrder('TRK-001', 1000);
  await newAttempt('src_001', orderId, 1000);
  await reconcile('src_001', 'pay_001', 1000, 'paid');
  await reconcile('src_001', 'pay_001', 1000, 'paid'); // exact repeat
  const c = await countTx(orderId);
  ok('exactly one ledger row after processing the same payment twice', c.n === 1, c);
  ok('amount_paid is 1000, not 2000', Number((await getOrder(orderId)).amount_paid) === 1000);
}

console.log('\n== Scenario: BUG-01 synthetic-vs-real reference race ==');
{
  const orderId = await newOrder('TRK-002', 1000);
  await newAttempt('src_002', orderId, 1000);
  // Simulate the OLD exploit shape directly against the FIXED function: try
  // to reconcile with a synthetic auto_ reference first.
  let synthRejected = false;
  try {
    await reconcile('src_002', 'auto_src_002', 1000, 'paid');
  } catch (e) {
    synthRejected = /Synthetic payment references/.test(e.message);
  }
  ok('a synthetic auto_<sourceId> reference is rejected outright', synthRejected);

  // Now the REAL payment.paid webhook reconciles with the true id — first
  // legitimate reconciliation for this attempt.
  await reconcile('src_002', 'pay_real_002', 1000, 'paid');
  // A delayed/duplicate delivery of the same real event, or a second
  // internal path racing in behind it, tries again with a DIFFERENT
  // reference (modelling: "if the old code's self-heal had still run").
  await reconcile('src_002', 'pay_other_002', 1000, 'paid');
  const c = await countTx(orderId);
  ok('still exactly one ledger row despite a second reconcile with a different reference', c.n === 1, c);
  ok('amount_paid is 1000, not 2000', Number((await getOrder(orderId)).amount_paid) === 1000);
}

console.log('\n== Scenario: webhook and poll "racing" on the same source (serialized by the lock), both call reconcile ==');
{
  const orderId = await newOrder('TRK-003', 500);
  await newAttempt('src_003', orderId, 500);
  // Both "sides" of the race only ever learn the REAL id from their own
  // synchronous capture response in production; simulate the winner
  // reconciling first with the real id, then the loser's independent
  // payment.paid handling reconciling again with the SAME real id (webhook
  // redelivery / both internal paths observed the same successful capture).
  const [r1, r2] = await Promise.all([
    reconcile('src_003', 'pay_003', 500, 'paid'),
    reconcile('src_003', 'pay_003', 500, 'paid'),
  ]);
  const c = await countTx(orderId);
  ok('concurrent reconcile calls for the same source+payment produce one row', c.n === 1, c);
  ok('both calls report order_reconciled = true', r1.rows[0].order_reconciled === true && r2.rows[0].order_reconciled === true);
}

console.log('\n== Scenario: delayed/repeated webhook after successful reconciliation ==');
{
  const orderId = await newOrder('TRK-004', 750);
  await newAttempt('src_004', orderId, 750);
  await reconcile('src_004', 'pay_004', 750, 'paid');
  // Days-later redelivery of the same payment.paid event.
  const late = await reconcile('src_004', 'pay_004', 750, 'paid');
  const c = await countTx(orderId);
  ok('redelivered webhook after success is a no-op', c.n === 1, c);
  ok('redelivered webhook still reports success (idempotent response)', late.rows[0].order_reconciled === true);
}

console.log('\n== Scenario: unverified/ambiguous provider response produces no credit ==');
{
  const orderId = await newOrder('TRK-005', 300);
  await newAttempt('src_005', orderId, 300);
  // No p_payment_id at all — models "source status checked but not actually
  // captured" (the edge-function fix's self-heal-without-capture path).
  await reconcile('src_005', null, 300, 'pending');
  const c = await countTx(orderId);
  ok('no payment_id means no ledger row', c.n === 0, c);
  ok('order remains unpaid', (await getOrder(orderId)).payment_status === 'unpaid');
}

console.log('\n== Scenario: failed/pending payment produces no credit ==');
{
  const orderId = await newOrder('TRK-006', 300);
  await newAttempt('src_006', orderId, 300);
  const r = await reconcile('src_006', null, 0, 'failed');
  ok('failed capture reports order_reconciled=false when no payment_id given', r.rows[0].order_reconciled === false);
  const c = await countTx(orderId);
  ok('no ledger row for a failed/pending capture', c.n === 0);
}

console.log('\n== Scenario: ₱400 pickup + ₱600 later GCash payment = exactly ₱1,000 (two records) ==');
{
  const orderId = await newOrder('TRK-007', 1000);
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(
      `SELECT record_pickup_payment($1, 10, 'cash', 'sender', '[]'::jsonb, NULL, 400, NULL, CURRENT_DATE, NULL, 'Initial Payment', 'pickup cash')`,
      [orderId]
    )
  );
  await newAttempt('src_007', orderId, 600);
  await reconcile('src_007', 'pay_007', 600, 'paid');
  const c = await countTx(orderId);
  const order = await getOrder(orderId);
  ok('exactly two ledger rows (₱400 cash + ₱600 gcash)', c.n === 2, c);
  ok('amount_paid totals exactly ₱1000', Number(order.amount_paid) === 1000, order.amount_paid);
  ok('order is fully paid', order.payment_status === 'paid');
}

console.log('\n== Scenario: two legitimate separate GCash payments of the SAME amount stay separate ==');
{
  const orderId = await newOrder('TRK-008', 1000);
  await newAttempt('src_008a', orderId, 500);
  await reconcile('src_008a', 'pay_008a', 500, 'paid');
  await newAttempt('src_008b', orderId, 500);
  await reconcile('src_008b', 'pay_008b', 500, 'paid');
  const c = await countTx(orderId);
  ok('two distinct ₱500 payments both recorded (not deduped by amount)', c.n === 2, c);
  ok('amount_paid totals ₱1000', Number((await getOrder(orderId)).amount_paid) === 1000);
}

console.log('\n== Scenario: cash rejected after pickup (delivery balance settlement) ==');
{
  const orderId = await newOrder('TRK-009', 1000);
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_pickup_payment($1, 10, 'cash', 'sender', '[]'::jsonb, CURRENT_DATE + 5, 0, NULL, NULL, NULL, 'Initial Payment', 'pay later')`, [orderId])
  );
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_delivery_payment($1, '[]'::jsonb, 'cash', 1000, NULL, CURRENT_DATE, NULL, 'Balance Settlement', 'trying cash', NULL)`, [orderId])
    );
  } catch (e) {
    rejected = /Cash is no longer accepted/.test(e.message);
  }
  ok('cash is rejected server-side at delivery/balance settlement', rejected);
  const c = await countTx(orderId);
  ok('no ledger row was written for the rejected cash attempt', c.n === 0, c);
}

console.log('\n== Scenario: valid pickup-time cash is still accepted ==');
{
  const orderId = await newOrder('TRK-010', 800);
  const res = await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT * FROM record_pickup_payment($1, 10, 'cash', 'sender', '[]'::jsonb, NULL, 800, NULL, CURRENT_DATE, NULL, 'Initial Payment', 'full cash at pickup')`, [orderId])
  );
  ok('pickup cash succeeds and marks order Picked Up', res.rows[0].status === 'Picked Up');
  const c = await countTx(orderId);
  ok('one cash ledger row recorded', c.n === 1 && Number(c.total) === 800, c);
}

console.log('\n== Scenario: unauthorized (non-admin) caller rejected ==');
{
  const orderId = await newOrder('TRK-011', 500);
  let rejected = false;
  try {
    await asUser(CUST_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_pickup_payment($1, 5, 'cash', 'sender', '[]'::jsonb, NULL, 500, NULL, CURRENT_DATE, NULL, 'Initial Payment', 'x')`, [orderId])
    );
  } catch (e) {
    rejected = /Admin access required/.test(e.message);
  }
  ok('a customer cannot call record_pickup_payment', rejected);

  rejected = false;
  try {
    await asUser(CUST_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_additional_payment($1, 100, 'gcash', 'REF123', NULL, CURRENT_DATE, NULL, NULL, true)`, [orderId])
    );
  } catch (e) {
    rejected = /Admin access required/.test(e.message);
  }
  ok('a customer cannot call record_additional_payment', rejected);
}

console.log('\n== Scenario: admin double-click / retry with a stable idempotency key ==');
{
  const orderId = await newOrder('TRK-012', 1000);
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_pickup_payment($1, 10, 'cash', 'sender', '[]'::jsonb, CURRENT_DATE+5, 0, NULL, NULL, NULL, 'Initial Payment', 'pay later')`, [orderId])
  );
  const idem = '11111111-1111-1111-1111-111111111111';
  const call = () => asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(
      `SELECT * FROM record_additional_payment($1, 1000, 'gcash', 'GC-999-000', 'settle', CURRENT_DATE, NULL, $2, true)`,
      [orderId, idem]
    )
  );
  await call();       // first click: commits
  await call();       // double-click retry: same key
  await call();       // a third retry, e.g. after a dropped response
  const c = await countTx(orderId);
  ok('three submissions with the same idempotency key produce ONE ledger row', c.n === 1, c);
  ok('order fully settled at ₱1000, not 3000', Number((await getOrder(orderId)).amount_paid) === 1000);
}

console.log('\n== Scenario: a genuinely NEW payment (different idempotency key) is not deduped ==');
{
  const orderId = await newOrder('TRK-013', 1000);
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_pickup_payment($1, 10, 'cash', 'sender', '[]'::jsonb, CURRENT_DATE+5, 0, NULL, NULL, NULL, 'Initial Payment', 'pay later')`, [orderId])
  );
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_additional_payment($1, 400, 'gcash', 'GC-AAA-111', NULL, CURRENT_DATE, NULL, $2, true)`, [orderId, '22222222-2222-2222-2222-222222222222'])
  );
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_additional_payment($1, 600, 'gcash', 'GC-BBB-222', NULL, CURRENT_DATE, NULL, $2, true)`, [orderId, '33333333-3333-3333-3333-333333333333'])
  );
  const c = await countTx(orderId);
  ok('two genuinely different payments (different keys) both recorded', c.n === 2, c);
  ok('order settles at ₱1000', Number((await getOrder(orderId)).amount_paid) === 1000);
}

console.log('\n== Scenario: duplicate direct GCash reference on the SAME order rejected ==');
{
  const orderId = await newOrder('TRK-014', 1000);
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_pickup_payment($1, 10, 'cash', 'sender', '[]'::jsonb, CURRENT_DATE+5, 0, NULL, NULL, NULL, 'Initial Payment', 'pay later')`, [orderId])
  );
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_additional_payment($1, 500, 'gcash', 'REF-DUP-1', NULL, CURRENT_DATE, NULL, NULL, true)`, [orderId])
  );
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_additional_payment($1, 500, 'gcash', 'ref dup 1', NULL, CURRENT_DATE, NULL, NULL, true)`, [orderId])
    );
  } catch (e) {
    rejected = /already recorded/.test(e.message);
  }
  ok('the same reference (different case/spacing) cannot be credited twice on one order', rejected);
}

console.log('\n== Scenario: duplicate direct GCash reference on ANOTHER order rejected ==');
{
  const orderA = await newOrder('TRK-015A', 500);
  const orderB = await newOrder('TRK-015B', 500);
  for (const o of [orderA, orderB]) {
    await asUser(ADMIN_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_pickup_payment($1, 5, 'cash', 'sender', '[]'::jsonb, CURRENT_DATE+5, 0, NULL, NULL, NULL, 'Initial Payment', 'pay later')`, [o])
    );
  }
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_additional_payment($1, 500, 'gcash', '0912-345-6789', NULL, CURRENT_DATE, NULL, NULL, true)`, [orderA])
  );
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_additional_payment($1, 500, 'gcash', '09123456789', NULL, CURRENT_DATE, NULL, NULL, true)`, [orderB])
    );
  } catch (e) {
    rejected = /already recorded against order TRK-015A/.test(e.message);
  }
  ok('the same reference cannot fund a different order (normalized match, dashes ignored)', rejected);
  const cB = await countTx(orderB);
  ok('order B got no ledger row from the rejected attempt', cB.n === 0);
}

console.log('\n== Scenario: unverified receipt is refused ==');
{
  const orderId = await newOrder('TRK-016', 500);
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_pickup_payment($1, 5, 'cash', 'sender', '[]'::jsonb, CURRENT_DATE+5, 0, NULL, NULL, NULL, 'Initial Payment', 'pay later')`, [orderId])
  );
  let rejected = false;
  try {
    await asUser(ADMIN_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_additional_payment($1, 500, 'gcash', 'REF-UNVERIFIED', NULL, CURRENT_DATE, NULL, NULL, false)`, [orderId])
    );
  } catch (e) {
    rejected = /verified receipt/.test(e.message);
  }
  ok('a manual GCash payment without the verified-receipt attestation is refused', rejected);
}

console.log('\n== Scenario: leading zeros preserved in normalized reference (not corrupted) ==');
{
  const orderA = await newOrder('TRK-017A', 300);
  const orderB = await newOrder('TRK-017B', 300);
  for (const o of [orderA, orderB]) {
    await asUser(ADMIN_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_pickup_payment($1, 3, 'cash', 'sender', '[]'::jsonb, CURRENT_DATE+5, 0, NULL, NULL, NULL, 'Initial Payment', 'pay later')`, [o])
    );
  }
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_additional_payment($1, 300, 'gcash', '007712345678', NULL, CURRENT_DATE, NULL, NULL, true)`, [orderA])
  );
  // A DIFFERENT reference that would collide with the first if leading
  // zeros were stripped (e.g. cast through a numeric type) must NOT be
  // treated as a duplicate.
  const res = await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT * FROM record_additional_payment($1, 300, 'gcash', '7712345678', NULL, CURRENT_DATE, NULL, NULL, true)`, [orderB])
  );
  ok('a reference differing only by a leading zero is NOT treated as the same reference', res.rows[0].tracking_number === 'TRK-017B');
  const raw = await db.query(`SELECT transaction_reference, transaction_reference_normalized FROM payment_transactions WHERE order_id=$1`, [orderA]);
  ok('the stored (as-entered) reference keeps its leading zeros', raw.rows[0].transaction_reference === '007712345678');
  ok('the normalized reference also keeps leading zeros (no numeric coercion)', raw.rows[0].transaction_reference_normalized === '007712345678');
}

console.log('\n== Scenario: GCash amount at delivery with a BLANK reference is refused, not silently accepted ==');
{
  const orderId = await newOrder('TRK-018', 500);
  await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(`SELECT record_pickup_payment($1, 5, 'cash', 'sender', '[]'::jsonb, CURRENT_DATE+5, 0, NULL, NULL, NULL, 'Initial Payment', 'pay later')`, [orderId])
  );
  let rejected = false;
  try {
    // No reference at all, and admin_verified_receipt defaulted false.
    await asUser(ADMIN_ID, 'authenticated', (tx) =>
      tx.query(`SELECT record_delivery_payment($1, '[]'::jsonb, 'gcash', 500, NULL, CURRENT_DATE, NULL, 'Balance Settlement', 'no ref given', NULL)`, [orderId])
    );
  } catch (e) {
    // Whichever check fires first (verified-receipt or blank-reference), the
    // point being proven is that it is REFUSED, not silently credited.
    rejected = /transfer reference number is required|verified receipt/.test(e.message);
  }
  ok('a GCash amount with no reference at all is refused (was previously silently accepted)', rejected);
  const c = await countTx(orderId);
  ok('no ledger row was written', c.n === 0, c);
}

console.log('\n== Scenario: manually-entered GCash reference IS accepted at pickup (not just delivery) ==');
{
  const orderId = await newOrder('TRK-019', 700);
  const res = await asUser(ADMIN_ID, 'authenticated', (tx) =>
    tx.query(
      `SELECT * FROM record_pickup_payment($1, 7, 'gcash', 'sender', '[]'::jsonb, NULL, 700, 'GC-PICKUP-1', CURRENT_DATE, NULL, 'Initial Payment', 'gcash at pickup', NULL, true)`,
      [orderId]
    )
  );
  ok('pickup-time manual GCash (verified) is accepted and settles the order', res.rows[0].payment_status === 'paid');
  const raw = await db.query(`SELECT gcash_channel, transaction_reference FROM payment_transactions WHERE order_id=$1`, [orderId]);
  ok('the ledger row is tagged gcash_channel=manual', raw.rows[0].gcash_channel === 'manual');
}

console.log('\n== Scenario: customer-created PayMongo attempt cannot overwrite pickup metadata ==');
{
  const orderId = await newOrder('TRK-020', 1000);
  await db.query(
    `UPDATE orders
        SET actual_weight = 10,
            payer_type = 'receiver',
            pickup_photos = '["trusted-photo"]'::jsonb,
            promised_payment_date = CURRENT_DATE + 7
      WHERE id = $1`,
    [orderId]
  );
  await db.query(
    `INSERT INTO payment_attempts (
       source_id, order_id, amount, payment_type, status, created_by,
       actual_weight, payer_type, pickup_photos, promised_payment_date
     ) VALUES (
       'src_020', $1, 100, 'full', 'pending', $2,
       1, 'sender', '["untrusted-photo"]'::jsonb, CURRENT_DATE
     )`,
    [orderId, CUST_ID]
  );
  await reconcile('src_020', 'pay_020', 100, 'paid');
  const order = await getOrder(orderId);
  ok('customer attempt preserves trusted actual weight', Number(order.actual_weight) === 10, order.actual_weight);
  ok('customer attempt preserves Freight Collect payer type', order.payer_type === 'receiver', order.payer_type);
  ok('customer attempt preserves trusted pickup photos', JSON.stringify(order.pickup_photos) === JSON.stringify(['trusted-photo']), order.pickup_photos);
  ok('customer attempt preserves the admin promise date', String(order.promised_payment_date).slice(0, 10) !== new Date().toISOString().slice(0, 10));
  ok('the genuine customer payment is still credited', Number(order.amount_paid) === 100 && order.payment_status === 'partial');
}

console.log('\n== Scenario: admin-created PayMongo pickup attempt keeps the existing combined workflow ==');
{
  const orderId = await newOrder('TRK-021', 1000);
  await db.query(
    `UPDATE orders
        SET actual_weight = 10,
            payer_type = 'sender',
            pickup_photos = '["old-photo"]'::jsonb
      WHERE id = $1`,
    [orderId]
  );
  await db.query(
    `INSERT INTO payment_attempts (
       source_id, order_id, amount, payment_type, status, created_by,
       actual_weight, payer_type, pickup_photos
     ) VALUES (
       'src_021', $1, 1000, 'full', 'pending', $2,
       12.5, 'receiver', '["admin-photo"]'::jsonb
     )`,
    [orderId, ADMIN_ID]
  );
  await reconcile('src_021', 'pay_021', 1000, 'paid');
  const order = await getOrder(orderId);
  ok('admin attempt may still apply verified actual weight', Number(order.actual_weight) === 12.5, order.actual_weight);
  ok('admin attempt may still confirm Freight Collect', order.payer_type === 'receiver', order.payer_type);
  ok('admin attempt may still apply pickup evidence', JSON.stringify(order.pickup_photos) === JSON.stringify(['admin-photo']), order.pickup_photos);
  ok('admin PayMongo payment is credited normally', Number(order.amount_paid) === 1000 && order.payment_status === 'paid');
}

console.log('\n== Scenario: weight and payer defaults fail safely at the database boundary ==');
{
  const orderId = await newOrder('TRK-022', 500);
  await newAttempt('src_022', orderId, 500);
  const attempt = await db.query(`SELECT payer_type FROM payment_attempts WHERE source_id = 'src_022'`);
  ok('an omitted payment-attempt payer type stays NULL instead of defaulting to sender', attempt.rows[0].payer_type === null);

  let rejected = false;
  try {
    await db.query(`UPDATE orders SET actual_weight = -1 WHERE id = $1`, [orderId]);
  } catch (e) {
    rejected = /check_orders_actual_weight_valid/.test(e.message);
  }
  ok('orders reject a negative actual weight', rejected);

  rejected = false;
  try {
    await db.query(
      `INSERT INTO payment_attempts (source_id, order_id, amount, actual_weight)
       VALUES ('src_022_bad', $1, 10, 0)`,
      [orderId]
    );
  } catch (e) {
    rejected = /payment_attempts_actual_weight_valid/.test(e.message);
  }
  ok('payment attempts reject a zero actual weight', rejected);
}

console.log('\n== Scenario: order totals stay consistent with the ledger (spot check across all orders) ==');
{
  const r = await db.query(`
    SELECT o.id, o.tracking_number, o.amount_paid,
           COALESCE((SELECT SUM(amount) FROM payment_transactions pt WHERE pt.order_id=o.id AND pt.payment_status IN ('paid','partial')), 0) AS ledger_total
    FROM orders o
  `);
  const mismatches = r.rows.filter(row => Math.abs(Number(row.amount_paid) - Number(row.ledger_total)) > 0.005);
  ok('orders.amount_paid matches the payment_transactions ledger total for every order', mismatches.length === 0, mismatches);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
