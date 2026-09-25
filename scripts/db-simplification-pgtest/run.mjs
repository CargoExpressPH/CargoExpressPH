// Database simplification + fresh-start reset — isolated verification.
//
// Runs entirely in-process against PGlite (a real embedded Postgres). The
// schema is a catalog snapshot of the LIVE project (live-schema.sql, produced
// read-only by snapshot-live-schema.py — no rows), the two NEW migrations are
// applied verbatim on top, and every scenario uses synthetic fixtures. No
// network, no production connection, no real payment or message.
//
//   node scripts/db-simplification-pgtest/run.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { makeDb, as, REPO } from './harness.mjs';
import * as F from './fixtures.mjs';

const STAGE1 = '20260926100000_simplify_stage1_derive_and_compat.sql';
const STAGE2 = 'supabase/migrations_pending/20260926110000_simplify_stage2_drop_columns.sql';

let passed = 0, failed = 0;
const failures = [];
const ok = (desc, cond, extra) => {
  if (cond) { passed++; console.log(`  ok   ${desc}`); }
  else { failed++; failures.push(desc); console.log(`  FAIL ${desc}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
};
const rejects = async (desc, fn, pattern) => {
  try { await fn(); ok(desc, false, 'did not raise'); }
  catch (e) { ok(desc, pattern ? pattern.test(e.message) : true, e.message); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const num = (v) => (v === null || v === undefined ? v : Number(v));

// ─────────────────────────────────────────────────────────────────────────────
section('Migrations apply to the live-schema replica');
{
  const db1 = await makeDb({ migrations: [STAGE1] });
  ok('stage 1 applies on top of the live schema', true);
  const db2 = await makeDb({ migrations: [STAGE1, STAGE2] });
  const cols = (await db2.query(`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
     WHERE table_schema = 'public' AND (table_name, column_name) IN (
       ('orders','sender_name'),('orders','receiver_name'),('orders','sender_address'),('orders','receiver_address'),
       ('trips','capacity'),('trips','price_per_kg'),('payment_attempts','estimated_cost'),
       ('payment_attempts','description'),('contact_inquiries','phone'))`)).rows;
  ok('stage 2 removes all nine proposed columns', cols.length === 0, cols);
  const kept = (await db2.query(`
    SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND (table_name, column_name) IN (
      ('orders','sender_first_name'),('orders','sender_last_name'),('orders','receiver_first_name'),('orders','receiver_last_name'),
      ('orders','sender_lot_block'),('orders','sender_street'),('orders','sender_barangay'),('orders','sender_city'),
      ('orders','sender_province'),('orders','sender_landmark'),('contact_inquiries','contact_phone'),('contact_inquiries','contact_email'),
      ('company_information','default_capacity'),('company_information','default_price_per_kg'),('orders','shipping_cost'))`)).rows[0].n;
  ok('authoritative columns are kept', kept === 15, kept);

  // Stage 2 must refuse to run if stage 1 has not replaced the dependent functions.
  const db0 = await makeDb();
  await rejects('stage 2 alone aborts: live functions still read the columns',
    async () => {
      try { await db0.exec(readFileSync(path.join(REPO, STAGE2), 'utf8')); }
      finally { await db0.exec('ROLLBACK;').catch(() => {}); }
    },
    /Stage 2 aborted: these functions still reference columns being dropped/);
  const still = (await db0.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='sender_name'`)).rows[0].n;
  ok('…and the aborted stage 2 dropped nothing', still === 1);
  await db0.close(); await db1.close(); await db2.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('One formatting rule: SQL format_person_name/format_address = JS helpers');
const vite = await createServer({ logLevel: 'silent', server: { middlewareMode: true } });
const P = await vite.ssrLoadModule('/src/lib/orderParties.js');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  const names = [
    ['Juan', 'Dela Cruz'], ['  Juan  ', '  Dela   Cruz '], ['Maria', ''], ['', 'Santos'], ['', ''],
    [null, null], ['Ana\tMarie', 'Reyes'], ["D'Angelo", 'O-Neil'], ['Ma.', 'Clara'],
  ];
  let same = 0;
  for (const [f, l] of names) {
    const sql = (await db.query(`SELECT COALESCE(public.format_person_name($1, $2), '') v`, [f, l])).rows[0].v;
    const js = P.formatPersonName(f, l);
    if (sql === js) same++; else console.log('    name mismatch', JSON.stringify([f, l, sql, js]));
  }
  ok(`person names identical in SQL and JS (${same}/${names.length})`, same === names.length);

  const addrs = [
    ['Lot 5 Blk 2', 'Rizal St', 'Bagumbayan', 'Quezon City', 'Metro Manila', 'Near chapel'],
    ['', 'Rizal St', 'Bagumbayan', 'Quezon City', 'Metro Manila', ''],
    [null, null, null, null, null, 'Only landmark'],
    [null, null, null, null, null, null],
    [' ,Lot 1, ', ' Street,, 2 ', 'Poblacion', 'Tagbilaran City', 'Bohol', ', gate ,'],
    ['', '', 'Cebu City', 'cebu city', 'Cebu', ''],           // consecutive duplicate (case-insensitive)
    ['', 'Main', 'Cogon', 'Tagbilaran City', 'Somewhere in Leyte (free text)', 'Pier'], // "Other Area"
    ['Purok 3', 'NA', 'San Isidro', 'Talibon', 'Bohol', 'SM City'],
  ];
  same = 0;
  for (const a of addrs) {
    const sql = (await db.query(`SELECT public.format_address($1,$2,$3,$4,$5,$6) v`, a)).rows[0].v;
    const js = P.orderPartyAddress({ sender_lot_block: a[0], sender_street: a[1], sender_barangay: a[2], sender_city: a[3], sender_province: a[4], sender_landmark: a[5] }, 'sender');
    if (sql === js) same++; else console.log('    address mismatch', JSON.stringify([a, sql, js]));
  }
  ok(`addresses identical in SQL and JS (${same}/${addrs.length})`, same === addrs.length);
  const sample = (await db.query(`SELECT public.format_address('Lot 5 Blk 2','Rizal St','Bagumbayan','Quezon City','Metro Manila','Near chapel') v`)).rows[0].v;
  ok('component order and landmark format', sample === 'Lot 5 Blk 2, Rizal St, Bagumbayan, Quezon City, Metro Manila (Landmark: Near chapel)', sample);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Bookings, derived names/addresses, compatibility aliases');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db, { rate: 70, capacity: 1000 });
  const trip = await F.newTrip(db, { daysAhead: 2 });

  const c = await F.newOrder(db, { tripId: trip.id });
  ok('customer booking created and Assigned', c.status === 'Assigned' && Number(c.shipping_cost) === 0, c.status);
  const a = await F.newOrder(db, { uid: F.ADMIN, extra: { user_id: F.CUST } });
  ok('admin booking on behalf of a customer created (Pending, no trip)', a.status === 'Pending');

  const other = await F.newOrder(db, { extra: { sender_province: 'Somewhere in Leyte' } });
  ok('out-of-coverage (free-text province) booking flagged for review', other.service_area_status === 'for_review');
  const otherAddr = (await db.query(`SELECT sender_address(o) v FROM orders o WHERE id=$1`, [other.id])).rows[0].v;
  ok('free-text location preserved in the derived address', otherAddr.includes('Somewhere in Leyte'), otherAddr);

  const alias = (await db.query(`SELECT o.sender_name, o.receiver_name, o.sender_address, o.receiver_address FROM orders o WHERE id=$1`, [c.id])).rows[0];
  ok('computed alias sender_name', alias.sender_name === 'Juan Dela Cruz', alias.sender_name);
  ok('computed alias receiver_name', alias.receiver_name === 'Maria Santos', alias.receiver_name);
  ok('computed alias sender_address', alias.sender_address === 'Lot 5 Blk 2, Rizal St, Bagumbayan, Quezon City, Metro Manila (Landmark: Near chapel)', alias.sender_address);
  ok('computed alias receiver_address skips blank lot/block', alias.receiver_address === 'CPG Ave, Cogon, Tagbilaran City, Bohol (Landmark: Beside school)', alias.receiver_address);
  const tripAlias = (await db.query(`SELECT t.capacity, t.price_per_kg FROM trips t WHERE id=$1`, [trip.id])).rows[0];
  ok('computed trip aliases return company defaults', num(tripAlias.capacity) === 1000 && num(tripAlias.price_per_kg) === 70, tripAlias);

  await rejects('name policy still enforced on insert',
    () => F.newOrder(db, { extra: { sender_first_name: 'Juan123' } }), /first name may only contain/);

  const note = (await db.query(`SELECT message FROM notifications WHERE reference_id=$1 AND title='New Booking' LIMIT 1`, [c.id])).rows[0];
  ok('admin "New Booking" notification uses the derived sender name', note?.message?.endsWith('from Juan Dela Cruz'), note);

  const js = P.orderPartyName(c, 'receiver');
  ok('QR label / modals receiver name from a select=* row (helper)', js === 'Maria Santos', js);
  ok('helper address from a select=* row', P.orderPartyAddress(c, 'sender').startsWith('Lot 5 Blk 2, Rizal St'), P.orderPartyAddress(c, 'sender'));
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Stage-1 window: older clients still work before the drop');
{
  const db = await makeDb({ migrations: [STAGE1] });
  await F.seed(db);
  const trip = await F.newTrip(db);
  // An older client that sends only the combined name + a full address.
  const legacy = await F.newOrder(db, { tripId: trip.id, extra: {
    sender_first_name: '', sender_last_name: '', sender_name: 'Pedro Penduko',
    sender_address: 'IGNORED free text', receiver_address: 'IGNORED too' } });
  ok('legacy combined-name insert is split into first/last', legacy.sender_first_name === 'Pedro' && legacy.sender_last_name === 'Penduko');
  ok('legacy shadow full name recomputed', legacy.sender_name === 'Pedro Penduko');
  ok('client-sent free-text address is not trusted (derived from parts)', legacy.sender_address.startsWith('Lot 5 Blk 2'), legacy.sender_address);
  await rejects('legacy combined name still validated',
    () => F.newOrder(db, { extra: { sender_first_name: '', sender_last_name: '', sender_name: 'Bad#Name' } }), /Sender name may only contain/);
  // Old 19-argument contact RPC: free-text address ignored, lot/block kept.
  const r = await as(db, F.CUST, 'authenticated', (tx) => tx.query(
    `SELECT * FROM public.update_order_contact_details($1,'Juan','Cruz','09171234567','Metro Manila','Quezon City','Bagumbayan','Rizal St','Near chapel','Some typed address',
       'Maria','Santos','09181234567','Bohol','Tagbilaran City','Cogon','CPG Ave','Beside school','Other typed address')`, [legacy.id]));
  ok('old contact-edit signature still works and keeps lot/block', r.rows[0].sender_lot_block === 'Lot 5 Blk 2' && r.rows[0].sender_last_name === 'Cruz');
  ok('…and its shadow address is derived, not the typed text', r.rows[0].sender_address.startsWith('Lot 5 Blk 2, Rizal St'), r.rows[0].sender_address);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Contact-details editing (structured parts only)');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db);
  const trip = await F.newTrip(db);
  const o = await F.newOrder(db, { tripId: trip.id });
  const edit = (uid, orderId, over = {}) => as(db, uid, 'authenticated', (tx) => tx.query(
    `SELECT * FROM public.update_order_contact_parts(
       p_order_id => $1, p_sender_first_name => $2, p_sender_last_name => 'Dela Cruz', p_sender_phone => '09171234567',
       p_sender_province => 'Metro Manila', p_sender_city => 'Quezon City', p_sender_barangay => 'Bagumbayan',
       p_sender_street => 'Rizal St', p_sender_lot_block => $3, p_sender_landmark => 'Near chapel',
       p_receiver_first_name => 'Maria', p_receiver_last_name => 'Santos', p_receiver_phone => '09181234567',
       p_receiver_province => 'Bohol', p_receiver_city => 'Tagbilaran City', p_receiver_barangay => 'Cogon',
       p_receiver_street => 'CPG Ave', p_receiver_lot_block => '', p_receiver_landmark => 'Beside school')`,
    [orderId, over.first ?? 'Juan', over.lot ?? 'Lot 9']));
  const r = await edit(F.CUST, o.id);
  ok('customer edits lot/block through the structured RPC', r.rows[0].sender_lot_block === 'Lot 9');
  const addr = (await db.query(`SELECT sender_address(o) v FROM orders o WHERE id=$1`, [o.id])).rows[0].v;
  ok('derived address follows the edited part (cannot disagree)', addr.startsWith('Lot 9, Rizal St'), addr);
  const log = (await db.query(`SELECT previous_value->>'sender_lot_block' p, new_value->>'sender_lot_block' n FROM activity_logs WHERE record_id=$1 ORDER BY created_at DESC LIMIT 1`, [o.id])).rows[0];
  ok('activity log records the lot/block change', log?.p === 'Lot 5 Blk 2' && log?.n === 'Lot 9', log);
  await edit(F.ADMIN, o.id, { first: 'Juanito' });
  ok('admin edit updates the derived name', (await db.query(`SELECT sender_name(o) v FROM orders o WHERE id=$1`, [o.id])).rows[0].v === 'Juanito Dela Cruz');
  await rejects('another customer cannot edit the booking', () => edit(F.CUST2, o.id), /Only your own bookings/);
  await rejects('name validation on edit', () => edit(F.ADMIN, o.id, { first: 'J0hn' }), /first name may only contain/);
  await db.query(`UPDATE orders SET status='Delivered' WHERE id=$1`, [o.id]).catch(() => {});
  await db.exec(`ALTER TABLE orders DISABLE TRIGGER orders_guard_update`);
  await db.query(`UPDATE orders SET status='Out for Delivery' WHERE id=$1`, [o.id]);
  await db.exec(`ALTER TABLE orders ENABLE TRIGGER orders_guard_update`);
  await rejects('details lock at Out for Delivery (RPC)', () => edit(F.ADMIN, o.id), /locked once the booking is out for delivery/);
  await rejects('details lock also guards a direct lot/block update', () => as(db, F.ADMIN, 'authenticated', (tx) =>
    tx.query(`UPDATE orders SET sender_lot_block='X' WHERE id=$1`, [o.id])), /locked once the booking is out for delivery/);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Public tracking stays masked');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db);
  const o = await F.newOrder(db);
  const r = (await as(db, null, 'anon', (tx) => tx.query(`SELECT * FROM public.track_order_public($1)`, [o.tracking_number.toLowerCase()]))).rows[0];
  ok('sender masked to first word + last initial', r.sender_name === 'Juan C.', r.sender_name);
  ok('receiver masked', r.receiver_name === 'Maria S.', r.receiver_name);
  const cols = Object.keys(r);
  ok('no phone/address/payment fields in the public response',
    !cols.some(k => /phone|address|lot|street|barangay|landmark|amount|payment|user_id/.test(k)), cols);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Pricing: current company rate at pickup; never re-priced by money movements');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db, { rate: 70, capacity: 1000 });
  const trip = await F.newTrip(db);
  const addPayment = (orderId, amount, status = 'partial') => as(db, F.ADMIN, 'authenticated', (tx) => tx.query(
    `INSERT INTO payment_transactions (order_id, amount, payment_method, payment_status, admin_id, admin_name, payment_type)
     VALUES ($1, $2, 'cash', $3, $4, 'Test Admin', 'Additional Payment') RETURNING id`, [orderId, amount, status, F.ADMIN]));

  const o = await F.newOrder(db, { tripId: trip.id });
  await F.pickup(db, o.id, { weight: 10, amount: 300 });
  let r = await F.getOrder(db, o.id);
  ok('pickup priced at the current company rate (10 kg × ₱70)', num(r.shipping_cost) === 700, r.shipping_cost);
  ok('partial payment: balance 400, status partial', num(r.remaining_balance) === 400 && r.payment_status === 'partial', [r.remaining_balance, r.payment_status]);

  await F.setRate(db, 100);
  const tx = await addPayment(o.id, 100);
  r = await F.getOrder(db, o.id);
  ok('rate change + later payment keeps the recorded ₱700 (was re-priced to ₱1,000 before)', num(r.shipping_cost) === 700, r.shipping_cost);
  ok('balance follows the recorded charge (700 − 400 = 300)', num(r.amount_paid) === 400 && num(r.remaining_balance) === 300, [r.amount_paid, r.remaining_balance]);

  await db.query(`INSERT INTO payment_refunds (payment_transaction_id, order_id, amount, status, reason, refund_channel, succeeded_at, return_method, notes)
                  VALUES ($1, $2, 50, 'succeeded', 'requested_by_customer', 'manual', now(), 'cash', 'Cash returned at counter')`, [tx.rows[0].id, o.id]);
  r = await F.getOrder(db, o.id);
  ok('refund keeps the recorded charge', num(r.shipping_cost) === 700, r.shipping_cost);
  ok('refund reduces amount paid and raises the balance', num(r.amount_paid) === 350 && num(r.remaining_balance) === 350, [r.amount_paid, r.remaining_balance]);

  await as(db, F.ADMIN, 'authenticated', (t) => t.query(`UPDATE orders SET shipping_cost = 1 WHERE id=$1`, [o.id]));
  ok('a direct write to shipping_cost is ignored', num((await F.getOrder(db, o.id)).shipping_cost) === 700);

  const trip2 = await F.newTrip(db);
  await as(db, F.ADMIN, 'authenticated', (t) => t.query(`UPDATE orders SET trip_id=$2 WHERE id=$1`, [o.id, trip2.id]));
  r = await F.getOrder(db, o.id);
  ok('trip reassignment keeps the recorded charge', num(r.shipping_cost) === 700 && r.trip_id === trip2.id, r.shipping_cost);

  await as(db, F.ADMIN, 'authenticated', (t) => t.query(`UPDATE orders SET actual_weight = 12 WHERE id=$1`, [o.id]));
  r = await F.getOrder(db, o.id);
  ok('a weight change re-prices at the CURRENT rate (12 × ₱100) — flagged decision', num(r.shipping_cost) === 1200, r.shipping_cost);

  // Discounts and zero-payable
  await F.setRate(db, 50);
  const d = await F.newOrder(db, { tripId: trip.id });
  await F.pickup(db, d.id, { weight: 10, amount: 400, discount: 100, reason: 'Regular customer' });
  r = await F.getOrder(db, d.id);
  ok('discount: fee 500, discount 100, paid 400 → paid in full', num(r.shipping_cost) === 500 && num(r.remaining_balance) === 0 && r.payment_status === 'paid', [r.shipping_cost, r.remaining_balance, r.payment_status]);
  await F.setRate(db, 80);
  await addPayment(d.id, 0.01, 'partial').catch(() => {});
  r = await F.getOrder(db, d.id);
  ok('discounted order not re-priced after a rate change', num(r.shipping_cost) === 500, r.shipping_cost);

  const z = await F.newOrder(db, { tripId: trip.id });
  await F.pickup(db, z.id, { weight: 5, amount: 0, discount: 400, reason: 'Other', notes: 'Goodwill' });
  r = await F.getOrder(db, z.id);
  ok('zero-payable: full discount leaves nothing owing', num(r.shipping_cost) === 400 && num(r.remaining_balance) === 0, [r.shipping_cost, r.discount_amount, r.remaining_balance, r.payment_status]);
  await rejects('discount above the fee is refused', async () => {
    const q = await F.newOrder(db, { tripId: trip.id });
    await F.pickup(db, q.id, { weight: 1, amount: 0, discount: 1000, reason: 'Regular customer' });
  }, /cannot exceed/);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Capacity: company default + unchanged 200 kg allowance');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db, { rate: 70, capacity: 100 });             // ceiling 300 kg
  const trip = await F.newTrip(db);
  const a = await F.newOrder(db, { tripId: trip.id });
  await F.pickup(db, a.id, { weight: 250, amount: 0 });
  const b = await F.newOrder(db, { tripId: trip.id });
  await rejects('weight pushing the trip past 100 + 200 kg is refused',
    () => F.pickup(db, b.id, { weight: 60, amount: 0 }), /exceeds maximum van capacity of 300 kg \(100 kg planned \+ 200 kg allowance\)/);
  await F.pickup(db, b.id, { weight: 50, amount: 0 });
  ok('weight exactly at the ceiling (300 kg) is accepted', num((await F.getOrder(db, b.id)).actual_weight) === 50);

  const other = await F.newTrip(db);
  const c = await F.newOrder(db, { tripId: other.id });
  await F.pickup(db, c.id, { weight: 10, amount: 0 });
  await rejects('reassigning cargo onto a full trip is refused',
    () => as(db, F.ADMIN, 'authenticated', (t) => t.query(`UPDATE orders SET trip_id=$2 WHERE id=$1`, [c.id, trip.id])), /exceeds maximum van capacity/);

  // Owner lowers the company capacity below what the trip already carries.
  await F.setRate(db, null, 20);                              // ceiling 220 < 300 recorded
  const still = (await db.query(`SELECT count(*)::int n, sum(actual_weight)::numeric w FROM orders WHERE trip_id=$1`, [trip.id])).rows[0];
  ok('lowering capacity unassigns nothing and deletes nothing', still.n === 2 && num(still.w) === 300, still);
  await as(db, F.ADMIN, 'authenticated', (t) => t.query(`UPDATE orders SET actual_weight = 45 WHERE id=$1`, [b.id]));
  ok('a downward weight correction on the over-limit trip is allowed', num((await F.getOrder(db, b.id)).actual_weight) === 45);
  await rejects('an upward correction on the over-limit trip is refused',
    () => as(db, F.ADMIN, 'authenticated', (t) => t.query(`UPDATE orders SET actual_weight = 46 WHERE id=$1`, [b.id])), /220 kg/);
  await rejects('a customer cannot book onto the over-limit trip',
    () => F.newOrder(db, { tripId: trip.id }), /This trip is full/);
  const status = (await as(db, F.ADMIN, 'authenticated', (t) => t.query(`UPDATE orders SET status='Picked Up' WHERE id=$1 RETURNING status`, [a.id]).catch(e => ({ rows: [{ status: e.message }] })))).rows[0].status;
  ok('cargo already on the over-limit trip can still progress', status === 'Picked Up', status);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Reports and admin views use derived names');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db);
  const trip = await F.newTrip(db);
  const o = await F.newOrder(db, { tripId: trip.id });
  await F.pickup(db, o.id, { weight: 2, amount: 140 });
  await db.exec(`ALTER TABLE orders DISABLE TRIGGER USER`);
  await db.query(`UPDATE orders SET status='Delivered' WHERE id=$1`, [o.id]);
  await db.exec(`ALTER TABLE orders ENABLE TRIGGER USER`);
  await db.query(`INSERT INTO order_status_events (order_id, status, changed_at) VALUES ($1, 'Delivered', now())`, [o.id]);
  const rep = (await as(db, F.ADMIN, 'authenticated', (t) => t.query(`SELECT public.get_financial_report_data(now() - interval '1 day', now() + interval '1 day') r`))).rows[0].r;
  const row = rep?.completedDeliveries?.find(x => x.tracking_number === o.tracking_number);
  ok('financial report returns sender_name/receiver_name aliases', row?.sender_name === 'Juan Dela Cruz' && row?.receiver_name === 'Maria Santos', row);
  const ev = (await as(db, F.ADMIN, 'authenticated', (t) => t.query(`SELECT count(*)::int n FROM public.evidence_photo_rows()`))).rows[0].n;
  ok('evidence photo listing runs without the dropped columns', ev >= 0);
  // The insert trigger already created this admin notification; clear it so
  // the RPC's ON CONFLICT de-duplication does not hide what it composes.
  await db.query(`DELETE FROM notifications WHERE reference_id=$1`, [o.id]);
  const note = (await as(db, F.CUST, 'authenticated', (t) => t.query(`SELECT notification_message FROM public.create_admin_notifications_rpc('x','y','order_update',$1) LIMIT 1`, [o.id]))).rows[0];
  ok('client-requested admin notification names the sender', note?.notification_message?.includes('Juan Dela Cruz'), note);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Contact inquiries: rate limiting without the legacy phone column');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db);
  const ins = (o) => db.query(`INSERT INTO contact_inquiries (name, message, contact_phone, contact_email, ip) VALUES ('Test Person', 'Hello, this is a test message.', $1, $2, $3)`,
    [o.phone ?? null, o.email ?? null, o.ip ?? null]);
  const reset = () => db.query(`DELETE FROM contact_inquiries`);

  await rejects('an inquiry with no contact channel is refused', () => ins({ ip: '1.1.1.1' }), /has_contact_channel/);
  for (let i = 0; i < 3; i++) await ins({ phone: '09171234567', ip: `10.0.0.${i}` });
  await rejects('4th inquiry from the same phone (different IPs) is refused', () => ins({ phone: '09171234567', ip: '10.0.0.9' }), /this phone number/);
  await rejects('+63 form of the same number counts as the same phone', () => ins({ phone: '+63 917 123 4567', ip: '10.0.0.8' }), /this phone number/);
  await reset();
  for (let i = 0; i < 3; i++) await ins({ email: 'Lead@Example.test', ip: `10.1.0.${i}` });
  await rejects('4th inquiry from the same email (case-insensitive) is refused', () => ins({ email: 'lead@example.test', ip: '10.1.0.9' }), /this email address/);
  const stored = (await db.query(`SELECT contact_email FROM contact_inquiries LIMIT 1`)).rows[0].contact_email;
  ok('stored email is kept as entered (only the rate-limit key is normalized)', stored === 'Lead@Example.test', stored);
  await reset();
  for (let i = 0; i < 5; i++) await ins({ phone: `0917000000${i}`, ip: '203.0.113.7' });
  await rejects('6th inquiry from one network is refused even with new contacts', () => ins({ phone: '09170000009', ip: '203.0.113.7' }), /your network/);
  await reset();
  for (let i = 0; i < 15; i++) await ins({ phone: `0918000${String(i).padStart(4, '0')}`, ip: `198.51.100.${i}` });
  await rejects('global limit: 16th inquiry in a minute is refused', () => ins({ phone: '09189999999', ip: '198.51.100.99' }), /right now/);
  await reset();
  const lock = await db.transaction(async (t) => {
    await t.query(`INSERT INTO contact_inquiries (name, message, contact_phone) VALUES ('Test Person', 'Hello, this is a test message.', '09170001111')`);
    return (await t.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND granted`)).rows[0].n;
  });
  ok('insert holds a transaction-scoped advisory lock (serializes concurrent submissions)', lock >= 1, lock);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Delayed / repeated PayMongo events');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db);
  const trip = await F.newTrip(db);
  const o = await F.newOrder(db, { tripId: trip.id });
  await F.pickup(db, o.id, { weight: 10, amount: 0 });
  await db.query(`INSERT INTO payment_attempts (source_id, order_id, amount, status, created_by) VALUES ('src_test_0001', $1, 200, 'pending', $2)`, [o.id, F.ADMIN]);
  const rec = () => db.query(`SELECT * FROM public.reconcile_paymongo_payment_attempt('src_test_0001', 'pay_test_0001', 200, 'paid')`);
  const r1 = (await rec()).rows[0];
  const r2 = (await rec()).rows[0];
  const n = (await db.query(`SELECT count(*)::int n FROM payment_transactions WHERE order_id=$1`, [o.id])).rows[0].n;
  ok('first payment.paid reconciles', r1.order_reconciled === true, r1);
  ok('a repeated event is a no-op (one ledger row)', r2.message.includes('Already reconciled') && n === 1, [r2.message, n]);
  ok('payment did not re-price the order', num((await F.getOrder(db, o.id)).shipping_cost) === 700);

  await db.exec(`BEGIN; SET LOCAL cargoexpress.reset_confirm = 'I-HAVE-A-VERIFIED-BACKUP';`);
  await db.exec(readFileSync(path.join(REPO, 'supabase/maintenance/fresh_start_reset.sql'), 'utf8'));
  await db.exec(`COMMIT;`);
  const late = (await db.query(`SELECT * FROM public.reconcile_paymongo_payment_attempt('src_test_0001', 'pay_test_0001', 200, 'paid')`)).rows[0];
  const after = (await db.query(`SELECT (SELECT count(*) FROM orders) o, (SELECT count(*) FROM payment_transactions) p, (SELECT count(*) FROM payment_attempts) a`)).rows[0];
  ok('a delayed payment event after the reset is ignored', late.order_reconciled === false && /No payment attempt/.test(late.message), late);
  ok('…and recreates no order, payment or attempt', Number(after.o) === 0 && Number(after.p) === 0 && Number(after.a) === 0, after);
  const fail = (await db.query(`SELECT public.reconcile_paymongo_payment_failure('src_test_0001', 'pay_test_0001', 'late failure') r`)).rows[0].r;
  ok('a delayed payment.failed after the reset is ignored', fail.linked === false, fail);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Fresh-start reset rehearsal (synthetic data)');
{
  const db = await makeDb({ migrations: [STAGE1, STAGE2] });
  await F.seed(db);
  // Populate every table the manifest classifies.
  await db.query(`INSERT INTO legal_documents (document_type, version, url_path, effective_at, is_current) VALUES ('terms_of_service','2026-08-22','/terms', now(), true), ('privacy_policy','2026-08-22','/privacy', now(), true)`);
  await db.query(`INSERT INTO legal_consents (user_id, document_type, document_version) VALUES ($1,'terms_of_service','2026-08-22'), ($1,'privacy_policy','2026-08-22')`, [F.CUST]);
  await db.query(`INSERT INTO user_device_tokens (user_id, token) VALUES ($1, 'tok-admin'), ($2, 'tok-cust')`, [F.ADMIN, F.CUST]);
  await db.query(`INSERT INTO email_subscriptions (email, subscribed, source) VALUES ('lead@example.test', true, 'contact_form') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO photo_storage_settings (id, upload_mode) VALUES (true, 'automatic') ON CONFLICT DO NOTHING`);
  const ann = (await db.query(`INSERT INTO announcements (title, content, author_id) VALUES ('Hello', 'World', $1) RETURNING id`, [F.ADMIN])).rows[0].id;
  await db.query(`INSERT INTO announcement_email_broadcasts (announcement_id, subject, content, from_email, status) VALUES ($1,'s','c','no-reply@example.test','completed')`, [ann]);
  await db.query(`INSERT INTO announcement_email_recipients (announcement_id, email, status) VALUES ($1,'x@example.test','accepted')`, [ann]);
  const trip = await F.newTrip(db, { daysAhead: 0 });
  const o = await F.newOrder(db, { tripId: trip.id });
  await F.pickup(db, o.id, { weight: 3, amount: 210, method: 'cash' });
  const tx = (await db.query(`SELECT id FROM payment_transactions WHERE order_id=$1 LIMIT 1`, [o.id])).rows[0].id;
  await db.query(`INSERT INTO payment_refunds (payment_transaction_id, order_id, amount, status, reason, refund_channel, succeeded_at, return_method, notes) VALUES ($1,$2,10,'succeeded','requested_by_customer','manual', now(), 'cash', 'Cash returned at counter')`, [tx, o.id]);
  await db.query(`INSERT INTO private.paymongo_refund_recovery_jobs (payment_transaction_id, payment_id, livemode, status, scan_until, next_check_at) VALUES ($1,'pay_testrecovery0001',false,'active', now()+interval '180 days', now())`, [tx]);
  await db.query(`INSERT INTO payment_attempts (source_id, order_id, amount, status, created_by) VALUES ('src_rehearsal_01', $1, 50, 'failed', $2)`, [o.id, F.ADMIN]);
  await db.query(`INSERT INTO private.manual_refund_reauth_attempts (admin_id, failed_count) VALUES ($1, 1)`, [F.ADMIN]);
  await db.query(`INSERT INTO customer_feedback (order_id, customer_id, rating, message) VALUES ($1,$2,5,'Great')`, [o.id, F.CUST]);
  const conv = (await db.query(`INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`, [F.CUST])).rows[0].id;
  await as(db, F.CUST, 'authenticated', (t) => t.query(`INSERT INTO chat_messages (conversation_id, sender_id, sender_role, message) VALUES ($1,$2,'customer','hi')`, [conv, F.CUST]));
  await db.query(`INSERT INTO contact_inquiries (name, message, contact_email) VALUES ('Lead Person','A message long enough.','lead@example.test')`);
  await db.query(`INSERT INTO photo_storage_events (event_type, provider, outcome, order_id) VALUES ('upload','supabase','success',$1)`, [o.id]);
  await db.query(`INSERT INTO photo_cleanup_queue (provider, storage_path, completed_at) VALUES ('supabase','pickup-proofs/x.jpg', now())`);
  await db.query(`INSERT INTO activity_logs (module, action) VALUES ('Orders','Test')`);
  await db.query(`INSERT INTO cancellation_settlement_history (order_id, tracking_number, action, new_decision, changed_by, changed_by_name, idempotency_key) VALUES ($1,$2,'recorded','{}'::jsonb,$3,'Test Admin',gen_random_uuid())`, [o.id, o.tracking_number, F.ADMIN]);

  const count = async (t) => Number((await db.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);
  const CLEAR = ['orders','order_status_events','trips','payment_attempts','payment_transactions','payment_refunds','cancellation_settlements',
    'cancellation_settlement_history','contact_inquiries','customer_feedback','conversations','chat_messages','notifications',
    'notification_delivery_jobs','activity_logs','photo_storage_events','photo_cleanup_queue','announcement_email_recipients',
    'announcement_email_broadcasts','private.paymongo_refund_recovery_jobs','private.manual_refund_reauth_attempts'];
  const KEEP = ['profiles','company_information','legal_documents','legal_consents','photo_storage_settings','user_device_tokens','email_subscriptions','announcements','auth.users'];
  const before = {};
  for (const t of [...CLEAR, ...KEEP]) before[t] = await count(t);
  ok('rehearsal fixture populated every CLEAR table', CLEAR.every(t => before[t] > 0 || t === 'cancellation_settlements'), before);

  await rejects('reset refuses to run without the backup confirmation',
    () => db.exec(readFileSync(path.join(REPO, 'supabase/maintenance/fresh_start_reset.sql'), 'utf8')), /reset_confirm/);
  await db.query(`UPDATE notification_delivery_jobs SET status='pending'`);
  await rejects('reset refuses while push jobs are still queued', async () => {
    await db.exec(`BEGIN; SET LOCAL cargoexpress.reset_confirm = 'I-HAVE-A-VERIFIED-BACKUP';`);
    try { await db.exec(readFileSync(path.join(REPO, 'supabase/maintenance/fresh_start_reset.sql'), 'utf8')); }
    finally { await db.exec('ROLLBACK;'); }
  }, /push delivery job\(s\) still queued/);
  await db.query(`UPDATE notification_delivery_jobs SET status='sent'`);

  await db.exec(`BEGIN; SET LOCAL cargoexpress.reset_confirm = 'I-HAVE-A-VERIFIED-BACKUP';`);
  await db.exec(readFileSync(path.join(REPO, 'supabase/maintenance/fresh_start_reset.sql'), 'utf8'));
  await db.exec(`COMMIT;`);
  const after = {};
  for (const t of [...CLEAR, ...KEEP]) after[t] = await count(t);
  ok('every CLEAR table is empty', CLEAR.every(t => after[t] === 0), after);
  ok('every KEEP table is unchanged', KEEP.every(t => after[t] === before[t]), KEEP.map(t => [t, before[t], after[t]]));
  const admin = (await as(db, F.ADMIN, 'authenticated', (t) => t.query(`SELECT public.is_admin() a`))).rows[0].a;
  ok('retained administrator still resolves as admin (login identity intact)', admin === true);
  const cons = await count(`legal_consents WHERE user_id = '${F.CUST}'`);
  ok('legal consents for retained accounts kept', cons === 2);

  // A clean booking-to-delivery flow on the empty database.
  const t2 = await F.newTrip(db, { daysAhead: 0 });
  const fresh = await F.newOrder(db, { tripId: t2.id });
  await F.pickup(db, fresh.id, { weight: 4, amount: 280 });
  let r = await F.getOrder(db, fresh.id);
  ok('after reset: booking + pickup + full payment', r.status === 'Picked Up' && r.payment_status === 'paid' && num(r.shipping_cost) === 280, [r.status, r.payment_status, r.shipping_cost]);
  const step = async (sql, args) => as(db, F.ADMIN, 'authenticated', (t) => t.query(sql, args));
  await step(`UPDATE trips SET status='in_progress' WHERE id=$1`, [t2.id]);
  await step(`UPDATE trips SET status='arrived' WHERE id=$1`, [t2.id]);
  r = await F.getOrder(db, fresh.id);
  const hub = r.status;
  await step(`UPDATE orders SET status='Out for Delivery' WHERE id=$1`, [fresh.id]);
  await step(`UPDATE orders SET status='Delivered' WHERE id=$1`, [fresh.id]);
  r = await F.getOrder(db, fresh.id);
  ok(`after reset: trip start/arrive cascade (${hub}) → Out for Delivery → Delivered`, r.status === 'Delivered', r.status);
  const events = await count(`order_status_events WHERE order_id = '${fresh.id}'`);
  ok('status history recorded for the new booking', events >= 3, events);
  await db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('Stage 1 rollback restores the live definitions');
{
  const fnSig = `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname IN ('public','private') AND p.prokind = 'f'
                    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
                  ORDER BY 1`;
  const live = await makeDb();
  const liveDefs = new Map((await live.query(fnSig)).rows.map(r => [r.sig, r.def]));
  const liveTrig = (await live.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='public.orders'::regclass AND NOT tgisinternal ORDER BY 1`)).rows.map(r => r.tgname);

  const db = await makeDb({ migrations: [STAGE1] });
  await F.seed(db);
  const o = await F.newOrder(db);                              // written under stage 1
  await db.query(`INSERT INTO contact_inquiries (name, message, contact_phone) VALUES ('Test Person','A message long enough.','09171112222')`);
  await db.exec(readFileSync(path.join(REPO, 'supabase/maintenance/rollback_stage1.sql'), 'utf8'));

  const after = new Map((await db.query(fnSig)).rows.map(r => [r.sig, r.def]));
  const missing = [...liveDefs.keys()].filter(k => !after.has(k));
  const extra = [...after.keys()].filter(k => !liveDefs.has(k));
  const changed = [...liveDefs.keys()].filter(k => after.has(k) && after.get(k) !== liveDefs.get(k));
  ok('every live function is back with an identical definition', missing.length === 0 && changed.length === 0, { missing, changed });
  ok('no stage-1 function remains', extra.length === 0, extra);
  const trig = (await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='public.orders'::regclass AND NOT tgisinternal ORDER BY 1`)).rows.map(r => r.tgname);
  ok('orders triggers identical to live', JSON.stringify(trig) === JSON.stringify(liveTrig), trig);
  const inq = (await db.query(`SELECT phone FROM contact_inquiries`)).rows[0].phone;
  ok('inquiry written under stage 1 gets its legacy phone back', inq === '09171112222', inq);
  const o2 = await F.newOrder(db, { extra: { sender_address: 'x', receiver_address: 'y' } });
  ok('bookings work again under the restored live functions', o2.sender_name === 'Juan Dela Cruz');
  ok('rows written under stage 1 keep consistent full names', (await F.getOrder(db, o.id)).sender_name === 'Juan Dela Cruz');
  await live.close(); await db.close();
}

await vite.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
