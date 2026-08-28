import { createClient } from '@supabase/supabase-js';
import { ADMIN, CUSTOMER } from './config.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * A Supabase client signed in as the admin, for the two things the UI cannot
 * do reliably from a test:
 *
 *   1. Resolve what the app just created, deterministically. Reading a trip
 *      number off the list page means guessing which row is "ours" — and once
 *      a second run exists, `.first()` picks the wrong trip and the booking
 *      silently attaches to someone else's shipment.
 *
 *   2. Seed a state the UI cannot produce. The dispatch gate refuses to send
 *      an unweighed parcel out for delivery, but every UI path to
 *      "Arrived at Hub" runs through pickup, which requires a weight. The only
 *      way to test the gate is to construct the row it is meant to catch.
 *
 * This uses the ANON key plus a real admin sign-in — the same credentials and
 * the same RLS policies the browser gets. No service-role key is involved, so
 * the tests cannot do anything an admin could not do in the app.
 */

const cache = new Map();

const signedInClient = async (label, email, password) => {
  if (cache.has(label)) return cache.get(label);

  const client = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${label} sign-in for DB helper failed: ${error.message}`);

  cache.set(label, client);
  return client;
};

export const adminClient = () => signedInClient('admin', ADMIN.email, ADMIN.password);

/**
 * The test customer's own session.
 *
 * Needed because there is no admin INSERT policy on `orders` — the only
 * INSERT policy is "Users can create own orders" (`user_id = auth.uid()`).
 * That is correct design: orders originate from customers, and an admin
 * fabricating one for someone else is not a thing the system should allow. So
 * the fixture is created the way a real order is, by its owner.
 */
export const customerClient = (email = CUSTOMER.email) =>
  signedInClient(`customer:${email}`, email, CUSTOMER.password);

/** The trip this run created, found by its unique per-run notes. */
export const findTripByNotes = async (notes) => {
  const db = await adminClient();
  const { data, error } = await db
    .from('trips')
    .select('id, trip_number, status, price_per_kg, capacity')
    .eq('notes', notes)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`findTripByNotes: ${error.message}`);
  if (!data?.length) throw new Error(`No trip found with notes "${notes}"`);
  return data[0];
};

/**
 * The most recent artifacts any E2E run left behind.
 *
 * RUN_ID is generated per process, so a spec run on its own cannot look up
 * "this run's" trip — there isn't one. These fall back to the latest E2E trip
 * and customer so the dispatch-gate spec stays runnable standalone, not only
 * as the tail of a full-suite invocation. The customer password is a constant
 * in config.js, which is what makes signing in as a previous run's customer
 * possible.
 */
export const findLatestE2ETrip = async () => {
  const db = await adminClient();
  const { data, error } = await db
    .from('trips')
    .select('id, trip_number, status, price_per_kg, capacity, notes')
    .like('notes', 'E2E run %')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`findLatestE2ETrip: ${error.message}`);
  return data?.[0] || null;
};

export const findLatestE2ECustomer = async () => {
  const db = await adminClient();
  const { data, error } = await db
    .from('profiles')
    .select('id, name, email, role')
    .like('email', 'e2e.customer.%@cargoexpressph-e2e.test')
    .eq('role', 'customer')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`findLatestE2ECustomer: ${error.message}`);
  return data?.[0] || null;
};

export const getOrderByTracking = async (trackingNumber) => {
  const db = await adminClient();
  const { data, error } = await db
    .from('orders')
    .select('*')
    .eq('tracking_number', trackingNumber)
    .single();

  if (error) throw new Error(`getOrderByTracking: ${error.message}`);
  return data;
};

export const findProfileByEmail = async (email) => {
  const db = await adminClient();
  const { data, error } = await db
    .from('profiles')
    .select('id, name, email, role')
    .eq('email', email)
    .single();

  if (error) throw new Error(`findProfileByEmail: ${error.message}`);
  return data;
};

/**
 * Builds an order that is at 'Arrived at Hub' with NO actual_weight — the
 * exact shape the dispatch gate exists to reject, and one the booking UI
 * cannot produce because pickup demands a weight before it will advance.
 *
 * Two steps on purpose, and with two different identities — which is exactly
 * how a real order is made:
 *
 *   INSERT as the CUSTOMER. The only INSERT policy on `orders` is
 *   `user_id = auth.uid()`, and it is value-constrained to a booking with no
 *   weight and no payment. So this row goes in through the same policy and the
 *   same `prepare_order_insert` trigger as any genuine booking — the tracking
 *   number is server-generated and the weight is nulled for us.
 *
 *   UPDATE as the ADMIN, to walk the status forward to the hub. Nothing here
 *   bypasses RLS or a trigger; the row is identical to a real one in every
 *   respect except the weight it never received.
 */
export const seedUnweighedOrderAtHub = async ({ userId, customerEmail, tripId, runId }) => {
  const asCustomer = await customerClient(customerEmail);
  const asAdmin = await adminClient();

  const { data: inserted, error: insertError } = await asCustomer
    .from('orders')
    .insert({
      user_id: userId,
      origin: 'Manila',
      destination: 'Bohol',
      sender_name: 'Gate Test Sender',
      sender_phone: '09170000001',
      sender_address: 'Kalayaan Avenue, Poblacion, Makati, Metro Manila',
      sender_city: 'Makati',
      sender_province: 'Metro Manila',
      receiver_name: 'Gate Test Receiver',
      receiver_phone: '09170000002',
      receiver_address: 'CPG Avenue, Cogon, Tagbilaran City, Bohol',
      receiver_city: 'Tagbilaran City',
      receiver_province: 'Bohol',
      package_description: `E2E dispatch-gate fixture ${runId}`,
      payer_type: 'sender',
      status: 'Pending',
    })
    .select()
    .single();

  if (insertError) throw new Error(`seedUnweighedOrderAtHub insert: ${insertError.message}`);

  const { data: advanced, error: updateError } = await asAdmin
    .from('orders')
    .update({ trip_id: tripId, status: 'Arrived at Hub' })
    .eq('id', inserted.id)
    .select()
    .single();

  if (updateError) throw new Error(`seedUnweighedOrderAtHub advance: ${updateError.message}`);
  return advanced;
};

/** Attempts the dispatch the gate should refuse. Returns the raw result. */
export const tryDispatch = async (orderId) => {
  const db = await adminClient();
  return db.from('orders').update({ status: 'Out for Delivery' }).eq('id', orderId).select();
};

/**
 * Builds an order that sits at 'Assigned' on a trip — the shape a booked
 * parcel takes before pickup. Inserted through the customer's own INSERT
 * policy (server-generated tracking number, nulled weight) and advanced to
 * 'Assigned' as the admin, exactly like the dispatch-gate fixture.
 */
export const seedAssignedOrder = async ({ userId, customerEmail, tripId, runId }) => {
  const asCustomer = await customerClient(customerEmail);
  const asAdmin = await adminClient();

  const { data: inserted, error: insertError } = await asCustomer
    .from('orders')
    .insert({
      user_id: userId,
      origin: 'Manila',
      destination: 'Bohol',
      sender_name: 'Cancel Fixture Sender',
      sender_phone: '09170000003',
      sender_address: 'Taft Avenue, Malate, Manila, Metro Manila',
      sender_city: 'Manila',
      sender_province: 'Metro Manila',
      receiver_name: 'Cancel Fixture Receiver',
      receiver_phone: '09170000004',
      receiver_address: 'Gallares Street, Cogon, Tagbilaran City, Bohol',
      receiver_city: 'Tagbilaran City',
      receiver_province: 'Bohol',
      package_description: `E2E cancellation fixture ${runId}`,
      payer_type: 'sender',
      status: 'Pending',
    })
    .select()
    .single();

  if (insertError) throw new Error(`seedAssignedOrder insert: ${insertError.message}`);

  const { data: advanced, error: updateError } = await asAdmin
    .from('orders')
    .update({ trip_id: tripId, status: 'Assigned' })
    .eq('id', inserted.id)
    .select()
    .single();

  if (updateError) throw new Error(`seedAssignedOrder advance: ${updateError.message}`);
  return advanced;
};

/**
 * Builds an order that sits at 'Picked Up' on a trip — the shape a booking
 * takes once the courier has collected the parcel from the sender but it has
 * not yet moved. This is the exact boundary the cancellation cutoff sits on:
 * a customer can no longer request cancellation from here (canCancelOrder /
 * request_order_cancellation both refuse it), but an admin still can
 * (canAdminCancelOrder). See seedInTransitOrder for the status one step past
 * this, where NEITHER can cancel any more.
 */
export const seedPickedUpOrder = async ({ userId, customerEmail, tripId, runId }) => {
  const asCustomer = await customerClient(customerEmail);
  const asAdmin = await adminClient();

  const { data: inserted, error: insertError } = await asCustomer
    .from('orders')
    .insert({
      user_id: userId,
      origin: 'Manila',
      destination: 'Bohol',
      sender_name: 'Pickup Cutoff Sender',
      sender_phone: '09170000005',
      sender_address: 'Taft Avenue, Malate, Manila, Metro Manila',
      sender_city: 'Manila',
      sender_province: 'Metro Manila',
      receiver_name: 'Pickup Cutoff Receiver',
      receiver_phone: '09170000006',
      receiver_address: 'Gallares Street, Cogon, Tagbilaran City, Bohol',
      receiver_city: 'Tagbilaran City',
      receiver_province: 'Bohol',
      package_description: `E2E pickup-cutoff fixture ${runId}`,
      payer_type: 'sender',
      status: 'Pending',
    })
    .select()
    .single();

  if (insertError) throw new Error(`seedPickedUpOrder insert: ${insertError.message}`);

  const { data: advanced, error: updateError } = await asAdmin
    .from('orders')
    .update({ trip_id: tripId, status: 'Picked Up' })
    .eq('id', inserted.id)
    .select()
    .single();

  if (updateError) throw new Error(`seedPickedUpOrder advance: ${updateError.message}`);
  return advanced;
};

/**
 * Builds an order at 'In Transit' — one status past the Picked-Up cutoff
 * above. The shipment has left for the other island, so cancellation is
 * refused for everyone here, admins included.
 */
export const seedInTransitOrder = async ({ userId, customerEmail, tripId, runId }) => {
  const asCustomer = await customerClient(customerEmail);
  const asAdmin = await adminClient();

  const { data: inserted, error: insertError } = await asCustomer
    .from('orders')
    .insert({
      user_id: userId,
      origin: 'Manila',
      destination: 'Bohol',
      sender_name: 'In-Transit Cutoff Sender',
      sender_phone: '09170000007',
      sender_address: 'Taft Avenue, Malate, Manila, Metro Manila',
      sender_city: 'Manila',
      sender_province: 'Metro Manila',
      receiver_name: 'In-Transit Cutoff Receiver',
      receiver_phone: '09170000008',
      receiver_address: 'Gallares Street, Cogon, Tagbilaran City, Bohol',
      receiver_city: 'Tagbilaran City',
      receiver_province: 'Bohol',
      package_description: `E2E in-transit-cutoff fixture ${runId}`,
      payer_type: 'sender',
      status: 'Pending',
    })
    .select()
    .single();

  if (insertError) throw new Error(`seedInTransitOrder insert: ${insertError.message}`);

  const { data: advanced, error: updateError } = await asAdmin
    .from('orders')
    .update({ trip_id: tripId, status: 'In Transit' })
    .eq('id', inserted.id)
    .select()
    .single();

  if (updateError) throw new Error(`seedInTransitOrder advance: ${updateError.message}`);
  return advanced;
};

export const deleteOrder = async (orderId) => {
  const db = await adminClient();
  await db.from('orders').delete().eq('id', orderId);
};
