// Focused regression tests for update_order_contact_details()
// (20260915120000_lock_contact_details_at_out_for_delivery.sql), run against
// a real embedded Postgres (PGlite — compiled Postgres, not a mock). Same
// approach as the other *-pgtest suites: a hand-built harness schema gives
// just enough of the real orders/profiles/activity_logs/is_admin shape, then
// the REAL migration file is applied verbatim on top, so what's tested is
// byte-for-byte the SQL that ships.
//
// What this file does NOT cover (see BOOKING_UI_AND_WEBSITE_FEATURE_UPDATES.md
// for the explicit list of verification gaps): the admin/customer React UI,
// and a live/staging Supabase project.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
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
const asCustomer = (uid, fn) => as(uid, 'authenticated', fn);
const asAnon = (fn) => as('', 'anon', fn);

console.log('== Loading harness schema (real orders/profiles/activity_logs/is_admin shape) ==');
await db.exec(readFileSync(path.join(HERE, 'harness-schema.sql'), 'utf8'));

console.log('== Applying 20260915120000 verbatim ==');
await db.exec(readFileSync(
  path.join(REPO, 'supabase/migrations/20260915120000_lock_contact_details_at_out_for_delivery.sql'), 'utf8'
));

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID = '00000000-0000-0000-0000-000000000002';
const OTHER_CUST_ID = '00000000-0000-0000-0000-000000000003';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer Two', 'customer')`, [OTHER_CUST_ID]);

let seq = 0;
const makeOrder = async (status, userId = CUST_ID) => {
  seq += 1;
  const tn = `CEX-LOCK-${String(seq).padStart(4, '0')}`;
  const { rows } = await db.query(
    `INSERT INTO orders (
       user_id, tracking_number, status,
       sender_name, sender_phone, sender_province, sender_city, sender_barangay, sender_street, sender_landmark, sender_address,
       receiver_name, receiver_phone, receiver_province, receiver_city, receiver_barangay, receiver_street, receiver_landmark, receiver_address
     ) VALUES (
       $1, $2, $3,
       'Juan Dela Cruz', '09171234567', 'Metro Manila', 'Quezon City', 'Bagumbayan', 'Main St', 'Near church', 'Main St, Bagumbayan',
       'Maria Santos', '09179876543', 'Bohol', 'Tagbilaran City', 'Poblacion', 'Rizal St', 'Near market', 'Rizal St, Poblacion'
     ) RETURNING id`,
    [userId, tn, status],
  );
  return rows[0].id;
};

const VALID_FIELDS = {
  sender_name: 'Juan Dela Cruz Jr.', sender_phone: '09171234567',
  sender_province: 'Metro Manila', sender_city: 'Quezon City', sender_barangay: 'Bagumbayan',
  sender_street: 'Main St', sender_landmark: 'Near church', sender_address: 'Main St, Bagumbayan',
  receiver_name: 'Maria Santos-Reyes', receiver_phone: '09179876543',
  receiver_province: 'Bohol', receiver_city: 'Tagbilaran City', receiver_barangay: 'Poblacion',
  receiver_street: 'Rizal St', receiver_landmark: 'Near market', receiver_address: 'Rizal St, Poblacion',
};

const callUpdate = (tx, orderId, fields = VALID_FIELDS) => tx.query(
  `SELECT * FROM public.update_order_contact_details(
     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
   )`,
  [
    orderId,
    fields.sender_name, fields.sender_phone, fields.sender_province, fields.sender_city,
    fields.sender_barangay, fields.sender_street, fields.sender_landmark, fields.sender_address,
    fields.receiver_name, fields.receiver_phone, fields.receiver_province, fields.receiver_city,
    fields.receiver_barangay, fields.receiver_street, fields.receiver_landmark, fields.receiver_address,
  ],
);

const orderRow = async (orderId) => (await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId])).rows[0];
const logCount = async (orderId) => Number((await db.query(`SELECT count(*)::int AS n FROM activity_logs WHERE record_id = $1`, [orderId])).rows[0].n);

// ============================================================================
// 1. Admin — allowed at every pre-delivery status
// ============================================================================
console.log('\n-- Admin: allowed before Out for Delivery --');
for (const status of ['Pending Review', 'Pending', 'Assigned', 'Picked Up', 'In Transit', 'Arrived at Hub']) {
  const orderId = await makeOrder(status);
  await asAdmin(ADMIN_ID, (tx) => callUpdate(tx, orderId));
  const order = await orderRow(orderId);
  ok(`admin can edit contact details at status "${status}"`, order.sender_name === 'Juan Dela Cruz Jr.', order.sender_name);
}

// ============================================================================
// 2. Admin — locked at Out for Delivery and Delivered
// ============================================================================
console.log('\n-- Admin: locked at Out for Delivery / Delivered --');
for (const status of ['Out for Delivery', 'Delivered']) {
  const orderId = await makeOrder(status);
  let threw = false, message = '';
  try { await asAdmin(ADMIN_ID, (tx) => callUpdate(tx, orderId)); }
  catch (e) { threw = true; message = String(e.message || e); }
  ok(`admin is rejected at status "${status}"`, threw && /locked once the booking is out for delivery/.test(message), message);
  const order = await orderRow(orderId);
  ok(`order untouched after rejected admin edit at "${status}"`, order.sender_name === 'Juan Dela Cruz', order.sender_name);
  ok(`no activity log written for the rejected attempt at "${status}"`, (await logCount(orderId)) === 0);
}

// ============================================================================
// 3. Admin — deliberately still allowed at Cancelled (archival/dispute correction)
// ============================================================================
console.log('\n-- Admin: still allowed at Cancelled (documented exception) --');
{
  const orderId = await makeOrder('Cancelled');
  await asAdmin(ADMIN_ID, (tx) => callUpdate(tx, orderId));
  const order = await orderRow(orderId);
  ok('admin can still correct a Cancelled booking', order.sender_name === 'Juan Dela Cruz Jr.', order.sender_name);
}

// ============================================================================
// 4. Stale-form scenario — status changes to locked AFTER the form was opened
// ============================================================================
console.log('\n-- Stale form cannot bypass the lock --');
{
  // Simulates: admin opens the edit form while "Assigned" is on screen, the
  // booking advances to "Out for Delivery" in the meantime, THEN the stale
  // form is submitted. The RPC re-reads status fresh on every call — there
  // is no client-cached status path into it.
  const orderId = await makeOrder('Assigned');
  await db.query(`UPDATE orders SET status = 'Out for Delivery' WHERE id = $1`, [orderId]);
  let threw = false, message = '';
  try { await asAdmin(ADMIN_ID, (tx) => callUpdate(tx, orderId)); }
  catch (e) { threw = true; message = String(e.message || e); }
  ok('a form opened before the status changed is still rejected on save', threw && /locked/.test(message), message);
}

// ============================================================================
// 5. Customer — allowed pre-lock, locked at Out for Delivery/Delivered/Cancelled
// ============================================================================
console.log('\n-- Customer: allowed pre-lock, locked at Out for Delivery/Delivered/Cancelled --');
{
  const orderId = await makeOrder('Pending', CUST_ID);
  await asCustomer(CUST_ID, (tx) => callUpdate(tx, orderId));
  const order = await orderRow(orderId);
  ok('customer can edit their own order before lock', order.sender_name === 'Juan Dela Cruz Jr.');
}
for (const status of ['Out for Delivery', 'Delivered', 'Cancelled']) {
  const orderId = await makeOrder(status, CUST_ID);
  let threw = false, message = '';
  try { await asCustomer(CUST_ID, (tx) => callUpdate(tx, orderId)); }
  catch (e) { threw = true; message = String(e.message || e); }
  ok(`customer is rejected at status "${status}" (customer lock is broader than admin's)`, threw && /locked/.test(message), message);
}

// ============================================================================
// 6. Customer — ownership: cannot edit another customer's order
// ============================================================================
console.log('\n-- Customer: ownership enforced --');
{
  const orderId = await makeOrder('Pending', OTHER_CUST_ID);
  let threw = false, message = '';
  try { await asCustomer(CUST_ID, (tx) => callUpdate(tx, orderId)); }
  catch (e) { threw = true; message = String(e.message || e); }
  ok('a customer cannot edit a booking that is not theirs', threw && /own bookings/i.test(message), message);
}

// ============================================================================
// 7. Unauthenticated caller rejected
// ============================================================================
console.log('\n-- Unauthenticated access rejected --');
{
  const orderId = await makeOrder('Pending');
  let threw = false, message = '';
  try { await asAnon((tx) => callUpdate(tx, orderId)); }
  catch (e) { threw = true; message = String(e.message || e); }
  ok('an anonymous caller is rejected', threw && /Authentication required/.test(message), message);
}

// ============================================================================
// 8. Validation — missing required field rejected
// ============================================================================
console.log('\n-- Validation --');
{
  const orderId = await makeOrder('Pending');
  let threw = false, message = '';
  try { await asAdmin(ADMIN_ID, (tx) => callUpdate(tx, orderId, { ...VALID_FIELDS, sender_name: '  ' })); }
  catch (e) { threw = true; message = String(e.message || e); }
  ok('a blank required field is rejected', threw && /required/i.test(message), message);
}

// ============================================================================
// 9. No-op — identical values write nothing and log nothing
// ============================================================================
console.log('\n-- No-op detection --');
{
  const orderId = await makeOrder('Pending');
  const before = await orderRow(orderId);
  await asAdmin(ADMIN_ID, (tx) => callUpdate(tx, orderId, {
    sender_name: before.sender_name, sender_phone: before.sender_phone,
    sender_province: before.sender_province, sender_city: before.sender_city,
    sender_barangay: before.sender_barangay, sender_street: before.sender_street,
    sender_landmark: before.sender_landmark, sender_address: before.sender_address,
    receiver_name: before.receiver_name, receiver_phone: before.receiver_phone,
    receiver_province: before.receiver_province, receiver_city: before.receiver_city,
    receiver_barangay: before.receiver_barangay, receiver_street: before.receiver_street,
    receiver_landmark: before.receiver_landmark, receiver_address: before.receiver_address,
  }));
  ok('submitting identical values writes no activity log entry', (await logCount(orderId)) === 0);
}

// ============================================================================
// 10. Activity log correctly attributes the actor
// ============================================================================
console.log('\n-- Activity log attribution --');
{
  const orderId = await makeOrder('Pending', CUST_ID);
  await asAdmin(ADMIN_ID, (tx) => callUpdate(tx, orderId));
  const { rows } = await db.query(`SELECT action FROM activity_logs WHERE record_id = $1`, [orderId]);
  ok('an admin edit is logged as an Admin action', rows[0]?.action === 'Admin Updated Sender/Receiver Details', rows[0]);
}
{
  const orderId = await makeOrder('Pending', CUST_ID);
  await asCustomer(CUST_ID, (tx) => callUpdate(tx, orderId));
  const { rows } = await db.query(`SELECT action FROM activity_logs WHERE record_id = $1`, [orderId]);
  ok('a customer edit is logged as a Customer action', rows[0]?.action === 'Customer Updated Sender/Receiver Details', rows[0]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
