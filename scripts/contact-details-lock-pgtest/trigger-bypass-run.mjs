// Focused regression test for the DEFENSE-IN-DEPTH half of the contact-
// details lock: 20260915130000's addition to guard_order_update(), which
// closes a real bypass — a direct `.from('orders').update({ sender_name })`
// call (skipping update_order_contact_details() entirely) would otherwise
// succeed under the broad "Admins can update orders" / customer-ownership
// RLS policies, which have no column-level restriction of their own.
//
// This reuses scripts/shipping-discount-pgtest's full harness (trips,
// discount columns, the pre-existing guard_order_update()) as its base —
// that trigger references actual_weight/trip_id/amount_paid/discount_amount
// and several other columns unconditionally in its own top-level IF
// conditions, so a minimal harness is not enough once this trigger is
// attached; reusing the harness already built and proven correct for that
// exact function avoids re-deriving its full column/function dependency
// list by hand. Real migrations are applied verbatim, in the real order,
// ending with the two new ones under test.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const db = new PGlite();
let passed = 0;
let failed = 0;

function ok(desc, cond, extra) {
  if (cond) { passed += 1; console.log(`  ok - ${desc}`); }
  else { failed += 1; console.log(`  FAIL - ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function as(uid, role, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', $2, true)`, [uid || '', role]);
    return fn(tx);
  });
}
const asAdmin = (uid, fn) => as(uid, 'authenticated', fn);

console.log('== Loading scripts/shipping-discount-pgtest/harness-schema.sql (real orders/trips/is_admin shape) ==');
await db.exec(readFileSync(path.join(REPO, 'scripts/shipping-discount-pgtest/harness-schema.sql'), 'utf8'));

console.log('== Applying the discount-feature migrations verbatim, up to the pre-existing guard_order_update() ==');
for (const m of [
  '20260911010000_shipping_discount_schema.sql',
  '20260911020000_shipping_discount_guards.sql',
]) {
  await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', m), 'utf8'));
  console.log(`  applied ${m}`);
}

await db.exec(`
  -- The 16 contact/address columns update_order_contact_details() and the
  -- new guard_order_update() block operate on — not part of the discount
  -- harness, added here the same way it would have existed on the real
  -- table all along.
  ALTER TABLE public.orders ADD COLUMN sender_phone TEXT;
  ALTER TABLE public.orders ADD COLUMN sender_province TEXT;
  ALTER TABLE public.orders ADD COLUMN sender_city TEXT;
  ALTER TABLE public.orders ADD COLUMN sender_barangay TEXT;
  ALTER TABLE public.orders ADD COLUMN sender_street TEXT;
  ALTER TABLE public.orders ADD COLUMN sender_landmark TEXT;
  ALTER TABLE public.orders ADD COLUMN sender_address TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_phone TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_province TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_city TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_barangay TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_street TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_landmark TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_address TEXT;

  CREATE TABLE public.activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID,
    admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
    module TEXT NOT NULL CHECK (module = ANY (ARRAY['Orders','Trips','Payments','Chat','Authentication','System','Sales & Reports','Customers','Feedback'])),
    action TEXT NOT NULL,
    record_type TEXT,
    record_id UUID,
    record_ref TEXT,
    previous_value JSONB,
    new_value JSONB,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    client_event_id UUID
  );
`);

console.log('== Applying 20260915120000 + 20260915130000 verbatim (the changes under test) ==');
for (const m of [
  '20260915120000_lock_contact_details_at_out_for_delivery.sql',
  '20260915130000_guard_contact_details_lock_at_trigger_level.sql',
]) {
  await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', m), 'utf8'));
  console.log(`  applied ${m}`);
}

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID = '00000000-0000-0000-0000-000000000002';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);

let seq = 0;
const makeOrder = async (status, userId = CUST_ID) => {
  seq += 1;
  const tn = `CE-TRIG-${String(seq).padStart(4, '0')}`;
  // The harness's prepare_order_insert trigger (a real, unrelated guard —
  // every genuinely new booking starts at 'Pending' regardless of what the
  // INSERT naively sends) forces status back to 'Pending' on INSERT, so the
  // target status has to be reached via a separate UPDATE afterward, exactly
  // like a real booking's lifecycle would reach it — never set directly at
  // creation time.
  const { rows } = await db.query(
    `INSERT INTO orders (user_id, tracking_number, sender_name, receiver_name)
     VALUES ($1, $2, 'Juan Dela Cruz', 'Maria Santos') RETURNING id`,
    [userId, tn],
  );
  const orderId = rows[0].id;
  if (status === 'Out for Delivery') {
    // The pre-existing (untouched by this task) dispatch gate in
    // guard_order_update() refuses NEW.status = 'Out for Delivery' unless
    // the order has been weighed, and (for a sender-pays order) unless it's
    // settled or has a promise date — set actual_weight and payer_type =
    // 'receiver' (Freight Collect, payment-exempt at dispatch by design) in
    // the same UPDATE so this reaches "Out for Delivery" the way a real
    // booking would, not by sidestepping that unrelated guard.
    await db.query(`UPDATE orders SET status = $1, actual_weight = 5, payer_type = 'receiver' WHERE id = $2`, [status, orderId]);
  } else if (status !== 'Pending') {
    await db.query(`UPDATE orders SET status = $1 WHERE id = $2`, [status, orderId]);
  }
  return orderId;
};
const orderRow = async (orderId) => (await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId])).rows[0];

// ============================================================================
// The actual bypass this migration closes: a RAW UPDATE, not the RPC.
// ============================================================================
console.log('\n-- A direct UPDATE (bypassing update_order_contact_details entirely) --');
for (const status of ['Out for Delivery', 'Delivered']) {
  const orderId = await makeOrder(status);
  let threw = false, message = '';
  try {
    await asAdmin(ADMIN_ID, (tx) => tx.query(
      `UPDATE orders SET sender_name = 'Bypassed Name' WHERE id = $1`, [orderId],
    ));
  } catch (e) { threw = true; message = String(e.message || e); }
  ok(`a raw UPDATE of sender_name is rejected at status "${status}" even without the RPC`, threw && /locked once the booking is out for delivery/.test(message), message);
  const order = await orderRow(orderId);
  ok(`sender_name is unchanged after the rejected raw UPDATE at "${status}"`, order.sender_name === 'Juan Dela Cruz', order.sender_name);
}
{
  // The documented exception: admin direct-UPDATE on a Cancelled order still works.
  const orderId = await makeOrder('Cancelled');
  await asAdmin(ADMIN_ID, (tx) => tx.query(`UPDATE orders SET receiver_name = 'Corrected Name' WHERE id = $1`, [orderId]));
  const order = await orderRow(orderId);
  ok('a raw UPDATE by an admin on a Cancelled order still succeeds (documented exception)', order.receiver_name === 'Corrected Name', order.receiver_name);
}
{
  // Resending the SAME value must not be treated as a change.
  const orderId = await makeOrder('Delivered');
  await asAdmin(ADMIN_ID, (tx) => tx.query(`UPDATE orders SET sender_name = 'Juan Dela Cruz' WHERE id = $1`, [orderId]));
  const order = await orderRow(orderId);
  ok('re-sending the identical value at a locked status is not rejected (nothing actually changed)', order.sender_name === 'Juan Dela Cruz');
}
{
  // An unrelated column update on a locked order must NOT be blocked by this guard.
  const orderId = await makeOrder('Delivered');
  await asAdmin(ADMIN_ID, (tx) => tx.query(`UPDATE orders SET payment_method = 'gcash' WHERE id = $1`, [orderId]));
  const order = await orderRow(orderId);
  ok('an unrelated field (payment_method) can still be updated on a locked/Delivered order', order.payment_method === 'gcash', order.payment_method);
}
{
  // A pre-lock status: a direct UPDATE of contact fields still works normally.
  const orderId = await makeOrder('Assigned');
  await asAdmin(ADMIN_ID, (tx) => tx.query(`UPDATE orders SET sender_name = 'Updated Name' WHERE id = $1`, [orderId]));
  const order = await orderRow(orderId);
  ok('a direct UPDATE of contact fields still works normally before the lock', order.sender_name === 'Updated Name', order.sender_name);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
