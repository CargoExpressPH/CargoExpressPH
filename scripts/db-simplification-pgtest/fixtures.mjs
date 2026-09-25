// Synthetic fixtures only — no production data.
import { as } from './harness.mjs';
export const ADMIN = '00000000-0000-0000-0000-00000000a001';
export const CUST = '00000000-0000-0000-0000-00000000c001';
export const CUST2 = '00000000-0000-0000-0000-00000000c002';
export const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

export async function seed(db, { rate = 70, capacity = 1000 } = {}) {
  await db.exec(`ALTER TABLE public.profiles DISABLE TRIGGER USER`);
  for (const [id, role, name] of [[ADMIN, 'admin', 'Test Admin'], [CUST, 'customer', 'Test Customer'], [CUST2, 'customer', 'Other Customer']]) {
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `${role}-${id.slice(-4)}@example.test`]);
    await db.query(`INSERT INTO public.profiles (id, name, email, role) VALUES ($1, $2, $3, $4)`, [id, name, `${role}-${id.slice(-4)}@example.test`, role]);
  }
  await db.exec(`ALTER TABLE public.profiles ENABLE TRIGGER USER`);
  await db.query(`INSERT INTO public.company_information (id, name, default_price_per_kg, default_capacity) VALUES ($1, 'Test Co', $2, $3)`, [COMPANY_ID, rate, capacity]);
}

let tripSeq = 0;
export async function newTrip(db, { origin = 'Manila', destination = 'Bohol', daysAhead = null, extra = {} } = {}) {
  tripSeq++;
  // One trip per route per PH day is enforced (trips_unique_route_departure_day),
  // so a default trip gets its own future day; daysAhead: 0 means today.
  if (daysAhead === null) daysAhead = 3 + tripSeq;
  const cols = { trip_number: `TRIP-T-${tripSeq}`, origin, destination, status: 'scheduled', created_by: ADMIN, ...extra };
  const keys = Object.keys(cols);
  return as(db, ADMIN, 'authenticated', async (tx) => {
    const r = await tx.query(
      `INSERT INTO public.trips (${keys.join(',')}, departure_date) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}, now() + ($${keys.length + 1} || ' days')::interval) RETURNING *`,
      [...Object.values(cols), String(daysAhead)]);
    return r.rows[0];
  });
}

export const PERSON = {
  sender_first_name: 'Juan', sender_last_name: 'Dela Cruz', sender_phone: '09171234567',
  sender_province: 'Metro Manila', sender_city: 'Quezon City', sender_barangay: 'Bagumbayan',
  sender_street: 'Rizal St', sender_lot_block: 'Lot 5 Blk 2', sender_landmark: 'Near chapel',
  receiver_first_name: 'Maria', receiver_last_name: 'Santos', receiver_phone: '09181234567',
  receiver_province: 'Bohol', receiver_city: 'Tagbilaran City', receiver_barangay: 'Cogon',
  receiver_street: 'CPG Ave', receiver_lot_block: '', receiver_landmark: 'Beside school',
  origin: 'Manila', destination: 'Bohol', package_description: 'Box of clothes', payer_type: 'sender',
};

export async function newOrder(db, { uid = CUST, role = 'authenticated', tripId = null, extra = {} } = {}) {
  const cols = { ...PERSON, user_id: uid, ...(tripId ? { trip_id: tripId } : {}), ...extra };
  const keys = Object.keys(cols);
  return as(db, uid, role, async (tx) => {
    const r = await tx.query(`INSERT INTO public.orders (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, Object.values(cols));
    return r.rows[0];
  });
}

export async function pickup(db, orderId, { weight, amount = null, method = 'cash', discount = 0, reason = null, notes = null, payer = 'sender', promise = null } = {}) {
  return as(db, ADMIN, 'authenticated', async (tx) => {
    const r = await tx.query(
      `SELECT * FROM public.record_pickup_payment(p_order_id => $1, p_actual_weight => $2, p_payment_method => $3, p_payer_type => $4,
         p_amount => $5, p_idempotency_key => gen_random_uuid(), p_discount_amount => $6, p_discount_reason => $7, p_discount_notes => $8,
         p_promised_payment_date => $9, p_reference => $10)`,
      [orderId, weight, method, payer, amount, discount, reason, notes, promise, method === 'gcash' ? 'REF' + Math.floor(Math.random() * 1e9) : null]);
    return r.rows[0];
  });
}

export async function getOrder(db, id) {
  return (await db.query(`SELECT * FROM public.orders WHERE id = $1`, [id])).rows[0];
}
export async function setRate(db, rate, capacity) {
  await db.query(`UPDATE public.company_information SET default_price_per_kg = COALESCE($1, default_price_per_kg), default_capacity = COALESCE($2, default_capacity) WHERE id = $3`, [rate, capacity ?? null, COMPANY_ID]);
}
