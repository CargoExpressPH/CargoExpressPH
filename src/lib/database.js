import { supabase } from './supabase';
import { emitNotificationsChanged } from './notification-events';
import { logOrder, logChat } from './activityLog';
import { validateStatusTransition, outstandingBalance, finalShippingFee, ORDER_STATUS, tripCapacityState, tripCapacityRefusal, canAdminCancelOrder } from '../constants/status';
import { detectPickupLocation } from '../constants/phLocations';
import { phDayRangeISO, formatPhDate, phDateKey } from '../utils/datetime';

// ==================== HELPER ====================
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// withTimeout is now a pass-through.
// Timeouts and automatic retries are now handled globally by the custom fetch
// wrapper in supabase.js (45 seconds timeout + 3 retries).
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export const withTimeout = (promise, ms = 60000) => {
  return promise;
};

const generateTrackingNumber = () => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `CE-${date}-${rand}`;
};

const generateTripNumber = () => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100 + Math.random() * 900);
  return `TRIP-${date}-${rand}`;
};

const getGlobalPricePerKilo = async () => {
  let pricePerKilo = 70;
  try {
    const { data: info } = await supabase
      .from('company_information')
      .select('default_price_per_kg')
      .single();
    if (info && info.default_price_per_kg != null) {
      pricePerKilo = parseFloat(info.default_price_per_kg);
    }
  } catch (e) {
    // Use local default when settings are unavailable.
  }
  return pricePerKilo;
};

/**
 * Aggregate weight per trip, via the SECURITY DEFINER RPC get_trips_load
 * (20260830000000_get_trips_load_rpc.sql) rather than a direct
 * `.from('orders').select(...)`. The "Users can view own orders" RLS policy
 * only lets a signed-in customer read their OWN order rows, so a direct
 * client-side query — and a client-side SUM() over it — silently undercounts
 * every other customer's cargo on the trip. The RPC does the SUM() inside
 * Postgres, bypassing RLS for the aggregate only, and returns nothing more
 * granular than trip_id + total weight.
 *
 * excludeOrderId is handled here by subtracting that one order's OWN weight
 * (which the caller can always read under RLS, since the excluded order is
 * always the caller's own) from the RPC's true total — re-weighing an order
 * still compares the NEW weight against the trip without that order's OLD
 * weight, exactly as before.
 */
export const getTripCurrentWeight = async (tripId, excludeOrderId = null) => {
  if (!tripId) return 0;

  const { data, error } = await supabase.rpc('get_trips_load', { trip_ids: [tripId] });
  if (error) throw error;

  let total = parseFloat(data?.[0]?.current_weight || 0);

  if (excludeOrderId) {
    const { data: excluded, error: excludedError } = await supabase
      .from('orders')
      .select('actual_weight, status')
      .eq('id', excludeOrderId)
      .maybeSingle();
    if (excludedError) throw excludedError;
    if (excluded && excluded.status !== 'Cancelled') {
      total -= parseFloat(excluded.actual_weight || 0);
    }
  }

  return Math.max(total, 0);
};

/**
 * Refuses cargo that would put a trip past its absolute ceiling — planned
 * capacity + TRIP_CAPACITY_ALLOWANCE_KG (200 kg).
 *
 * Every path that puts weight on a trip funnels through here: a customer
 * booking onto a chosen trip, an admin assigning a booking to one, and an
 * admin recording a weight at pickup. That is why the check lives in this
 * function rather than in the three call sites.
 *
 * The exclusion of `excludeOrderId` matters on the weight path: re-weighing an
 * order already on the trip must compare the NEW weight against the trip
 * without that order's old weight, or correcting 100 kg to 101 kg would be
 * measured as if 101 kg were being added on top of the 100 already counted.
 *
 * This is a UX guard, not the enforcement. It runs in the browser, so a direct
 * PostgREST call still writes whatever it likes — `20260526010000` removed the
 * database's capacity trigger on purpose. Making this a real invariant needs
 * that trigger back.
 */
const assertTripCapacity = async (trip, incomingWeight, excludeOrderId = null) => {
  if (!trip) return;
  const state = tripCapacityState(trip, 0, 0);
  // No capacity recorded on the trip: nothing to enforce, and refusing every
  // booking over a blank field would be worse than not enforcing it.
  if (!state.hasLimit) return;

  const currentWeight = await getTripCurrentWeight(trip.id, excludeOrderId);
  const check = tripCapacityState(trip, currentWeight, incomingWeight);
  if (check.wouldExceed) {
    throw new Error(tripCapacityRefusal(trip, currentWeight, incomingWeight));
  }
};

const effectiveTripPrice = async (trip) => {
  const tripPrice = parseFloat(trip?.price_per_kg || 0);
  return tripPrice > 0 ? tripPrice : getGlobalPricePerKilo();
};

// ==================== PROFILES ====================
export const getProfile = async (userId) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
};

export const getAdminProfile = async () => {
  const { data: publicProfile, error: publicError } = await supabase
    .rpc('get_public_business_profile')
    .maybeSingle();

  if (!publicError && publicProfile) return publicProfile;

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('role', 'admin')
    .limit(1)
    .single();
  // It's okay if it throws PGRST116 (0 rows) on fresh setups, but usually there's 1 admin.
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
};

export const updateProfile = async (userId, updates) => {
  const blockedFields = new Set(['id', 'email', 'role', 'created_at']);
  const safeUpdates = Object.fromEntries(
    Object.entries(updates || {}).filter(([key]) => !blockedFields.has(key))
  );

  const { data, error } = await supabase
    .from('profiles')
    .update(safeUpdates)
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const createProfile = async (profile) => {
  // Use upsert instead of plain insert.
  // WHY: Supabase may have an auth trigger (on_auth_user_created) that
  // auto-inserts a minimal profile row when signUp() runs. If that happens,
  // a plain .insert() fails with a duplicate-key error (23505) because the
  // row already exists — but with empty data (no name, phone, address, etc.).
  // Upsert handles both cases:
  //   - Row doesn't exist → INSERT with all the registration data
  //   - Row already exists → UPDATE it with the registration data
  const { data, error } = await supabase
    .from('profiles')
    .upsert(profile, { onConflict: 'id' })
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ==================== ORDERS ====================
export const createOrder = async (orderData) => {
  const trackingNumber = generateTrackingNumber();
  
  // Route-location validation guard
  if (orderData.sender_province && orderData.origin) {
    const detected = detectPickupLocation(orderData.sender_province);
    const expectedOrigin = detected === 'bohol' ? 'Bohol' : detected === 'manila' ? 'Manila' : null;
    if (expectedOrigin && expectedOrigin !== orderData.origin) {
      throw new Error(`Sender province "${orderData.sender_province}" does not match the selected route origin "${orderData.origin}".`);
    }
  }

  // A booking has no weight: the customer describes the parcel, the scale
  // prices it at pickup. Kept as 0 so the trip-capacity call below keeps its
  // shape — the rate is still resolved because it is shown to the customer.
  const weight = 0;
  let pricePerKilo = await getGlobalPricePerKilo();

  let finalStatus = 'Pending';
  let finalTripId = null;
  let finalOrigin = orderData.origin;
  let finalDestination = orderData.destination;

  if (orderData.trip_id) {
    const { data: trip, error: tripError } = await withTimeout(
      supabase
        .from('trips')
        .select('id, origin, destination, capacity, price_per_kg')
        .eq('id', orderData.trip_id)
        .single()
    );
    if (tripError || !trip) {
      throw new Error('Selected trip is no longer available. Please choose another trip or book without selecting one.');
    }

    await assertTripCapacity(trip, weight);
    pricePerKilo = await effectiveTripPrice(trip);
    finalStatus = 'Assigned';
    finalTripId = orderData.trip_id;
    finalOrigin = trip.origin;
    finalDestination = trip.destination;
  }

  // 0 until the parcel is weighed. prepare_order_insert enforces this
  // server-side too; sending it explicitly keeps the optimistic row honest.
  const shippingCost = weight * pricePerKilo;

  const { data, error } = await withTimeout(
    supabase
      .from('orders')
      .insert({
        ...orderData,
        tracking_number: trackingNumber,
        shipping_cost: shippingCost,
        amount_paid: 0,
        remaining_balance: shippingCost,
        payment_status: 'unpaid',
        payment_method: null,
        actual_weight: null,
        pickup_photos: [],
        delivery_photos: [],
        status: finalStatus,
        trip_id: finalTripId,
        origin: finalOrigin || null,
        destination: finalDestination || null,
      })
      .select()
      .single()
  );
  
  if (error) throw error;

  return data;
};

export const getOrders = async (userId, isAdmin = false, options = {}) => {
  const { page, perPage, limit, statusFilter, search } = options;

  let query = supabase
    .from('orders')
    .select(`
      *,
      profiles:user_id (name, phone, email),
      trips:trip_id (origin, destination, trip_number)
    `, { count: (page && perPage) ? 'exact' : null })
    .order('created_at', { ascending: false });

  if (!isAdmin) {
    query = query.eq('user_id', userId);
  }

  // A string matches one status; an array matches any of several, which is what
  // the admin list's grouped filters ("Active", "Action Needed") need. The
  // grouping has to happen in the query, not on the returned page: the rows are
  // paginated server-side, so filtering the 15 rows that came back would show a
  // part of a page and report a count for a different population.
  if (Array.isArray(statusFilter)) {
    if (statusFilter.length > 0) query = query.in('status', statusFilter);
  } else if (statusFilter && statusFilter !== 'All') {
    query = query.eq('status', statusFilter);
  }

  if (search) {
    query = query.or(`tracking_number.ilike.%${search}%,sender_name.ilike.%${search}%,receiver_name.ilike.%${search}%`);
  }

  if (page && perPage) {
    const from = (page - 1) * perPage;
    const to = from + perPage - 1;
    query = query.range(from, to);
  } else if (limit) {
    query = query.limit(limit);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  
  if (page && perPage) {
    return { data: data || [], count: count || 0 };
  }
  return data || [];
};

/**
 * { 'Pending': 12, 'In Transit': 3, Ã¢â‚¬Â¦ } across every order — admin only.
 *
 * One grouped aggregate in one round trip, not one COUNT per filter tab. The
 * caller sums these into whatever groups it displays; a status with no orders
 * is absent from the object, so read a missing key as 0.
 */
export const getOrderStatusCounts = async () => {
  const { data, error } = await withTimeout(supabase.rpc('get_order_status_counts'));
  if (error) throw error;
  return data || {};
};

export const getOrderById = async (orderId) => {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      profiles:user_id (name, phone, email, role),
      trips:trip_id (origin, destination, trip_number, capacity, price_per_kg)
    `)
    .eq('id', orderId)
    .single();
  if (error) throw error;
  return data;
};

export const updateOrder = async (orderId, updates) => {
  // Status transition validation
  let currentOrder = null;
  if (updates.status) {
    const { data } = await supabase
      .from('orders')
      .select('status, trip_id, actual_weight, amount_paid, shipping_cost, remaining_balance, payer_type, promised_payment_date')
      .eq('id', orderId)
      .single();
    currentOrder = data;
    
    if (currentOrder) {
      // Pickup saves (identified by pickup_photos or payment_reference) are allowed
      // to bypass strict sequential status validation. The GCash payment is captured
      // BEFORE the order status is saved — so the order may still be 'Pending' or
      // 'Assigned' when we try to set it to 'Picked Up'. Blocking this would leave
      // the customer charged with an unrecorded payment.
      const isPickupSave = updates.pickup_photos !== undefined || updates.payment_reference !== undefined;
      
      if (!isPickupSave) {
        const tripId = updates.trip_id || currentOrder.trip_id;
        const validation = validateStatusTransition(currentOrder.status, updates.status, tripId, { ...currentOrder, ...updates });
        if (!validation.valid) {
          throw new Error(validation.error);
        }
      }
    }
  }

  if (!currentOrder && (updates.trip_id !== undefined || updates.actual_weight !== undefined || updates.amount_paid !== undefined)) {
    const { data } = await supabase
      .from('orders')
      .select('status, trip_id, actual_weight, amount_paid, shipping_cost, remaining_balance, payer_type, promised_payment_date')
      .eq('id', orderId)
      .single();
    currentOrder = data;
  }

  if (updates.trip_id) {
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, origin, destination, capacity, price_per_kg')
      .eq('id', updates.trip_id)
      .single();
    if (tripError) throw tripError;
    await assertTripCapacity(
      trip,
      updates.actual_weight ?? currentOrder?.actual_weight ?? 0,
      orderId
    );
  }

  // Recalculate shipping cost if actual_weight or trip_id changed
  if (updates.actual_weight !== undefined || updates.trip_id !== undefined) {
    let trip = null;
    const tripId = updates.trip_id || currentOrder?.trip_id;
    const weight = parseFloat(updates.actual_weight !== undefined ? updates.actual_weight : (currentOrder?.actual_weight ?? 0)) || 0;
    
    if (tripId) {
      const { data: tripData } = await supabase
        .from('trips')
        .select('id, capacity, price_per_kg')
        .eq('id', tripId)
        .single();
      trip = tripData;
      // Deliberately NOT capacity-checked. The ceiling governs ACCEPTING a
      // booking onto a trip; this path is an admin recording what the scale
      // said about cargo that is already physically there. Refusing it would
      // not un-load the van, it would only stop the system from knowing the
      // truth — and every downstream figure (price, balance, the trip's own
      // load) is derived from that weight. An overloaded trip is a dispatch
      // problem to be solved by reassigning cargo, which the assign and
      // reassign paths police.
      void weight;
    }
    const pricePerKilo = trip ? await effectiveTripPrice(trip) : await getGlobalPricePerKilo();
    updates.shipping_cost = weight * pricePerKilo;
  }
  
  // Ã¢â€â‚¬Ã¢â€â‚¬ Payment totals are NOT derived here Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // amount_paid / remaining_balance / payment_status are owned exclusively by
  // the payment_transactions ledger, via the update_order_payment_totals
  // trigger. This function used to compute them client-side, which competed
  // with that trigger and with PickupModal — three writers for three columns.
  // Money now flows through record_pickup_payment / record_delivery_payment
  // (atomic) or recordPaymentTransaction (ledger insert). See P0-1 in
  // docs/database-architecture-review.md.
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  const { data, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', orderId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

/**
 * Edit an existing booking's sender/receiver identity & address — the ONLY
 * fields this path can touch. Routed through update_order_contact_details()
 * rather than the plain `.update()` above because there is no "customer can
 * update own orders" RLS policy (see 20260524190000_production_hardening.sql
 * — every customer-side order mutation is a narrow SECURITY DEFINER RPC, not
 * a raw table write). That RPC re-checks ownership and the status lock
 * server-side and writes the activity_logs row in the same transaction as the
 * update, so the audit trail cannot be lost between two round trips.
 */
export const updateOrderContactDetails = async (orderId, fields) => {
  const { data, error } = await supabase.rpc('update_order_contact_details', {
    p_order_id: orderId,
    p_sender_name: fields.sender_name,
    p_sender_phone: fields.sender_phone,
    p_sender_province: fields.sender_province,
    p_sender_city: fields.sender_city,
    p_sender_barangay: fields.sender_barangay,
    p_sender_street: fields.sender_street,
    p_sender_landmark: fields.sender_landmark,
    p_sender_address: fields.sender_address,
    p_receiver_name: fields.receiver_name,
    p_receiver_phone: fields.receiver_phone,
    p_receiver_province: fields.receiver_province,
    p_receiver_city: fields.receiver_city,
    p_receiver_barangay: fields.receiver_barangay,
    p_receiver_street: fields.receiver_street,
    p_receiver_landmark: fields.receiver_landmark,
    p_receiver_address: fields.receiver_address,
  });
  if (error) throw error;
  return data;
};

/**
 * Admin cancels a booking outright, stating why.
 *
 * Distinct from reviewOrderCancellation, which rules on a request the customer
 * made. Here nobody asked — the admin is ending the booking — so the reason is
 * the only record of why, and it is written in the SAME statement as the
 * status. The activity log and the customer's notification are separate round
 * trips that can be lost; the row cannot be left saying 'Cancelled' with no
 * explanation beside it.
 *
 * `requested_at` stays unset in the JSONB, which is what tells an
 * admin-initiated cancellation apart from an approved customer request (see
 * OrderDetailPage's "cancelled at your request" vs "cancelled by our team").
 * `previous_status` also stays unset on purpose: it exists so a *rejected*
 * request can be put back exactly where it was, and there is nothing to put
 * back here.
 *
 * The eligibility check re-fetches status rather than trusting a caller's
 * cached copy — this is the last line of defense before the write, not a
 * pre-flight convenience, so a stale `order` object sitting in a page that
 * hasn't refreshed cannot force a cancellation the current row no longer
 * allows. It only re-implements the same rule the admin console's button
 * visibility already enforces (canAdminCancelOrder); it is not a substitute
 * for a database-level guarantee, which would need a dedicated RPC — nothing
 * stops a caller with an admin session from bypassing this file entirely and
 * writing to `orders` directly.
 */
export const cancelOrderAsAdmin = async (orderId, reason) => {
  const trimmed = (reason || '').trim();
  if (trimmed.length < 5) {
    throw new Error('Please state why this booking is being cancelled (at least 5 characters).');
  }

  const { data: current, error: fetchError } = await supabase
    .from('orders')
    .select('status')
    .eq('id', orderId)
    .single();
  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      throw new Error('Booking not found, or your session has expired. Please refresh and try again.');
    }
    throw fetchError;
  }

  if (!canAdminCancelOrder(current)) {
    throw new Error(
      current.status === ORDER_STATUS.PENDING_CANCELLATION
        ? 'This order has a cancellation request awaiting review. Approve or decline it instead.'
        : `An order that is "${current.status}" can no longer be cancelled — it has already left for the other island.`
    );
  }

  const { data: auth } = await supabase.auth.getUser();
  return updateOrder(orderId, {
    status: 'Cancelled',
    cancellation_details: {
      reason: trimmed,
      reviewed_at: new Date().toISOString(),
      reviewed_by: auth?.user?.id || null,
    },
  });
};

/**
 * Re-attach a guest ("walk-in") booking to a customer's registered account.
 *
 * AdminCreateBookingPage inserts a walk-in booking under the ADMIN's own
 * user_id, on purpose — that is what lets a non-techy customer who doesn't
 * want to register still get a trackable order. If that customer later
 * registers for real, this is the sanctioned way ownership moves onto their
 * account so the booking joins their history.
 *
 * Two refusals, both load-bearing:
 *   - the target must be a genuine `role = 'customer'` profile, never another
 *     admin and never a non-existent id;
 *   - the order must not already belong to a real customer. This function
 *     claims a GUEST booking; it is not a general "reassign this order to a
 *     different person" tool, and silently letting it move a real customer's
 *     own booking onto someone else would be exactly that.
 */
export const assignOrderToCustomer = async (orderId, customerId) => {
  const { data: customer, error: profileError } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('id', customerId)
    .single();
  if (profileError) throw profileError;
  if (!customer || customer.role !== 'customer') {
    throw new Error('Bookings can only be assigned to a registered customer account.');
  }

  const { data: current, error: currentError } = await supabase
    .from('orders')
    .select('profiles:user_id (role)')
    .eq('id', orderId)
    .single();
  if (currentError) throw currentError;
  if (current?.profiles?.role === 'customer') {
    throw new Error('This booking is already linked to a registered customer.');
  }

  const { data, error } = await supabase
    .from('orders')
    .update({ user_id: customerId })
    .eq('id', orderId)
    .select(`
      *,
      profiles:user_id (name, phone, email, role),
      trips:trip_id (origin, destination, trip_number, capacity, price_per_kg)
    `)
    .single();
  if (error) throw error;
  return data;
};

/**
 * Customer asks to cancel a booking, stating why.
 *
 * This does NOT cancel anything. It moves the order to 'Pending Cancellation'
 * and notifies every admin; the booking keeps its trip slot until someone
 * rules on it. `cancelOwnOrder` — which flipped the row straight to
 * 'Cancelled' with no reason recorded — is gone with the RPC behind it
 * (20260816100000).
 *
 * The reason is validated server-side too; this check only saves a round trip.
 */
export const requestOrderCancellation = async (orderId, reason) => {
  const trimmed = (reason || '').trim();
  if (trimmed.length < 5) {
    throw new Error('Please tell us why you are cancelling (at least 5 characters).');
  }
  const { data, error } = await supabase.rpc('request_order_cancellation', {
    p_order_id: orderId,
    p_reason: trimmed,
  });
  if (error) throw error;

  return data;
};

/**
 * Admin rules on a cancellation request.
 *
 * Approve → 'Cancelled'. Reject → back to `cancellation_previous_status`, the
 * exact status the order was standing in when the request was made, so a
 * rejection puts an Assigned booking back as Assigned rather than guessing
 * 'Pending' and silently detaching it from a trip it is still on.
 *
 * The RPC writes the activity log and the customer's notification itself, so
 * neither can be skipped by a caller that forgets.
 */
export const reviewOrderCancellation = async (orderId, approve, notes = null) => {
  const { data, error } = await supabase.rpc('review_order_cancellation', {
    p_order_id: orderId,
    p_approve: approve,
    p_notes: notes || null,
  });
  if (error) throw error;

  return data;
};

export const getCancellationSettlementSummary = async (orderId) => {
  const { data, error } = await supabase.rpc('get_cancellation_settlement_summary', {
    p_order_id: orderId,
  });
  if (error) throw error;
  return data;
};

export const recordCancellationSettlementDecision = async ({
  orderId,
  decisionType,
  agreedRetainedAmount,
  customerAgreementConfirmed,
  internalNotes,
  idempotencyKey,
}) => {
  const { data, error } = await supabase.rpc('record_cancellation_settlement_decision', {
    p_order_id: orderId,
    p_decision_type: decisionType,
    p_agreed_retained_amount: agreedRetainedAmount,
    p_customer_agreement_confirmed: customerAgreementConfirmed,
    p_internal_notes: internalNotes || null,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return data;
};

export const amendCancellationSettlementDecision = async (payload) => {
  const { data, error } = await supabase.rpc('amend_cancellation_settlement_decision', {
    p_order_id: payload.orderId,
    p_decision_type: payload.decisionType,
    p_agreed_retained_amount: payload.agreedRetainedAmount,
    p_customer_agreement_confirmed: payload.customerAgreementConfirmed,
    p_internal_notes: payload.internalNotes || null,
    p_idempotency_key: payload.idempotencyKey,
  });
  if (error) throw error;
  return data;
};

/** Orders whose cancellation request is still waiting on an admin. */
export const getPendingCancellations = async () => {
  const { data, error } = await supabase
    .from('orders')
    .select('*, profiles:user_id (name, email, phone)')
    .eq('status', ORDER_STATUS.PENDING_CANCELLATION)
    .order('updated_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const deleteOrder = async (orderId) => {
  const { error } = await supabase
    .from('orders')
    .delete()
    .eq('id', orderId);
  if (error) throw error;
};

export const getPendingGrouped = async () => {
  const { data: orders, error } = await supabase
    .from('orders')
    .select(`*, profiles:user_id (name)`)
    .eq('status', 'Pending')
    .is('trip_id', null);
  if (error) throw error;

  // Group by route
  const groups = {};
  (orders || []).forEach(order => {
    const key = `${order.origin}→${order.destination}`;
    if (!groups[key]) {
      groups[key] = { origin: order.origin, destination: order.destination, count: 0, orders: [] };
    }
    groups[key].count++;
    groups[key].orders.push(order);
  });

  return Object.values(groups);
};

// ==================== TRIPS ====================

/**
 * One route may run once per calendar day. The message is built here so the
 * pre-flight check in the form and the failure thrown by createTrip word it
 * identically — the admin should not be able to tell which one caught it.
 */
export const duplicateTripMessage = (origin, destination, departureDate) =>
  `A trip from ${origin} to ${destination} is already scheduled for ${formatPhDate(departureDate)}.`;

/**
 * The existing non-cancelled trip on the same route and the same *Philippine*
 * calendar day, or null. The window is computed as an instant range rather than
 * a DATE() cast because departure_date is TIMESTAMPTZ: a 6:00 AM Manila
 * departure is stored as 22:00 UTC the previous day, so comparing UTC dates
 * would file it under the wrong day. See phDayRangeISO.
 *
 * This is a courtesy check, not the enforcement — two admins submitting at once
 * both pass it. The unique index added in 20260818090000 is what actually
 * prevents the duplicate row; createTrip translates its 23505 back into this
 * same sentence.
 */
export const findDuplicateTrip = async ({ origin, destination, departure_date, excludeTripId } = {}) => {
  if (!origin || !destination || !departure_date) return null;
  const { start, end } = phDayRangeISO(departure_date);
  if (!start || !end) return null;

  let query = supabase
    .from('trips')
    .select('id, trip_number, origin, destination, departure_date, status')
    .eq('origin', origin)
    .eq('destination', destination)
    .gte('departure_date', start)
    .lt('departure_date', end)
    .neq('status', 'cancelled')
    .limit(1);
  if (excludeTripId) query = query.neq('id', excludeTripId);

  const { data, error } = await withTimeout(query);
  if (error) throw error;
  return data?.[0] || null;
};

export const createTrip = async (tripData) => {
  // Our own flag, not a trips column — pulled out before the insert below,
  // then used after the trip (and its trip_number) actually exist.
  const { announce_via_email, ...tripFields } = tripData;
  const tripNumber = generateTripNumber();

  const { data: user } = await supabase.auth.getUser();

  const duplicate = await findDuplicateTrip(tripFields);
  if (duplicate) {
    throw new Error(duplicateTripMessage(tripFields.origin, tripFields.destination, tripFields.departure_date));
  }

  const { data, error } = await supabase
    .from('trips')
    .insert({
      // available_slots is intentionally not written: it was a stale copy of
      // capacity that nothing ever read or decremented. Deprecated in
      // 20260803150000_deprecate_dead_columns.sql. Trip load is computed live
      // from order weights (see getTrips / current_trip_weight).
      ...tripFields,
      status: 'scheduled',
      trip_number: tripNumber,
      created_by: user?.user?.id || null,
    })
    .select()
    .single();
  if (error) {
    // The index is the real gate; the check above only loses a round trip.
    if (error.code === '23505' && /trips_unique_route_departure_day/.test(error.message || '')) {
      throw new Error(duplicateTripMessage(tripFields.origin, tripFields.destination, tripFields.departure_date));
    }
    throw error;
  }

  // Auto-assign pending orders matching this route
  let autoAssignedCount = 0;
  let autoAssignmentWarning = null;
  if (data.origin && data.destination) {
    const { data: pendingOrders, error: pendingErr } = await supabase
      .from('orders')
      .select('id, actual_weight')
      .eq('status', 'Pending')
      .is('trip_id', null)
      .eq('origin', data.origin)
      .eq('destination', data.destination)
      .order('created_at', { ascending: true });

    if (pendingErr) {
      autoAssignmentWarning = 'The trip was created, but pending bookings could not be checked for automatic assignment.';
    } else if (pendingOrders?.length) {
      let plannedWeight = 0;
      const selectedIds = [];
      const capacity = Number(data.capacity || 0);

      for (const order of pendingOrders) {
        const weight = parseFloat(order.actual_weight || 0);
        if (capacity > 0 && plannedWeight + weight > capacity) continue;
        plannedWeight += weight;
        selectedIds.push(order.id);
      }

      if (selectedIds.length > 0) {
        const { data: updated, error: updateErr } = await supabase
          .from('orders')
          .update({ trip_id: data.id, status: 'Assigned' })
          .in('id', selectedIds)
          // Compare-and-set the state used when selecting candidates. Without
          // these filters, a concurrent admin action could be overwritten and
          // move an order back to Assigned or onto the wrong route.
          .eq('status', 'Pending')
          .is('trip_id', null)
          .eq('origin', data.origin)
          .eq('destination', data.destination)
          .select('id, user_id, tracking_number');
        
        if (updateErr) {
          autoAssignmentWarning = 'The trip was created, but matching pending bookings could not be assigned automatically.';
        } else {
          autoAssignedCount = updated?.length || 0;
          if (autoAssignedCount !== selectedIds.length) {
            autoAssignmentWarning = `The trip was created, but ${selectedIds.length - autoAssignedCount} matching booking(s) changed before automatic assignment. Review the trip before departure.`;
          }
          
          // Activity logs only. The customer's "Order Assigned" notification is
          // written by the orders_notify_customer_of_change trigger inside the
          // same transaction as the trip_id write above — sending it from here
          // as well would give every auto-assigned customer two of them.
          await Promise.all((updated || []).map(async (order) => {
            try {
              await logOrder('Order Assigned', order.id, order.tracking_number, {
                previousValue: { status: 'Pending', trip_id: null },
                newValue: { status: 'Assigned', trip_id: data.id },
                details: `System auto-assigned to Trip ${tripNumber} during creation`
              });
            } catch (err) {
              console.warn(`Failed to log auto-assignment for order ${order.id}`, err);
            }
          }));
        }
      }
    }
  }

  // Optional trip-schedule email blast. The trip INSERT already created the
  // customer in-app notifications and push jobs atomically in the database.
  // This email-only announcement reuses the durable subscriber-email worker
  // without producing a second customer notification.
  // The consent check (profiles.wants_announcements / contact_inquiries.
  // wants_announcements) lives entirely inside that Edge Function; nothing
  // here bypasses or duplicates it.
  if (announce_via_email) {
    try {
      await createAnnouncement({
        title: `Bagong Biyahe: ${data.origin} → ${data.destination}`,
        content: `Bagong Biyahe! Mayroon kaming bagong scheduled trip papuntang ${data.destination} sa ${formatPhDate(data.departure_date)}. I-secure na ang slot ng inyong cargo habang may space pa!`,
        send_email: true,
        audience: 'email_only',
      });
    } catch (announceErr) {
      // Non-critical — the trip itself is already created and usable.
      console.warn('[createTrip] trip announcement failed to publish:', announceErr);
    }
  }

  return { ...data, autoAssignedCount, autoAssignmentWarning };
};

export const getTrips = async (statusFilter) => {
  let query = supabase
    .from('trips')
    .select('*');

  if (statusFilter === 'active') {
    // Only 'scheduled' trips whose PH calendar day hasn't passed — mirrors
    // guard_customer_order_insert()'s ph_calendar_day() cutoff exactly (see
    // 20260829160000_trip_date_only_scheduling.sql), so a trip shown here is
    // never one the database would then reject at booking time.
    //
    // phDayRangeISO's `start` is PH midnight of "today" as an offset-
    // qualified ISO string. A bare "YYYY-MM-DD" string here would be read by
    // PostgREST as UTC midnight — 8 hours ahead of PH midnight — which would
    // wrongly exclude a trip scheduled for later TODAY (departure_date is
    // now stored as PH midnight, i.e. before that UTC cutoff) until 8am PH.
    const { start: todayStartPH } = phDayRangeISO(new Date().toISOString());
    query = query
      .in('status', ['scheduled'])
      .gte('departure_date', todayStartPH)
      .order('departure_date', { ascending: true }); // Earliest first
  } else {
    if (statusFilter) {
      query = query.eq('status', statusFilter);
    }
    // For admins seeing all trips, order newest created first
    query = query.order('created_at', { ascending: false });
  }

  const { data, error } = await query;
  if (error) throw error;

  const trips = data || [];
  if (trips.length === 0) return trips;

  // Ã¢â€â‚¬Ã¢â€â‚¬ Batch weight query (avoids N+1) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // get_trips_load (20260830000000_get_trips_load_rpc.sql) is a SECURITY
  // DEFINER RPC, not a direct `.from('orders')` select: RLS ("Users can view
  // own orders") only lets a customer read their own rows, so a direct query
  // here would sum only that one customer's cargo per trip and report every
  // trip as far emptier than it truly is. The RPC aggregates server-side
  // across ALL orders on the trip and returns just trip_id + total weight —
  // no per-order data.
  const tripIds = trips.map(t => t.id);
  if (tripIds.length > 0) {
    const { data: allWeightData, error: weightError } = await supabase
      .rpc('get_trips_load', { trip_ids: tripIds });
    if (weightError) throw weightError;

    const weightByTrip = new Map();
    for (const row of allWeightData || []) {
      weightByTrip.set(row.trip_id, parseFloat(row.current_weight || 0));
    }

    for (const trip of trips) {
      trip.current_weight = weightByTrip.get(trip.id) || 0;
    }
  } else {
    for (const trip of trips) {
      trip.current_weight = 0;
    }
  }

  return trips;
};
export const getTripById = async (tripId) => {
  const { data: trip, error } = await supabase
    .from('trips')
    .select('*')
    .eq('id', tripId)
    .single();
  if (error) throw error;

  const { data: orders } = await supabase
    .from('orders')
    // shipping_cost + amount_paid are what outstandingBalance() derives from —
    // the trip-completion guard reads that, not the stored remaining_balance,
    // so it agrees with the Unsettled tab. remaining_balance is still selected
    // for the settlement column's stale-value annotation.
    // user_id + the profiles embed back the "Message customer" shortcut on
    // each row. The trip's order table shows addresses, not the booker, so
    // without the embed there is no name to put on the control.
    .select('id, tracking_number, sender_name, receiver_name, user_id, status, actual_weight, sender_province, sender_city, receiver_province, receiver_city, created_at, shipping_cost, discount_amount, amount_paid, remaining_balance, payment_status, promised_payment_date, profiles:user_id (name)')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true });

  // Weight still comes from get_trips_load (see getTrips above), not a
  // reduce() over `orders`, even though this caller is admin-only today and
  // admin RLS already sees every row: keeping one aggregation path for all
  // three call sites means current_weight can never silently drift out of
  // sync with getTrips()/getTripCurrentWeight() if this function is ever
  // reused from a customer-facing page.
  const { data: loadData, error: loadError } = await supabase
    .rpc('get_trips_load', { trip_ids: [tripId] });
  if (loadError) throw loadError;
  const currentWeight = parseFloat(loadData?.[0]?.current_weight || 0);

  return { trip, orders: orders || [], current_weight: currentWeight };
};

// Starting a trip (updates.status === 'in_progress') does NOT need
// departure_at set here — guard_trip_status_transition() stamps it to the
// server's own now() the instant the status write lands, and overwrites
// anything a caller sent for it. That is the whole point: the actual
// departure instant is server-truth, never client-supplied.
export const updateTrip = async (tripId, updates) => {
  // Check for single in_progress constraint
  if (updates.status === 'in_progress') {
    const { data: existing } = await supabase
      .from('trips')
      .select('id, trip_number')
      .eq('status', 'in_progress')
      .neq('id', tripId);
    if (existing && existing.length > 0) {
      throw new Error(`Another trip (${existing[0].trip_number}) is already in progress.`);
    }
  }

  const { data, error } = await supabase
    .from('trips')
    .update(updates)
    .eq('id', tripId)
    .select()
    .single();
  if (error) throw error;

  // Status cascades, activity history, notifications, and durable delivery
  // jobs are committed atomically by the database trip trigger.
  return data;
};

/**
 * Reschedule a trip's dates through the `reschedule_trip` RPC, optionally
 * emailing the schedule change to every enabled Email Updates subscriber —
 * not just customers booked on this trip.
 *
 * "Genuine change" and the private/public email coordination both live in
 * the database (reschedule_trip + the trigger it coordinates with, see
 * 20260917100000_public_trip_reschedule_broadcast.sql): this function only
 * asks for the public broadcast when the RPC itself reports
 * `schedule_changed`, so an unchanged-dates save or a duplicate submit never
 * queues a second notice.
 *
 * The public broadcast reuses the exact same announcements +
 * broadcast-announcement pipeline createTrip() already uses for "announce
 * via email" on a new trip — same recipient source (email_subscriptions),
 * same durable job/idempotency machinery. Unlike createTrip's fire-and-forget
 * call, this one is awaited so the admin gets a truthful, synchronous
 * "email could not be completed" instead of a silent console warning — a
 * reschedule notice is worth failing loudly on, since the button explicitly
 * promised subscribers would be emailed.
 *
 * Returns `{ trip, scheduleChanged, announcementId, emailQueued, emailError }`.
 * `announcementId` (when set) can be passed to `retryAnnouncementBroadcast`
 * to retry a failed/partial send without touching the trip again.
 */
export const rescheduleTrip = async (tripId, {
  departure_date, arrival_date, notify_all_subscribers = false, public_reason = '',
}, tripContext) => {
  const { data: rpcResult, error: rpcError } = await supabase.rpc('reschedule_trip', {
    p_trip_id: tripId,
    p_departure_date: departure_date,
    p_arrival_date: arrival_date,
    p_notify_all_subscribers: notify_all_subscribers,
    p_public_reason: public_reason || null,
  });
  if (rpcError) throw rpcError;

  const trip = rpcResult.trip;
  const scheduleChanged = Boolean(rpcResult.schedule_changed);

  let announcementId = null;
  let emailQueued = false;
  let emailError = null;

  if (notify_all_subscribers && scheduleChanged) {
    const origin = tripContext?.origin || trip.origin;
    const destination = tripContext?.destination || trip.destination;
    const bookable = phDateKey(trip.departure_date) >= phDateKey(new Date().toISOString())
      && trip.status === 'scheduled';
    const reasonLine = rpcResult.public_reason ? `\nReason: ${rpcResult.public_reason}` : '';

    try {
      const { data: user } = await supabase.auth.getUser();
      const { data: announcement, error: insertError } = await supabase
        .from('announcements')
        .insert({
          title: `Schedule Update: ${origin} → ${destination}`,
          content: `The trip from ${origin} to ${destination} previously scheduled for `
            + `${formatPhDate(rpcResult.old_departure_date)} has a new schedule: `
            + `${formatPhDate(trip.departure_date)}${trip.arrival_date ? ` (arriving ${formatPhDate(trip.arrival_date)})` : ''}.`
            + `${reasonLine}`,
          send_email: true,
          cta_label: bookable ? 'Book This Trip' : 'View Updated Schedule',
          cta_url: 'https://cargoexpress-ph.online/schedules',
          author_id: user?.user?.id,
        })
        .select()
        .single();
      if (insertError) throw insertError;
      announcementId = announcement.id;

      const { error: broadcastError } = await supabase.functions.invoke('broadcast-announcement', {
        body: { announcement_id: announcementId },
      });
      if (broadcastError) throw broadcastError;
      emailQueued = true;
    } catch (err) {
      emailError = err?.message || 'Email notification could not be completed.';
    }
  }

  return { trip, scheduleChanged, announcementId, emailQueued, emailError };
};

/** Retry a previously-created reschedule (or any) announcement broadcast
 * without changing anything about the trip/announcement itself — safe to
 * call repeatedly, since already-accepted recipients are never re-sent
 * (see announcement_email_recipients' per-recipient idempotency). */
export const retryTripReschedulePublicNotice = (announcementId) =>
  retryAnnouncementBroadcast(announcementId);

export const deleteTrip = async (tripId) => {
  const { error } = await supabase
    .from('trips')
    .delete()
    .eq('id', tripId);
  if (error) {
    // trips.id is ON DELETE SET NULL, so deleting a trip tries to null the
    // trip_id of every order aboard — which orders_trip_required_for_active_status
    // now refuses for anything at 'Assigned' or beyond. The raw 23514 names a
    // constraint, not the problem.
    if (error.code === '23514' && /orders_trip_required_for_active_status/.test(error.message || '')) {
      throw new Error('This trip still has orders on it. Move them to another trip (or cancel them) before deleting it.');
    }
    throw error;
  }
};

export const reassignTrip = async (orderId, newTripId, reason) => {
  // Reassignment moves weight onto a trip exactly as a first assignment does,
  // so it answers to the same ceiling. It goes through the `reassign_trip` RPC
  // rather than updateOrder, which is why the check has to be repeated here —
  // without it, "move it to another trip" would be the way around the limit.
  if (newTripId) {
    const [{ data: trip }, { data: order }] = await Promise.all([
      supabase.from('trips').select('id, capacity').eq('id', newTripId).single(),
      supabase.from('orders').select('actual_weight').eq('id', orderId).single(),
    ]);
    if (trip) {
      await assertTripCapacity(trip, parseFloat(order?.actual_weight || 0) || 0, orderId);
    }
  }

  const { data, error } = await supabase.rpc('reassign_trip', {
    p_order_id: orderId,
    p_new_trip_id: newTripId,
    p_reason: reason
  });
  if (error) throw error;
  return data;
};

export const getTripReassignments = async (orderId) => {
  const { data, error } = await supabase
    .from('orders')
    .select('reassignment_history')
    .eq('id', orderId)
    .single();
  if (error) throw error;
  
  const history = data?.reassignment_history || [];
  
  // Hydrate trip numbers and admin names manually since it's JSONB
  // Or just rely on the UI to display raw data for now (or update RPC to store names)
  return history;
};

// ==================== ANNOUNCEMENTS ====================
/**
 * Announcements are news, and news expires. Anything past this window stops
 * being served — a schedule change from four months ago is not information,
 * it is clutter that pushes the current notice down the page.
 */
export const ANNOUNCEMENT_MAX_AGE_DAYS = 60;

/**
 * The live announcements: active, and posted within the last 60 days.
 *
 * The cutoff is applied here rather than at each call site because both
 * Customer surfaces request only `public` rows. The admin Announcements page
 * also requests `email_only` rows so a trip-email broadcast remains observable
 * and retryable without showing it in the customer feed or notifying twice.
 * Both surfaces share the same age window. Nothing is deleted; old rows simply
 * stop being served.
 */
export const getAnnouncements = async ({ includeEmailOnly = false } = {}) => {
  const cutoff = new Date(Date.now() - ANNOUNCEMENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from('announcements')
    .select(`*, profiles:author_id (name), email_broadcast:announcement_email_broadcasts (
      status, total_recipients, accepted_count, skipped_count,
      retryable_count, failed_count, needs_review_count, completed_at
    )`)
    .eq('is_active', true)
    .gte('created_at', cutoff);

  // Customer surfaces only request public announcements. The admin page opts
  // into email-only records so delivery status and retry controls stay usable.
  if (!includeEmailOnly) query = query.eq('audience', 'public');

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

/**
 * One announcement by id, for the detail modal an announcement notification
 * opens.
 *
 * Deliberately NOT filtered by is_active or by the 60-day window. Those two
 * rules govern what gets *pushed* at a customer; this is a customer opening a
 * specific notification they still hold, and answering "that announcement is
 * too old to show you" when they are looking straight at the notification for
 * it would be nonsense. Returns null when the row is genuinely gone, which the
 * caller renders from the notification's own title and message instead.
 */
export const getAnnouncementById = async (id) => {
  if (!id) return null;
  const { data, error } = await supabase
    .from('announcements')
    .select(`*, profiles:author_id (name)`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

export const createAnnouncement = async (announcement) => {
  const { data: user } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('announcements')
    .insert({ ...announcement, author_id: user?.user?.id })
    .select()
    .single();
  if (error) throw error;

  // Customer notifications and their push outbox jobs are created atomically
  // by the announcement INSERT trigger.

  // Ã¢â€â‚¬Ã¢â€â‚¬ Non-blocking email broadcast Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Same reasoning as the push fan-out above: emailing every opted-in
  // subscriber can take a while. The durable worker records recipient state;
  // this initial call can return in the background and admins can resume any
  // unfinished recipients from the announcement status.
  // The Edge Function re-checks the caller is an admin itself — it does not
  // trust `send_email` alone as authorization.
  if (announcement.send_email) {
    void supabase.functions.invoke('broadcast-announcement', {
      body: { announcement_id: data.id },
    }).then(({ error: broadcastError }) => {
      if (broadcastError) {
        console.warn('[broadcast-announcement] send failed:', broadcastError.message);
      }
    });
  }

  return data;
};

export const retryAnnouncementBroadcast = async (announcementId) => {
  const { data, error } = await supabase.functions.invoke('broadcast-announcement', {
    body: { announcement_id: announcementId },
  });
  if (error) throw error;
  return data;
};

/**
 * Post a comment on an announcement.
 *
 * Customers hold SELECT on `announcements` and nothing else, so this cannot be
 * an UPDATE from here — `add_announcement_comment` is SECURITY DEFINER and
 * derives the author from the JWT rather than from anything we send. We pass
 * the text and nothing else on purpose: a client-supplied name or id would be
 * a client-supplied identity.
 *
 * Returns the announcement's FULL comment array as the database now holds it,
 * not just the new comment, so a caller can render the thread including
 * whatever else landed while this one was in flight.
 */
export const addAnnouncementComment = async (announcementId, text) => {
  const { data, error } = await withTimeout(
    supabase.rpc('add_announcement_comment', {
      p_announcement_id: announcementId,
      p_text: text,
    })
  );
  if (error) throw error;
  return data || [];
};

export const deleteAnnouncement = async (id) => {
  const { error } = await supabase
    .from('announcements')
    .update({ is_active: false })
    .eq('id', id);
  if (error) throw error;
};

// ==================== NOTIFICATIONS ====================
/**
 * A page of the user's notifications, newest first.
 *
 * `offset` is safe to derive from the length of what the caller already holds,
 * because the loaded list is always a PREFIX of this ordering: realtime
 * arrivals are newer than everything on screen so they land at the head, and a
 * delete removes the row from both sides. Nothing is ever inserted into the
 * middle, so "how many do I have" and "where does the next page start" are the
 * same number.
 *
 * The `id` tiebreak is what makes that true. `created_at` is not unique: a trip
 * status change cascades to every order on the trip inside ONE transaction, and
 * now() is the transaction timestamp — so a customer with two parcels on the
 * same trip gets two notifications stamped identically to the microsecond.
 * Ordering by `created_at` alone leaves their relative order up to the planner,
 * which may return them in a different order on the next query and step over
 * one at a page boundary.
 *
 * The default limit of 50 preserves the original unpaginated behaviour for
 * callers that just want "the recent ones".
 */
export const getNotifications = async (userId, { limit = 50, offset = 0 } = {}) => {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
};

export const markNotificationRead = async (id) => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', id);
  if (error) throw error;
  emitNotificationsChanged();
};

export const markAllNotificationsRead = async (userId) => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) throw error;
  emitNotificationsChanged();
};

export const deleteNotification = async (id) => {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', id);
  if (error) throw error;
  emitNotificationsChanged();
};

export const deleteAllNotifications = async (userId) => {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId);
  if (error) throw error;
  emitNotificationsChanged();
};

export const getUnreadNotificationCount = async (userId) => {
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) throw error;
  return count || 0;
};

// ==================== CUSTOMERS (Admin) ====================
/**
 * Fetch the paginated Admin customer directory. Booking totals, outstanding
 * balance, latest booking and status are aggregated inside Postgres so the
 * page never issues one orders query per customer.
 * @param {Object} options - { page, perPage, search, statusFilter, province, sort }
 * @returns {{ data: Array, count: number }}
 */
export const getCustomers = async (options = {}) => {
  const {
    page = 1,
    perPage = 15,
    search = '',
    statusFilter = 'all',
    province = '',
    sort = 'newest',
  } = options;

  const { data, error } = await supabase.rpc('get_admin_customers', {
    p_page: page,
    p_per_page: perPage,
    p_search: search.trim(),
    p_status_filter: statusFilter,
    p_province: province || null,
    p_sort: sort,
  });
  if (error) throw error;
  const rows = data || [];
  return {
    data: rows.map(({ total_count: _totalCount, ...customer }) => customer),
    count: Number(rows[0]?.total_count || 0),
  };
};

export const getCustomerProvinces = async () => {
  const { data, error } = await supabase.rpc('get_admin_customer_provinces');
  if (error) throw error;
  return (data || []).map(row => row.province).filter(Boolean);
};

export const getCustomerById = async (customerId) => {
  const { data: customer, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', customerId)
    .eq('role', 'customer')
    .single();
  if (error) throw error;

  const { data: orders } = await supabase
    .from('orders')
    .select(`*, trips:trip_id (trip_number)`)
    .eq('user_id', customerId)
    .order('created_at', { ascending: false });

  const totalOrders = orders?.length || 0;
  const completedOrders = orders?.filter(o => o.status === 'Delivered').length || 0;
  const pendingOrders = orders?.filter(o => o.status === 'Pending').length || 0;
  const totalSpent = orders?.filter(o => o.status !== 'Cancelled')
    .reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0) || 0;

  return {
    customer,
    orders: orders || [],
    summary: { totalOrders, completedOrders, pendingOrders, totalSpent },
  };
};

// ==================== DASHBOARD STATS ====================
export const getDashboardStats = async () => {
  // Ã¢â€â‚¬Ã¢â€â‚¬ Run all count queries in parallel with Promise.allSettled Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // allSettled (not Promise.all) means one slow/failed query doesn't block the
  // others. Each count gracefully falls back to 0 if its query fails.
  const [
    totalOrdersResult,
    pendingOrdersResult,
    activeTripsResult,
    totalCustomersResult,
    inTransitResult,
    pickedUpResult,
    deliveredOrdersResult,
    recentOrdersResult,
  ] = await Promise.allSettled([
    supabase.from('orders').select('*', { count: 'exact', head: true }),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'Pending'),
    supabase.from('trips').select('*', { count: 'exact', head: true }).in('status', ['scheduled', 'in_progress']),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'customer'),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'In Transit'),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'Picked Up'),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'Delivered'),
    supabase
      .from('orders')
      .select('id, tracking_number, status, created_at, profiles:user_id (name)')
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const safeCount = (result) =>
    result.status === 'fulfilled' ? (result.value?.count || 0) : 0;

  return {
    stats: {
      totalOrders:    safeCount(totalOrdersResult),
      pendingOrders:  safeCount(pendingOrdersResult),
      activeTrips:    safeCount(activeTripsResult),
      totalCustomers: safeCount(totalCustomersResult),
      inTransit:      safeCount(inTransitResult),
      pickedUp:       safeCount(pickedUpResult),
      delivered:      safeCount(deliveredOrdersResult),
    },
    recentOrders:
      recentOrdersResult.status === 'fulfilled'
        ? recentOrdersResult.value?.data || []
        : [],
  };
};

// ==================== VAN CAPACITY ====================
export const getVanCapacity = async () => {
  const { data: activeTrips } = await supabase
    .from('trips')
    .select('id, trip_number, origin, destination, capacity')
    .eq('status', 'in_progress')
    .limit(1);

  const activeTrip = activeTrips?.[0] || null;

  let totalWeight = 0;
  if (activeTrip) {
    const { data: orders } = await supabase
      .from('orders')
      .select('actual_weight')
      .eq('trip_id', activeTrip.id)
      .neq('status', 'Cancelled');

    totalWeight = (orders || []).reduce((sum, o) =>
      sum + parseFloat(o.actual_weight || 0), 0);
  }

  const maxCapacity = activeTrip?.capacity > 0 ? activeTrip.capacity : 1000;

  return { totalWeight, maxCapacity, activeTrip };
};

// ==================== SALES DATA ====================
export const getSalesData = async () => {
  const { data: rpcData, error: rpcError } = await supabase.rpc('get_sales_summary');
  if (!rpcError && rpcData) {
    return {
      summary: rpcData.summary || {},
      monthlySales: rpcData.monthlySales || [],
      unpaidOrders: rpcData.unpaidOrders || [],
    };
  }

  const { data: allOrders } = await supabase
    .from('orders')
    .select('id, tracking_number, created_at, status, shipping_cost, discount_amount, payment_method, amount_paid, remaining_balance, payment_status')
    .neq('status', 'Cancelled');

  const orders = allOrders || [];
  // Revenue is what was billed, NET of any discount — matches
  // get_sales_summary() so the fallback and the RPC do not report different
  // numbers for the same tile. paidTotal is what was actually collected,
  // which a discount never touches (it is a pure ledger sum).
  const totalRevenue = orders.reduce((sum, o) => sum + finalShippingFee(o), 0);
  const totalDiscounts = orders.reduce((sum, o) => sum + (parseFloat(o.discount_amount || 0) || 0), 0);
  const paidTotal = orders.reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0);

  // Collections are split by the LEDGER's payment_method, not the order's —
  // orders.payment_method only records the most recent payment event, so an
  // order picked up on GCash and settled in cash would file both payments
  // under cash. Mirrors get_sales_summary(); see 20260806020000.
  const orderIds = orders.map(o => o.id);
  const { methodTotals, ledgerTotal, grossLedgerTotal, refundTotal, refundCount } = await sumTransactionsByMethod(orderIds);
  const cashTotal = methodTotals.cash || 0;
  const gcashTotal = methodTotals.gcash || 0;
  const paylaterTotal = methodTotals.paylater || 0;
  // ONE definition of "outstanding", derived — never the stored
  // remaining_balance column, which can lag a ledger write. Reported at two
  // NAMED scopes so the Sales tab and the Unsettled tab can be reconciled
  // instead of quietly disagreeing. Mirrors get_sales_summary().
  const outstandingOf = outstandingBalance;
  const trackedOrders = orders.filter(o => SETTLEMENT_TRACKED_STATUSES.includes(o.status));

  const outstandingAllOrders = orders.reduce((sum, o) => sum + outstandingOf(o), 0);
  const outstandingTotal = trackedOrders.reduce((sum, o) => sum + outstandingOf(o), 0);
  const outstandingStored = trackedOrders.reduce((sum, o) => sum + parseFloat(o.remaining_balance || 0), 0);
  const unpaidOrders = trackedOrders
    .filter(o => outstandingOf(o) > 0.005)
    .map(o => ({ ...o, remaining_balance: outstandingOf(o) }));
  const unpricedCount = orders.filter(o => !(parseFloat(o.actual_weight || 0) > 0)).length;

  // Monthly breakdown
  const monthlyMap = {};
  orders.forEach(o => {
    const month = o.created_at?.substring(0, 7);
    if (!month) return;
    if (!monthlyMap[month]) monthlyMap[month] = { month, total_revenue: 0, collected: 0, outstanding: 0 };
    monthlyMap[month].total_revenue += finalShippingFee(o);
    monthlyMap[month].collected += parseFloat(o.amount_paid || 0);
    monthlyMap[month].outstanding += outstandingOf(o);
  });
  const monthlySales = Object.values(monthlyMap).sort((a, b) => b.month.localeCompare(a.month));

  return {
    summary: {
      totalRevenue,
      totalDiscounts,
      cashTotal,
      gcashTotal,
      paylaterTotal,
      methodTotals: Object.entries(methodTotals).map(([method, total]) => ({ method, total })),
      ledgerTotal,
      grossLedgerTotal,
      refundTotal,
      refundCount,
      grossCollected: paidTotal + refundTotal,
      netCollected: paidTotal,
      // Collected money with no ledger row behind it (pre-ledger orders).
      // Reported, not folded into Cash.
      unattributedTotal: Math.max(paidTotal - ledgerTotal, 0),
      paidTotal,
      outstandingTotal,
      outstandingAllOrders,
      outstandingStored,
      // Legacy alias, kept so a stale bundle mid-deploy still renders.
      unpaidTotal: outstandingAllOrders,
      unpaidCount: unpaidOrders.length,
      unpricedCount,
    },
    monthlySales,
    unpaidOrders,
  };
};

/**
 * Sum payment_transactions for the given orders, grouped by the transaction's
 * own payment_method. Chunked because the id list goes into a URL `in.()`
 * filter, and an all-time sales query can carry thousands of order ids.
 *
 * Only 'paid'/'partial' rows are counted — the same predicate
 * update_order_payment_totals uses to derive orders.amount_paid, so the split
 * reconciles against the total instead of drifting from it.
 *
 * @returns {Promise<{ methodTotals: Record<string, number>, ledgerTotal: number, grossLedgerTotal: number, refundTotal: number, refundCount: number, methodCounts: Record<string, number> }>}
 */
const sumTransactionsByMethod = async (orderIds) => {
  const methodTotals = {};
  const methodCounts = {};
  let ledgerTotal = 0;
  let grossLedgerTotal = 0;
  let refundTotal = 0;
  let refundCount = 0;
  if (!orderIds || orderIds.length === 0) {
    return { methodTotals, ledgerTotal, grossLedgerTotal, refundTotal, refundCount, methodCounts };
  }

  const CHUNK = 100;
  const fetchHistoryPages = async (rpc, ids) => {
    const rows = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .rpc(rpc, { p_order_ids: ids })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  };
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const ids = orderIds.slice(i, i + CHUNK);
    const [paymentRows, refundRows] = await Promise.all([
      fetchHistoryPages('get_payment_transaction_history', ids),
      fetchHistoryPages('get_payment_refund_history', ids),
    ]);
    const payments = paymentRows.filter(payment => ['paid', 'partial'].includes(payment.payment_status));
    const refunds = refundRows.filter(refund => refund.status === 'succeeded');

    const methodByPayment = new Map();

    (payments || []).forEach(t => {
      const method = (t.payment_method || '').trim().toLowerCase() || 'unspecified';
      const amount = parseFloat(t.amount || 0);
      methodByPayment.set(t.id, method);
      methodTotals[method] = (methodTotals[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      ledgerTotal += amount;
      grossLedgerTotal += amount;
    });

    (refunds || []).forEach(refund => {
      const method = methodByPayment.get(refund.payment_transaction_id) || 'unspecified';
      const amount = parseFloat(refund.amount || 0);
      methodTotals[method] = (methodTotals[method] || 0) - amount;
      ledgerTotal -= amount;
      refundTotal += amount;
      refundCount += 1;
    });
  }

  return { methodTotals, ledgerTotal, grossLedgerTotal, refundTotal, refundCount, methodCounts };
};

// ==================== UNSETTLED DELIVERIES ====================

/**
 * Settlement buckets — why an order still owes money, in the operational
 * sense the admin acts on. Derived from the same three columns the Phase 1b
 * guards read (status, payer_type, promised_payment_date), so what this list
 * shows and what the database will refuse to dispatch cannot drift apart.
 */
export const SETTLEMENT_BUCKETS = {
  HELD: 'held',              // Arrived at Hub, prepaid, no promise → dispatch BLOCKED by guard_order_update
  OVERDUE: 'overdue',        // A promise date that has already passed
  PROMISED: 'promised',      // Dispatched on a promise that is still in the future
  DELIVERED: 'delivered',    // Cargo handed over, balance still owing
  COLLECT: 'collect',        // Freight collect, in flight — due at the door, not late
  IN_FLIGHT: 'in_flight',    // Prepaid, still moving, not yet at the dispatch gate
};

/**
 * Order statuses that can carry a receivable. A booking that has not been
 * picked up yet has a placeholder balance, not money owed.
 */
export const SETTLEMENT_TRACKED_STATUSES = [
  'Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered',
];

/**
 * Classifies one order into a settlement bucket.
 * `today` is passed in so a whole list is classified against one instant.
 */
const classifySettlement = (order, today) => {
  const promisedKey = order.promised_payment_date ? phDateKey(order.promised_payment_date) : '';
  const todayKey = phDateKey(today);
  const isOverdue = Boolean(promisedKey && todayKey && promisedKey < todayKey);
  const isCollect = (order.payer_type || 'sender') === 'receiver';

  if (isOverdue) return SETTLEMENT_BUCKETS.OVERDUE;
  if (order.status === 'Delivered') return SETTLEMENT_BUCKETS.DELIVERED;
  if (promisedKey) return SETTLEMENT_BUCKETS.PROMISED;
  if (order.status === 'Arrived at Hub' && !isCollect) return SETTLEMENT_BUCKETS.HELD;
  if (isCollect) return SETTLEMENT_BUCKETS.COLLECT;
  return SETTLEMENT_BUCKETS.IN_FLIGHT;
};

/**
 * Every non-cancelled order that still owes money, for the admin settlement
 * list. Admin-only by RLS (`orders` grants admins full read); no widened
 * anon access and no new RPC needed.
 *
 * Only orders that have actually been picked up are included — a booking that
 * has not been weighed yet has a placeholder balance, not a receivable.
 *
 * WHAT COUNTS AS OWING (widened 2026-08-04):
 *   outstanding = MAX(0, shipping_cost - amount_paid)
 *
 * `remaining_balance` is not used as the filter. It is trigger-derived and
 * correct on every row the current triggers have touched, but legacy rows
 * predating them can carry NULL — and `.gt('remaining_balance', 0)` drops
 * NULLs silently, hiding genuinely unpaid old cargo. Deriving the figure from
 * the two columns that are always populated catches those rows.
 *
 * PostgREST cannot compare two columns in a filter, so the arithmetic happens
 * here and the query narrows by status only.
 *
 * Rows where the stored and derived figures disagree are flagged
 * `balance_mismatch` — that is a stale ledger total worth a human look, not
 * something to paper over.
 *
 * @returns {{orders: Array, totals: Object}} orders carry `settlement_bucket`,
 *          `outstanding`, `balance_mismatch` and `days_overdue`; totals are
 *          computed over the same rows.
 */
export const getUnsettledOrders = async () => {
  const { data, error } = await supabase
    .from('orders')
    // sender_phone backs the PayMongo billing block in AdditionalPaymentModal.
    .select('id, tracking_number, sender_name, sender_phone, receiver_name, user_id, status, payment_status, payment_method, payer_type, promised_payment_date, shipping_cost, discount_amount, amount_paid, remaining_balance, actual_weight, origin, destination, created_at, trip_id, profiles:user_id (name, phone, email)')
    .neq('status', 'Cancelled')
    .in('status', SETTLEMENT_TRACKED_STATUSES)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const orders = (data || [])
    .map(o => ({ ...o, ...deriveSettlement(o) }))
    .filter(o => o.outstanding > 0);

  return { orders, totals: summarizeSettlements(orders) };
};

/**
 * Derives the settlement fields for ONE order row.
 *
 * Shared by the full fetch above and by the realtime patch path in
 * UnsettledDeliveriesPage. Realtime hands us a raw `orders` row from the
 * WebSocket, and it must be classified by exactly the same rules as a row
 * that arrived through the query — otherwise a payment that lands while the
 * admin is watching would render differently from the same payment after a
 * refresh.
 *
 * @param {Object} order  raw orders row
 * @param {Date}   [today] midnight reference; pass one instant for a whole list
 * @returns {{outstanding: number, balance_mismatch: boolean,
 *            settlement_bucket: string, days_overdue: number}}
 */
export const deriveSettlement = (order, today = null) => {
  const ref = today || new Date();

  // Shared with the dispatch gate, the admin badges and get_sales_summary() —
  // one implementation of "what is owed", so no two views can disagree.
  const outstanding = outstandingBalance(order);
  const stored = order.remaining_balance == null ? null : parseFloat(order.remaining_balance);

  let daysOverdue = 0;
  if (order.promised_payment_date) {
    const promisedKey = phDateKey(order.promised_payment_date);
    const todayKey = phDateKey(ref);
    if (promisedKey && todayKey && promisedKey < todayKey) {
      const promisedUtc = Date.parse(`${promisedKey}T00:00:00Z`);
      const todayUtc = Date.parse(`${todayKey}T00:00:00Z`);
      daysOverdue = Math.floor((todayUtc - promisedUtc) / 86400000);
    }
  }

  return {
    outstanding,
    // NULL is the legacy case the widening exists for — not a mismatch to
    // report, just an absent figure the derived one stands in for.
    balance_mismatch: stored != null && Math.abs(stored - outstanding) > 0.01,
    settlement_bucket: classifySettlement(order, ref),
    days_overdue: daysOverdue,
  };
};

/**
 * Recomputes the summary tiles from a list of already-derived orders.
 * Kept next to deriveSettlement so a realtime patch and a full reload
 * produce identical totals.
 */
export const summarizeSettlements = (orders = []) => ({
  count: orders.length,
  outstanding: orders.reduce((sum, o) => sum + o.outstanding, 0),
  held: orders.filter(o => o.settlement_bucket === SETTLEMENT_BUCKETS.HELD).length,
  overdue: orders.filter(o => o.settlement_bucket === SETTLEMENT_BUCKETS.OVERDUE).length,
  mismatched: orders.filter(o => o.balance_mismatch).length,
  overdueAmount: orders
    .filter(o => o.settlement_bucket === SETTLEMENT_BUCKETS.OVERDUE)
    .reduce((sum, o) => sum + o.outstanding, 0),
  delivered: orders.filter(o => o.settlement_bucket === SETTLEMENT_BUCKETS.DELIVERED).length,
});

/**
 * Is this raw orders row one the settlement list should be showing?
 * Used by the realtime path to decide whether an incoming row belongs in the
 * list at all before any patching happens.
 */
export const qualifiesAsUnsettled = (order) => {
  if (!order || order.status === 'Cancelled') return false;
  if (!SETTLEMENT_TRACKED_STATUSES.includes(order.status)) return false;
  return outstandingBalance(order) > 0.005;
};

// ==================== SETTINGS ====================
export const getSettings = async () => {
  const { data, error } = await supabase
    .from('company_information')
    .select('default_price_per_kg')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single();

  if (error && error.code !== 'PGRST116') throw error; // Ignore not found if running pre-migration

  return {
    price_per_kilo: data?.default_price_per_kg?.toString() || '70'
  };
};

export const updateSettings = async (key, value) => {
  const dbKey = key === 'price_per_kilo' ? 'default_price_per_kg' : key;
  const { error } = await supabase
    .from('company_information')
    .update({ [dbKey]: value })
    .eq('id', '00000000-0000-0000-0000-000000000001');
  if (error) throw error;
};

// ==================== NOTIFICATIONS HELPER ====================
// Not used for order, trip, booking, announcement, feedback, chat or payment
// events — every one of those is now written by a database trigger in the same
// transaction as the change it describes. Calling this from a page again would
// duplicate the trigger's row, and would go back to losing the notice whenever
// the tab closes between the write and this second round trip.
export const createNotification = async (userId, title, message, type = 'general', referenceId = null) => {
  let notificationId = null;

  try {
    const { data: insertedNotification, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title,
        message,
        type,
        reference_id: referenceId,
      })
      .select('id')
      .single();
    notificationId = insertedNotification?.id || null;
    // Insert error is non-critical — the ledger/order write that spawned this
    // notification has already succeeded, and a failed notice must not roll
    // the user's action back.
  } catch {
    // Network-level failure is non-critical for the same reason. Every caller
    // AWAITS this function before closing a modal or finishing a cascade, so
    // a rejected fetch here would block the pickup/delivery/status operation
    // for a notice nobody is waiting on.
  }

  return notificationId;
};

export const createAdminNotification = async (title, message, type = 'general', referenceId = null) => {
  const { data, error } = await supabase.rpc('create_admin_notifications_rpc', {
    p_title: title,
    p_message: message,
    p_type: type,
    p_reference_id: referenceId
  });
  if (error) throw error;
  return data || [];
};

// ==================== CONTACT INQUIRIES ====================
/**
 * Submit a public contact inquiry.
 *
 * @param {Object} data
 * @param {string} data.name
 * @param {string} data.message
 * @param {string} [data.contact_phone] — mobile number, if supplied
 * @param {string} [data.contact_email] — email address, if supplied
 * @param {boolean} [data.wants_announcements] — opted in to trip/promo/announcement emails
 *
 * Writes the normalized contact_phone/contact_email columns and, for this
 * release only, keeps the legacy polymorphic `phone` column in sync so a
 * rollback loses nothing. `phone` is deprecated — see
 * 20260803140000_contact_inquiries_normalize.sql.
 */
export const createContactInquiry = async (data) => {
  // Edge Function is the only production path - it captures IP server-side
  // for per-IP limiting (guard_contact_inquiry_rate_limit). There is no
  // INSERT policy for anon/authenticated at all as of 20260829150000 (RLS's
  // default-deny does the work), so a direct insert isn't degraded, it's
  // impossible - this fetch is the only way in. Use native fetch so 429
  // bodies like {"error":"Too many inquiries..."} surface correctly instead
  // of being wrapped as "Edge Function returned a non-2xx status code".
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) throw new Error('Contact service not configured.')
  const payload = {
    name: data.name,
    message: data.message,
    contact_phone: data.contact_phone || null,
    contact_email: data.contact_email || null,
    wants_announcements: data.wants_announcements === true,
    phone: [data.contact_phone, data.contact_email].filter(Boolean).join(' | ')?.slice(0, 100) || null,
  }
  let res
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/submit-inquiry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    const msg = e?.message || ''
    if (
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError') ||
      msg.includes('Network offline') ||
      msg.includes('Failed to send a request')
    ) {
      throw new Error('Contact service temporarily unavailable. Please try again in a moment.')
    }
    throw new Error(msg || 'Could not send your message right now. Please try again.')
  }
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (res.ok && body?.success) return
  // Edge returns {error: "..."} for 400/429 with user-friendly rate-limit text
  if (body?.error) throw new Error(body.error)
  if (!res.ok) throw new Error(`Request failed (${res.status}). Please try again.`)
  throw new Error('Could not send your message right now. Please try again.')
};

// ── Announcement email unsubscribe (public, no auth — /unsubscribe page) ──
// The Edge Function is JSON-only (see supabase/functions/unsubscribe-
// announcements): a GET+check=1 only reads the current preference, a POST
// is the one and only action that actually flips it. Both calls carry the
// same signed email+token pair the link was issued with; the server
// re-validates that signature itself, so a caller cannot unsubscribe an
// address it wasn't given a valid token for.
const unsubscribeEndpoint = (email, token, extraParams = '') => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  if (!supabaseUrl) throw new Error('Service not configured.')
  return `${supabaseUrl}/functions/v1/unsubscribe-announcements?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}${extraParams}`
}

const parseUnsubscribeNetworkError = (e) => {
  const msg = e?.message || ''
  if (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('Network offline') ||
    msg.includes('Failed to send a request')
  ) {
    return new Error('Could not reach the server. Check your connection and try again.')
  }
  return new Error(msg || 'Something went wrong. Please try again.');
}

/**
 * Read-only status check — never changes the saved preference. Returns
 * { valid, alreadyUnsubscribed, email } or throws with a user-facing message.
 */
export const checkUnsubscribeStatus = async ({ email, token }) => {
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  let res
  try {
    res = await fetch(unsubscribeEndpoint(email, token, '&check=1'), {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    })
  } catch (e) {
    throw parseUnsubscribeNetworkError(e)
  }
  let body = null
  try { body = await res.json() } catch { body = null }
  if (res.ok && body?.valid) return body
  const reason = body?.reason || 'server_error'
  throw new Error(reason)
};

/**
 * The one and only action that actually disables announcement emails for
 * this address. Only ever called from an explicit user click (the page's
 * "Unsubscribe" button) — never on page load — so a link preview or
 * security-scanner prefetch of the /unsubscribe page can never trigger this.
 */
export const confirmUnsubscribe = async ({ email, token }) => {
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  let res
  try {
    res = await fetch(unsubscribeEndpoint(email, token), {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    })
  } catch (e) {
    throw parseUnsubscribeNetworkError(e)
  }
  let body = null
  try { body = await res.json() } catch { body = null }
  if (res.ok && body?.success) return body
  const reason = body?.reason || 'server_error'
  throw new Error(reason)
};

/**
 * Contact inquiries, each annotated with `email_subscription` — the
 * authoritative "Email Updates" preference for that inquiry's email address
 * (from `email_subscriptions`, not the inquiry's own `wants_announcements`
 * snapshot, which is just a historical record of what was checked on that
 * particular submission and is never rewritten after the fact).
 *
 * `email_subscription` is `null` when no preference has ever been recorded
 * for that address (never checked the box, never toggled anywhere) — this
 * is a distinct third state from an explicit "disabled", and the admin UI
 * should render it differently (e.g. "Not set" vs. "Off").
 *
 * A second query rather than a join: contact_inquiries.contact_email is a
 * plain text column, not a foreign key into email_subscriptions (which is
 * keyed by every possible email address, most of which have no inquiry at
 * all), so there's no relationship for PostgREST to embed.
 */
export const getContactInquiries = async () => {
  const { data, error } = await supabase
    .from('contact_inquiries')
    .select('*, assigned_admin:assigned_admin_id (name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  const inquiries = data || [];

  const emails = Array.from(new Set(
    inquiries
      .map(i => (i.contact_email || '').trim().toLowerCase())
      .filter(Boolean)
  ));
  if (emails.length === 0) return inquiries;

  const { data: subs, error: subsError } = await supabase
    .from('email_subscriptions')
    .select('email, subscribed, updated_at')
    .in('email', emails);
  // A failed lookup should not hide the inquiry list itself — just fall back
  // to "unknown" preference for every row rather than throwing.
  if (subsError) return inquiries.map(i => ({ ...i, email_subscription: null }));

  const byEmail = new Map((subs || []).map(s => [s.email, s]));
  return inquiries.map(i => {
    const email = (i.contact_email || '').trim().toLowerCase();
    const sub = email ? byEmail.get(email) : undefined;
    return {
      ...i,
      email_subscription: sub ? { subscribed: sub.subscribed, updatedAt: sub.updated_at } : null,
    };
  });
};

/**
 * Admin enable/disable of the "Email Updates" preference for an inquiry's
 * email address. Admin identity and the change timestamp are derived
 * server-side by the RPC — never passed from here.
 */
export const adminSetEmailSubscription = async (email, subscribed) => {
  const { data, error } = await supabase.rpc('admin_set_email_subscription', {
    p_email: email,
    p_subscribed: subscribed,
  });
  if (error) throw error;
  // The RPC returns the email_subscriptions row directly (a single
  // composite value, not a set), so PostgREST hands it back as one object.
  return data || null;
};

/**
 * Claim an inquiry. Ownership is the whole point of Phase 1d: without it
 * nobody is answerable, and two admins can answer the same person.
 * `first_response_at` is stamped by trigger on the status change, not here.
 *
 * `.is('assigned_admin_id', null)` is the actual enforcement, not the UI that
 * calls this. Without it, two admins opening the same unclaimed inquiry
 * within the same round trip both "succeed" and whoever's write lands last
 * silently steals the other's claim — the exact failure this feature exists
 * to prevent. The `.select().maybeSingle()` afterward is how the caller can
 * tell "I got it" from "someone beat me to it": an unconditional `.update()`
 * reports no error either way, since matching zero rows isn't a failure to
 * PostgREST.
 */
export const assignInquiry = async (inquiryId) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data, error } = await supabase
    .from('contact_inquiries')
    .update({ assigned_admin_id: user.id })
    .eq('id', inquiryId)
    .is('assigned_admin_id', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error('This inquiry was just claimed by another admin. Refresh to see who has it.');
  }
};

/**
 * Release an inquiry back to the unclaimed pool.
 *
 * Guarded to the caller's own claim for the same reason assignInquiry guards
 * the empty case: an admin should never be able to release (or, via the same
 * unconditional write, silently no-op over) a claim that belongs to someone
 * else.
 */
export const unassignInquiry = async (inquiryId) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data, error } = await supabase
    .from('contact_inquiries')
    .update({ assigned_admin_id: null })
    .eq('id', inquiryId)
    .eq('assigned_admin_id', user.id)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error('This inquiry is not currently assigned to you.');
  }
};

// Setting status: 'resolved' is claim-gated server-side --
// guard_contact_inquiry_resolve_ownership (BEFORE UPDATE OF status trigger)
// rejects the write unless assigned_admin_id already equals the caller.
// ContactInquiriesPage checks this client-side first for a clean message;
// the trigger is what actually stops it, e.g. a race where someone else
// claims it between page load and this call.
export const updateContactInquiry = async (id, updates) => {
  const { error } = await supabase
    .from('contact_inquiries')
    .update(updates)
    .eq('id', id);
  if (error) throw error;
};

// ==================== PAYMENT RECONCILIATION ====================
export const createPaymentAttempt = async (attempt) => {
  const { data, error } = await supabase
    .from('payment_attempts')
    .upsert({
      source_id: attempt.source_id,
      order_id: attempt.order_id,
      amount: attempt.amount,
      description: attempt.description || null,
      actual_weight: attempt.actual_weight ?? null,
      // Omission means "preserve the order" during reconciliation. Defaulting
      // to sender here could silently convert a Freight Collect order.
      payer_type: attempt.payer_type ?? null,
      pickup_photos: attempt.pickup_photos ?? null,
      payment_type: attempt.payment_type || 'full',
      estimated_cost: attempt.estimated_cost ?? null,
      promised_payment_date: attempt.promised_payment_date || null,
      status: 'pending',
      last_error: null,
    }, { onConflict: 'source_id' })
    .select('id, source_id, status')
    .single();
  if (error) throw error;
  return data;
};

/** Latest PayMongo attempt for an order — the source the return path should poll. */
export const getLatestPaymentAttemptByOrder = async (orderId) => {
  const { data, error } = await supabase
    .from('payment_attempts')
    .select('id, source_id, status, amount')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
};

// ==================== CHAT SUPPORT ====================
export const getOrCreateConversation = async (customerId) => {
  // Try to find existing — use .limit(1) instead of .single() to avoid
  // PGRST116 errors when multiple rows exist (no unique constraint on
  // customer_id). .single() fails when 0 OR 2+ rows match, which caused
  // the snowballing duplicate-conversation bug.
  let { data: convRows, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true })
    .limit(1);
    
  if (error) throw error;
  
  let conv = convRows && convRows.length > 0 ? convRows[0] : null;
  
  // If not exists, create with status='bot_active' so the chatbot becomes the
  // first responder. It moves to 'waiting' only when the customer escalates.
  //
  // This used to insert 'closed' — the same value an admin wrote when they
  // FINISHED a conversation. One value meaning both "never needed a human"
  // and "a human is done" is why "nobody has replied yet" was unrepresentable.
  // See 20260804210000_conversation_service_state.sql.
  if (!conv) {
    const { data: newConv, error: createError } = await supabase
      .from('conversations')
      .insert({ customer_id: customerId, status: 'bot_active' })
      .select()
      .single();
    if (createError) throw createError;
    conv = newConv;
  }
  return conv;
};


/**
 * Conversation service states (20260804210000). Exported so the inbox and the
 * customer chat agree on the vocabulary instead of each hard-coding strings.
 */
/**
 * Every state is DERIVED from who spoke last, by trigger. The only one a
 * human sets is `resolved` — see 20260804260000_simplify_conversation_states.
 */
export const CONVERSATION_STATUS = {
  BOT_ACTIVE: 'bot_active',            // bot handling; new chat or a returning customer
  WAITING: 'waiting',                  // customer spoke last — OUR TURN, the queue
  WAITING_CUSTOMER: 'waiting_customer',// an admin spoke last — their turn
  RESOLVED: 'resolved',                // an admin said so; the only manual state
};

/**
 * Inbox ordering, shared by the initial fetch and the realtime updates so a
 * live change cannot reshuffle the list differently from a reload.
 * Waiting first — that is the whole point of the queue — then oldest wait
 * first within it, so the person who has waited longest is at the top.
 */
export const compareConversations = (a, b) => {
  const aWaiting = a.status === CONVERSATION_STATUS.WAITING;
  const bWaiting = b.status === CONVERSATION_STATUS.WAITING;
  if (aWaiting !== bWaiting) return aWaiting ? -1 : 1;

  if (aWaiting && bWaiting) {
    const aSince = new Date(a.last_customer_message_at || a.created_at);
    const bSince = new Date(b.last_customer_message_at || b.created_at);
    return aSince - bSince;   // oldest wait first
  }

  if ((a.unread_count > 0) !== (b.unread_count > 0)) return a.unread_count > 0 ? -1 : 1;

  const timeA = new Date(a.last_message?.created_at || a.created_at);
  const timeB = new Date(b.last_message?.created_at || b.created_at);
  return timeB - timeA;
};

/**
 * Search message BODIES across every conversation (admin only).
 *
 * The sidebar search matched customer name and email only, so a thread an
 * admin remembered by what was said in it was unfindable. Returns one row per
 * matching conversation with the most recent matching line, so the list can
 * show why a result came back.
 *
 * @param {string} query
 * @returns {Map<string, {snippet: string, matchCount: number, matchedAt: string}>}
 *          keyed by conversation id; empty for queries under 2 characters.
 */
export const searchConversationMessages = async (query) => {
  const term = (query || '').trim();
  if (term.length < 2) return new Map();

  const { data, error } = await supabase.rpc('search_conversation_messages', { p_query: term });
  if (error) throw error;

  return new Map(
    (data || []).map(row => [
      row.conversation_id,
      { snippet: row.snippet, matchCount: row.match_count, matchedAt: row.matched_at },
    ])
  );
};

export const getAdminConversations = async () => {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      id,
      created_at,
      status,
      escalated,
      first_response_at,
      last_customer_message_at,
      resolved_at,
      profiles:customer_id (id, name, email)
    `)
    .order('created_at', { ascending: true });
  if (error) throw error;

  // Deduplicate: keep only the earliest conversation per customer
  const seen = new Map();
  for (const conv of data || []) {
    const custId = conv.profiles?.id;
    if (custId && !seen.has(custId)) {
      seen.set(custId, conv);
    }
  }

  const convs = Array.from(seen.values());
  const convIds = convs.map(c => c.id);

  if (convIds.length > 0) {
    // Batch query last messages and unread counts for all conversations
    const [{ data: unreadData }, { data: lastMsgsData }] = await Promise.all([
      supabase
        .from('chat_messages')
        .select('conversation_id')
        .in('conversation_id', convIds)
        .eq('sender_role', 'customer')
        .eq('is_read', false),
      supabase
        .from('chat_messages')
        // sender_id rides along so the sidebar preview can say WHICH admin
        // replied. In a shared inbox (20260808150000) a flat "You:" on every
        // admin line is wrong for whichever admin did not send it.
        .select('conversation_id, message, created_at, sender_role, sender_id')
        .in('conversation_id', convIds)
        .order('created_at', { ascending: false })
    ]);

    const unreadMap = {};
    (unreadData || []).forEach(m => {
      unreadMap[m.conversation_id] = (unreadMap[m.conversation_id] || 0) + 1;
    });

    const lastMsgMap = {};
    (lastMsgsData || []).forEach(m => {
      if (!lastMsgMap[m.conversation_id]) {
        lastMsgMap[m.conversation_id] = m;
      }
    });

    convs.forEach(c => {
      // Same rule as the sidebar badge (getAdminInboxUnreadCount): a message
      // the bot answered is not unread work. Counting it put an unread dot on
      // rows with nothing owed, so the list and the badge disagreed.
      c.unread_count = c.status === CONVERSATION_STATUS.WAITING ? (unreadMap[c.id] || 0) : 0;
      c.last_message = lastMsgMap[c.id] || null;
    });
  }

  convs.sort(compareConversations);

  return convs;
};

/**
 * Grace window for reopening a resolved conversation, mirroring
 * 20260807120000_reopen_resolved_conversations.sql.
 *
 * DISPLAY ONLY. The trigger decides the actual routing, and the client clock
 * can disagree with the server's near the boundary — which is why the send path
 * re-reads the conversation after inserting rather than trusting this figure.
 * Use it to phrase the UI, never to decide whether the bot runs.
 */
export const REOPEN_GRACE_MS = 12 * 60 * 60 * 1000;

/** True if a reply to this resolved thread reads as a follow-up, not a new topic. */
export const isWithinReopenGrace = (conversation) => {
  if (!conversation?.resolved_at) return false;
  const resolvedAt = new Date(conversation.resolved_at).getTime();
  if (Number.isNaN(resolvedAt)) return false;
  return Date.now() - resolvedAt <= REOPEN_GRACE_MS;
};

/**
 * The conversation's CURRENT server-side state.
 *
 * Read after sending into a resolved thread: the trigger has just decided
 * whether that message reopened the thread to an admin or started a fresh bot
 * session, and this is how the client learns which without recomputing the
 * 12-hour rule against a clock that may not match the server's.
 */
export const getConversationState = async (conversationId) => {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, status, resolved_at')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

export const getMessages = async (conversationId) => {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*, profiles:sender_id (name)')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
};

// Paginated fetch: newest page first, `before` cursor loads older history.
export const getMessagesPage = async (conversationId, { limit = 50, before = null } = {}) => {
  let query = supabase
    .from('chat_messages')
    .select('*, profiles:sender_id (name)')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (before) query = query.lt('created_at', before);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];
  const hasMore = rows.length > limit;
  const messages = (hasMore ? rows.slice(0, limit) : rows).reverse();
  return { messages, hasMore };
};

export const markCustomerMessagesRead = async (conversationId) => {
  const { error } = await supabase
    .from('chat_messages')
    .update({ is_read: true })
    .eq('conversation_id', conversationId)
    .eq('sender_role', 'customer')
    .eq('is_read', false);
  if (error) throw error;
};

// Count unread ADMIN messages across the customer's own conversations.
//
// The conversation filter is a PostgREST inner-join embed, NOT a nested .in().
// `.in()` takes an array and does not accept a query builder — passing one made
// it throw `TypeError: object is not iterable` on every single call. The catch
// in useCustomerChatUnread swallowed that, so the badge sat at 0 forever and a
// customer never saw that an admin had replied.
//
// The embed resolves via chat_messages_conversation_id_fkey and filters on the
// joined column, so the whole thing stays one round trip.
export const getCustomerUnreadChatCount = async (userId) => {
  const { count, error } = await supabase
    .from('chat_messages')
    .select('id, conversations!inner(customer_id)', { count: 'exact', head: true })
    .eq('sender_role', 'admin')
    .eq('is_read', false)
    .eq('conversations.customer_id', userId);
  if (error) throw error;
  return count || 0;
};

/**
 * Count unread CUSTOMER messages that are actually owed a human reply.
 *
 * Scoped to conversations in 'waiting' — the state the trigger sets when the
 * customer spoke last AND a human owns the thread. Everything the bot handled
 * while the conversation sat in 'bot_active' is excluded, which is the whole
 * point: those messages were answered, just not by a person, and counting them
 * inflated the inbox badge to the size of total chat traffic. An admin looking
 * at "23" had no way to know that 20 of them were already resolved.
 *
 * Same PostgREST inner-join embed as getCustomerUnreadChatCount — one round
 * trip, filtered on the joined column. See the note there about why a nested
 * .in() cannot work.
 */
export const getAdminInboxUnreadCount = async () => {
  const { count, error } = await supabase
    .from('chat_messages')
    .select('id, conversations!inner(status)', { count: 'exact', head: true })
    .eq('sender_role', 'customer')
    .eq('is_read', false)
    .eq('conversations.status', CONVERSATION_STATUS.WAITING);
  if (error) throw error;
  return count || 0;
};

// Customer marks ADMIN messages as read in a conversation they own
export const markAdminMessagesRead = async (conversationId) => {
  const { error } = await supabase
    .from('chat_messages')
    .update({ is_read: true })
    .eq('conversation_id', conversationId)
    .eq('sender_role', 'admin')
    .eq('is_read', false);
  if (error) throw error;
};

export const sendMessage = async (conversationId, senderId, senderRole, text) => {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      sender_role: senderRole,
      message: text
    })
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ==================== REPORTS ====================
export const getFinancialReportData = async (customStart, customEnd) => {
  if (!customStart || !customEnd) throw new Error('Start and end dates are required');
  
  // Create Manila-timezone bounds manually. Date input is YYYY-MM-DD.
  const startDateStr = customStart + 'T00:00:00+08:00';
  const endDateObj = new Date(customEnd + 'T00:00:00+08:00');
  endDateObj.setDate(endDateObj.getDate() + 1);
  const endDateStr = endDateObj.toISOString(); // next day 00:00:00 exclusive
  
  const { data, error } = await supabase.rpc('get_financial_report_data', {
    p_start_date: startDateStr,
    p_end_date: endDateStr
  });
  if (error) throw error;
  
  return {
    startDate: startDateStr,
    endDate: endDateStr,
    generatedAt: new Date().toISOString(),
    ...data
  };
};

export const getSalesOverviewData = async () => {
  const { data, error } = await supabase.rpc('get_sales_overview_data');
  if (error) throw error;
  return data;
};
// ==================== ACTIVITY LOGS ====================

const applyActivityLogFilters = (query, {
  module = null,
  action = null,
  adminId = null,
  dateFrom = null,
  dateTo = null,
  search = null,
  hideLogins = false,
} = {}) => {
  if (module) query = query.eq('module', module);
  if (action) query = query.ilike('action', `%${action}%`);
  if (adminId) query = query.eq('admin_id', adminId);
  if (dateFrom) query = query.gte('created_at', dateFrom);
  if (dateTo) query = query.lte('created_at', dateTo);
  if (hideLogins) query = query.not('action', 'ilike', '%Logged%');
  if (search) query = query.or(`action.ilike.%${search}%,record_ref.ilike.%${search}%,admin_name.ilike.%${search}%,details.ilike.%${search}%`);
  return query;
};

/**
 * Fetch paginated, filtered activity logs for the Activity Logs admin page.
 */
export const getActivityLogs = async ({
  module = null,
  action = null,
  adminId = null,
  dateFrom = null,
  dateTo = null,
  search = null,
  hideLogins = false,
  page = 1,
  pageSize = 50,
} = {}) => {
  let query = supabase
    .from('activity_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  query = applyActivityLogFilters(query, {
    module, action, adminId, dateFrom, dateTo, search, hideLogins,
  });

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { logs: data || [], total: count || 0, page, pageSize };
};

/**
 * Fetch every row matching the visible filters for CSV export. Supabase caps
 * individual responses, so read in batches instead of exporting only the
 * currently displayed 50-row page.
 */
export const getActivityLogsForExport = async (filters = {}) => {
  const rows = [];
  const batchSize = 1000;
  const snapshotTime = new Date().toISOString();
  let cursor = null;

  while (true) {
    let query = supabase
      .from('activity_logs')
      .select('*')
      .lte('created_at', snapshotTime)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(batchSize);

    query = applyActivityLogFilters(query, filters);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
      );
    }
    const { data, error } = await query;
    if (error) throw error;

    const batch = data || [];
    rows.push(...batch);
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1];
  }

  return rows;
};

/**
 * Fetch all activity log entries for a specific record (order/trip) for an
 * in-page timeline display. Payment-triggered entries intentionally use the
 * payment transaction id as `record_id` and the order tracking number as
 * `record_ref`, so order detail pages must query both keys to show the full
 * audit trail. Equality queries are kept separate instead of interpolating a
 * user-controlled `.or(...)` filter string.
 */
export const getActivityLogsByRecord = async (recordId, recordRef = null) => {
  if (!recordId && !recordRef) return [];

  const queries = [];
  if (recordId) {
    queries.push(
      supabase
        .from('activity_logs')
        .select('*')
        .eq('record_id', recordId),
    );
  }
  if (recordRef) {
    queries.push(
      supabase
        .from('activity_logs')
        .select('*')
        .eq('record_ref', recordRef),
    );
  }

  const results = await Promise.all(queries);
  const rows = results.flatMap(({ data, error }) => {
    if (error) throw error;
    return data || [];
  });
  const uniqueRows = new Map(rows.map(row => [row.id, row]));

  return [...uniqueRows.values()].sort((a, b) => {
    const timeDifference = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return timeDifference || String(a.id).localeCompare(String(b.id));
  });
};

// ==================== ORDER STATUS EVENTS ====================

/**
 * Permanent shipment status history for one order.
 *
 * Replaces reconstructing the timeline from activity_logs, which is purged
 * after 7 days. Rows are written by the orders_log_status_event trigger and
 * are readable by the order's owner and by admins.
 *
 * @returns {Array<{status: string, changed_at: string, note: ?string}>}
 *          ascending by changed_at
 */
export const getOrderStatusEvents = async (orderId) => {
  if (!orderId) return [];
  const { data, error } = await supabase
    .from('order_status_events')
    .select('status, changed_at, note')
    .eq('order_id', orderId)
    .order('changed_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

/**
 * Status history for the anonymous tracking page.
 *
 * Anonymous visitors cannot read order_status_events directly (RLS), so this
 * goes through an RPC that returns only status + timestamp — no names, no
 * amounts, no ids.
 */
export const getPublicOrderEvents = async (trackingNumber) => {
  if (!trackingNumber) return [];
  const { data, error } = await supabase.rpc('get_public_order_events', {
    p_tracking_number: trackingNumber,
  });
  if (error) throw error;
  return data || [];
};

/**
 * Bulk updates the status of all orders assigned to a specific trip that match given current statuses.
 * @param {string} tripId
 * @param {string[]} currentStatuses - Array of statuses an order must have to be updated.
 * @param {string} newStatus - The new status to apply.
 * @param {string} actionDescription - Description for the activity log / notification.
 */
export const bulkUpdateOrdersStatusByTrip = async (tripId, currentStatuses, newStatus, actionDescription) => {
  // 1. Fetch matching orders
  const { data: orders, error: fetchErr } = await supabase
    .from('orders')
    .select('id, tracking_number, status, user_id')
    .eq('trip_id', tripId)
    .in('status', currentStatuses);

  if (fetchErr) throw fetchErr;
  if (!orders || orders.length === 0) return 0;

  // 2. Perform updates and create notifications
  await Promise.all(orders.map(async (order) => {
    // Update order status
    const { error: updateErr } = await supabase
      .from('orders')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', order.id);
    
    if (updateErr) throw updateErr;

    // Log the activity. The customer's status notification comes from the
    // orders_notify_customer_of_change trigger on the UPDATE above.
    logOrder(`Status Changed to ${newStatus}`, order.id, order.tracking_number, {
      previousValue: { status: order.status },
      newValue: { status: newStatus },
      details: actionDescription || `Bulk update via Trip ${tripId}`
    });
  }));

  return orders.length;
};

// ==================== PAYMENT TRANSACTIONS ====================


export const recordPaymentTransaction = async (orderId, amount, method, ref, status, notes, paymentType = 'Additional Payment', paymentDate = null, receiptUrl = null) => {
  const { data: { user } } = await supabase.auth.getUser();
  let adminId = user?.id || null;
  let adminName = 'System';
  if (user) {
    const { data: profile } = await supabase.from('profiles').select('name').eq('id', user.id).single();
    if (profile?.name) adminName = profile.name;
  }
  
  const { data, error } = await supabase.from('payment_transactions').insert({
    order_id: orderId,
    amount,
    payment_method: method,
    transaction_reference: ref,
    payment_status: status,
    admin_id: adminId,
    admin_name: adminName,
    notes,
    payment_type: paymentType,
    payment_date: paymentDate,
    receipt_url: receiptUrl
  }).select().single();
  
  if (error) throw error;
  return data;
};

/**
 * Atomically record a pickup: order metadata UPDATE + ledger INSERT in one
 * transaction. Replaces the old two-round-trip updateOrder() +
 * recordPaymentTransaction() sequence, where a failure between the two left
 * the order marked paid with no backing ledger row.
 *
 * Never pass amount_paid / remaining_balance / payment_status — the ledger
 * trigger derives them. Pass the money under `payment` instead.
 *
 * @param {string} orderId
 * @param {Object} payload
 * @param {number} payload.actual_weight
 * @param {string} payload.payment_method
 * @param {string} [payload.payer_type='sender']
 * @param {Array}  [payload.pickup_photos=[]]
 * @param {string} [payload.promised_payment_date]
 * @param {string} [payload.payment_reference]
 * @param {?Object} [payload.payment] — { amount, payment_date, receipt_url }.
 *                  Null when a PayMongo QR is still pending; the webhook
 *                  records that payment into the ledger instead.
 * @param {?string} [payload.idempotency_key] — stable id generated once by
 *                  the caller and reused unchanged on retry (double-click, a
 *                  dropped response after this already committed). Omitting
 *                  it disables dedup for that call, so callers that collect
 *                  money should always pass one.
 * @param {boolean} [payload.admin_verified_receipt=false] — required true
 *                  when a manual GCash reference is being recorded; attests
 *                  the admin confirmed the transfer landed before saving it.
 * @param {number} [payload.discount_amount=0] — fixed peso amount off the
 *                  ORIGINAL fee. 0 (the default) means no discount; the RPC
 *                  clears discount_reason/notes server-side whenever this is
 *                  0, regardless of what those two fields carry. Only settable
 *                  here, before pickup is confirmed — see
 *                  guard_order_update() in the shipping-discount migrations.
 * @param {?string} [payload.discount_reason] — 'Regular customer' |
 *                  'Negotiated price' | 'Other'. Required server-side when
 *                  discount_amount > 0.
 * @param {?string} [payload.discount_notes] — required server-side when
 *                  discount_reason is 'Other'.
 * @returns {Object} the fresh order row, totals already recomputed
 */
export const recordPickupPayment = async (orderId, payload) => {
  const { data, error } = await supabase.rpc('record_pickup_payment', {
    p_order_id: orderId,
    p_actual_weight: payload.actual_weight,
    p_payment_method: payload.payment_method,
    p_payer_type: payload.payer_type || 'sender',
    p_pickup_photos: payload.pickup_photos || [],
    p_promised_payment_date: payload.promised_payment_date || null,
    p_amount: payload.payment?.amount ?? null,
    p_reference: payload.payment_reference || null,
    p_payment_date: payload.payment?.payment_date || null,
    p_receipt_url: payload.payment?.receipt_url || null,
    p_idempotency_key: payload.idempotency_key || null,
    p_admin_verified_receipt: payload.admin_verified_receipt || false,
    p_discount_amount: payload.discount_amount || 0,
    p_discount_reason: payload.discount_reason || null,
    p_discount_notes: payload.discount_notes || null,
  });
  if (error) throw error;
  return data;
};

/**
 * Atomically record a delivery: order metadata UPDATE + optional balance
 * settlement in one transaction. Same contract as recordPickupPayment.
 *
 * Cash and GCash are both accepted here — the admin is physically receiving
 * payment from the receiver right now, same as at pickup. A LATER,
 * out-of-band balance settlement goes through recordAdditionalPayment()
 * instead, which stays GCash-only.
 */
export const recordDeliveryPayment = async (orderId, payload) => {
  const { data, error } = await supabase.rpc('record_delivery_payment', {
    p_order_id: orderId,
    p_delivery_photos: payload.delivery_photos || [],
    p_payment_method: payload.payment_method || null,
    p_amount: payload.payment?.amount ?? null,
    p_reference: payload.payment_reference || null,
    p_payment_date: payload.payment?.payment_date || null,
    p_receipt_url: payload.payment?.receipt_url || null,
    // Required by the business rule when cargo is handed over with a balance
    // still owing — see 20260804100000_settlement_guards.sql.
    p_promised_payment_date: payload.promised_payment_date || null,
    p_idempotency_key: payload.idempotency_key || null,
    p_admin_verified_receipt: payload.admin_verified_receipt || false,
  });
  if (error) throw error;
  return data;
};

/**
 * Record a counter payment (balance settlement / "Record Additional
 * Payment") against an existing balance — always a POST-pickup collection,
 * so the record_additional_payment() RPC rejects cash unconditionally.
 *
 * This used to be a plain client-side `SELECT` (no row lock) followed by a
 * raw `.insert()` into payment_transactions under RLS alone — the "SELECT
 * then INSERT" pattern that gives no protection against a double-click, a
 * retried request, or two admins racing on the same order. It now goes
 * through the same locked, idempotent RPC pattern as pickup/delivery.
 *
 * @param {string} orderId
 * @param {number} amount
 * @param {string} method — must be 'gcash'; 'cash' is rejected server-side.
 * @param {?string} ref — the GCash transfer reference (required for 'gcash').
 * @param {?string} notes
 * @param {?string} paymentDate
 * @param {?string} receiptUrl
 * @param {?string} idempotencyKey — stable id reused on retry; see
 *   recordPickupPayment's doc comment.
 * @param {boolean} adminVerifiedReceipt — must be true; attests the admin
 *   confirmed the transfer actually landed before recording it.
 */
export const recordAdditionalPayment = async (orderId, amount, method, ref, notes, paymentDate = null, receiptUrl = null, idempotencyKey = null, adminVerifiedReceipt = false) => {
  const { data, error } = await supabase.rpc('record_additional_payment', {
    p_order_id: orderId,
    p_amount: amount,
    p_payment_method: method,
    p_reference: ref || null,
    p_notes: notes || null,
    p_payment_date: paymentDate || null,
    p_receipt_url: receiptUrl || null,
    p_idempotency_key: idempotencyKey || null,
    p_admin_verified_receipt: adminVerifiedReceipt || false,
  });
  if (error) throw error;

  return {
    newAmountPaid: data.amount_paid,
    newBalance: data.remaining_balance,
    newStatus: data.payment_status,
  };
};

const refundFinancialStatus = status => status === 'succeeded' ? 'refunded'
  : status === 'failed' ? 'failed'
    : status === 'processing' ? 'processing' : 'pending';

const mergePaymentActivity = (payments = [], refunds = [], attempts = []) => {
  const refundTotals = new Map();
  const reservedTotals = new Map();
  for (const refund of refunds) {
    const amount = Number(refund.amount || 0);
    if (refund.status === 'succeeded') {
      refundTotals.set(refund.payment_transaction_id, (refundTotals.get(refund.payment_transaction_id) || 0) + amount);
    }
    if (['creating', 'pending', 'processing', 'succeeded'].includes(refund.status)) {
      reservedTotals.set(refund.payment_transaction_id, (reservedTotals.get(refund.payment_transaction_id) || 0) + amount);
    }
  }

  const paymentRows = payments.map(payment => ({
    ...payment,
    is_refund: false,
    refunded_amount: refundTotals.get(payment.id) || 0,
    refundable_amount: Math.max(Number(payment.amount || 0) - (reservedTotals.get(payment.id) || 0), 0),
    financial_amount: Number(payment.amount || 0),
  }));
  const refundRows = refunds.map(refund => {
    // refund_channel distinguishes a PayMongo-processed refund from a
    // manually-recorded one (see 20260918020000_manual_refund_recording.sql)
    // — a manual refund was never a 'gcash'/'paymongo' event, and hardcoding
    // that here would misrepresent every manual refund row (Cash return
    // shown as GCash, etc). return_method ('cash' | 'gcash') is how the
    // money actually went back out, which is only meaningful for a manual
    // row; a PayMongo refund always returns to the original GCash source.
    const isManual = refund.refund_channel === 'manual';
    return {
      id: `refund:${refund.id}`,
      order_id: refund.order_id,
      // Keep the displayed/requested refund amount positive. A completed refund
      // affects statement arithmetic through financial_amount only; pending,
      // uncertain, and failed requests have zero financial impact.
      amount: Number(refund.amount || 0),
      financial_amount: refund.status === 'succeeded' ? -Number(refund.amount || 0) : 0,
      payment_method: isManual ? (refund.return_method || 'cash') : 'gcash',
      gcash_channel: isManual ? null : 'paymongo',
      payment_status: refundFinancialStatus(refund.status),
      refund_status: refund.outcome_uncertain ? 'uncertain' : refund.status,
      refund_channel: refund.refund_channel || 'paymongo',
      return_method: refund.return_method || null,
      returned_at: refund.returned_at || null,
      is_manual_refund: isManual,
      payment_type: 'Refund',
      payment_date: null,
      transaction_reference: isManual ? (refund.return_reference || null) : refund.refund_id,
      notes: refund.notes,
      admin_id: refund.initiated_by,
      admin_name: refund.initiated_by_name || 'Payment System',
      refund_failure_reason: refund.public_failure_reason || null,
      created_at: refund.provider_created_at || refund.created_at,
      updated_at: refund.provider_updated_at || refund.updated_at,
      original_payment_transaction_id: refund.payment_transaction_id,
      is_refund: true,
      livemode: refund.livemode,
    };
  });
  const failedAttemptRows = attempts.map(attempt => ({
    id: `attempt:${attempt.id}`,
    order_id: attempt.order_id,
    amount: Number(attempt.amount || 0),
    financial_amount: 0,
    payment_method: 'gcash',
    payment_status: 'failed',
    payment_type: 'Payment Attempt',
    payment_date: null,
    transaction_reference: null,
    notes: attempt.failure_message || 'Payment was not completed. No money was added to this order.',
    admin_id: null,
    admin_name: 'Payment System',
    created_at: attempt.created_at,
    updated_at: attempt.updated_at,
    is_refund: false,
    is_payment_attempt: true,
    refundable_amount: 0,
  }));

  return [...paymentRows, ...refundRows, ...failedAttemptRows].sort((a, b) => {
    const time = new Date(a.payment_date || a.created_at) - new Date(b.payment_date || b.created_at);
    return time || String(a.id).localeCompare(String(b.id));
  });
};

export const getPaymentTransactions = async (orderId) => {
  const [
    { data: payments, error: paymentError },
    { data: refunds, error: refundError },
    { data: attempts, error: attemptError },
  ] = await Promise.all([
    supabase.rpc('get_payment_transaction_history', { p_order_ids: [orderId] }),
    supabase.rpc('get_payment_refund_history', { p_order_ids: [orderId] }),
    supabase.rpc('get_payment_attempt_history', { p_order_ids: [orderId] }),
  ]);
  if (paymentError) throw paymentError;
  if (refundError) throw refundError;
  if (attemptError) throw attemptError;
  return mergePaymentActivity(payments || [], refunds || [], attempts || []);
};

/**
 * C-3 fix: Batch-fetch payment transactions for multiple orders in a single query.
 * Replaces the N+1 pattern of calling getPaymentTransactions() per order.
 * @param {string[]} orderIds - Array of order IDs to fetch transactions for.
 * @returns {Object} Map of orderId -> transaction[]
 */
export const getPaymentTransactionsBatch = async (orderIds) => {
  if (!orderIds || orderIds.length === 0) return {};
  // Keep each PostgREST URL comfortably below proxy/browser limits without
  // silently dropping older orders. Customers may have more than 200 orders,
  // and the caller must not have to trade complete history for URL safety.
  const uniqueIds = [...new Set(orderIds.filter(Boolean))];
  const chunks = [];
  for (let index = 0; index < uniqueIds.length; index += 100) {
    chunks.push(uniqueIds.slice(index, index + 100));
  }

  const fetchHistoryChunk = async (rpc, ids) => {
    const rows = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .rpc(rpc, { p_order_ids: ids })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
    return rows;
  };

  const [paymentResponses, refundResponses, attemptResponses] = await Promise.all([
    Promise.all(chunks.map(ids => fetchHistoryChunk('get_payment_transaction_history', ids))),
    Promise.all(chunks.map(ids => fetchHistoryChunk('get_payment_refund_history', ids))),
    Promise.all(chunks.map(async ids => {
      const { data, error } = await supabase.rpc('get_payment_attempt_history', { p_order_ids: ids });
      if (error) throw error;
      return data || [];
    })),
  ]);
  const payments = paymentResponses.flat();
  const refunds = refundResponses.flat();
  const attempts = attemptResponses.flat();
  const paymentsByOrder = {};
  const refundsByOrder = {};
  const attemptsByOrder = {};
  for (const tx of payments) {
    if (!paymentsByOrder[tx.order_id]) paymentsByOrder[tx.order_id] = [];
    paymentsByOrder[tx.order_id].push(tx);
  }
  for (const refund of refunds) {
    if (!refundsByOrder[refund.order_id]) refundsByOrder[refund.order_id] = [];
    refundsByOrder[refund.order_id].push(refund);
  }
  for (const attempt of attempts) {
    if (!attemptsByOrder[attempt.order_id]) attemptsByOrder[attempt.order_id] = [];
    attemptsByOrder[attempt.order_id].push(attempt);
  }

  const grouped = {};
  for (const orderId of uniqueIds) {
    grouped[orderId] = mergePaymentActivity(
      paymentsByOrder[orderId] || [],
      refundsByOrder[orderId] || [],
      attemptsByOrder[orderId] || [],
    );
  }
  return grouped;
};

// ==================== CHAT EXTENSIONS ====================

// Conversation ASSIGNMENT is gone (20260808150000). `assignConversation`,
// `unassignConversation` and `reassignConversation` all wrote
// conversations.assigned_admin_id, a column that no longer exists — support
// chat is a shared inbox and any admin may reply to any thread at any time.
// Who said what is read from chat_messages.sender_id, which is where it has
// always been; the inbox names the sender of each reply.

/**
 * Admin roster, as an id → name lookup for attributing chat replies.
 *
 * It used to populate the reassign dropdown. It survives that control's
 * removal because a message row only carries `sender_id`: the paginated
 * history embeds `profiles:sender_id (name)`, but a realtime INSERT payload
 * and the row returned by `sendMessage` do not, so a reply arriving live from
 * another admin would render nameless. Fetching the roster once is cheaper
 * than re-reading each message with its embed.
 *
 * Admin-gated by RLS on profiles.
 */
export const getAdminProfiles = async () => {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email')
    .eq('role', 'admin')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
};

/**
 * Mark the customer's issue dealt with.
 *
 * Named `resolve`, not `close`, deliberately: resolved is a claim about the
 * customer, closed was a claim about the admin's screen. `resolved_at` is
 * stamped by a trigger, not written here.
 *
 * Not final — if the customer writes again the trigger returns the
 * conversation to `waiting`.
 */
export const resolveConversation = async (conversationId) => {
  const { error } = await supabase
    .from('conversations')
    .update({ status: CONVERSATION_STATUS.RESOLVED })
    .eq('id', conversationId);
  if (error) throw error;
};

// reopenConversation removed: replying to a resolved thread reopens it by
// itself (the trigger derives the state from the message), so a separate
// button asked the admin to do something the system already handles.

/**
 * Record whether the bot actually answered the customer's question.
 *
 * `bot_resolved` starts NULL — "we do not know". 12 of the conversations in
 * the service study ended with a bot reply and no human follow-up, and
 * success (the bot deflected the question) was indistinguishable from
 * failure (the customer gave up). This is the one signal that separates
 * them, and it comes from the only party who knows: the customer.
 *
 * Written on every vote, including repeat votes in a long conversation —
 * the latest answer wins, because it reflects the most recent exchange.
 */
export const recordBotOutcome = async (conversationId, resolved) => {
  const { error } = await supabase
    .from('conversations')
    .update({ bot_resolved: resolved })
    .eq('id', conversationId);
  if (error) throw error;
};

/**
 * escalateConversation
 * Called when the bot matches an escalation pattern, or the customer says
 * their concern is unresolved. Sets `waiting` (the queue) and raises the
 * `escalated` flag — status answers "whose turn", escalated answers
 * "how urgent". They are separate on purpose.
 */
export const escalateConversation = async (conversationId) => {
  const { error } = await supabase
    .from('conversations')
    .update({ status: CONVERSATION_STATUS.WAITING, escalated: true })
    .eq('id', conversationId);
  if (error) throw error;
};

// ==================== COMPANY INFORMATION CMS ====================

export const getCompanyInformation = async () => {
  const { data, error } = await supabase.from('company_information').select('*').single();
  if (error && error.code !== 'PGRST116') throw error; // ignore no rows error
  return data;
};

export const updateCompanyInformation = async (updates) => {
  // Always update the single row (assumes ID is '00000000-0000-0000-0000-000000000001' or we can just update all, since it's 1 row)
  const { data, error } = await supabase.from('company_information').update(updates).eq('id', '00000000-0000-0000-0000-000000000001').select().single();
  if (error) throw error;
  return data;
};


// Ã¢â€â‚¬Ã¢â€â‚¬ Coverage helpers (JSONB on company_information) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

const _getCoverage = async () => {
  const { data, error } = await supabase
    .from('company_information')
    .select('coverage')
    .eq('id', COMPANY_ID)
    .single();
  if (error) throw error;
  return (data?.coverage || []);
};

const _saveCoverage = async (coverage) => {
  const { error } = await supabase
    .from('company_information')
    .update({ coverage })
    .eq('id', COMPANY_ID);
  if (error) throw error;
};

export const getCoverageAreas = async () => {
  return _getCoverage();
};

export const saveCoverageRegion = async (region) => {
  const coverage = await _getCoverage();
  if (region.id) {
    // Update existing region
    const idx = coverage.findIndex(r => r.id === region.id);
    if (idx === -1) throw new Error('Region not found');
    coverage[idx] = { ...coverage[idx], ...region };
  } else {
    // Insert new region
    const newRegion = {
      id: crypto.randomUUID(),
      name: region.name,
      display_order: region.display_order ?? coverage.length,
      municipalities: [],
    };
    coverage.push(newRegion);
  }
  await _saveCoverage(coverage);
  return region;
};

export const deleteCoverageRegion = async (id) => {
  const coverage = await _getCoverage();
  await _saveCoverage(coverage.filter(r => r.id !== id));
};

export const saveCoverageMunicipality = async (municipality) => {
  const coverage = await _getCoverage();
  const regionIdx = coverage.findIndex(r => r.id === municipality.region_id);
  if (regionIdx === -1) throw new Error('Region not found');
  const munis = coverage[regionIdx].municipalities || [];
  if (municipality.id) {
    // Update existing
    const mIdx = munis.findIndex(m => m.id === municipality.id);
    if (mIdx === -1) throw new Error('Municipality not found');
    munis[mIdx] = { ...munis[mIdx], ...municipality };
  } else {
    // Insert new
    munis.push({
      id: crypto.randomUUID(),
      name: municipality.name,
      display_order: municipality.display_order ?? munis.length,
      region_id: municipality.region_id,
    });
  }
  coverage[regionIdx].municipalities = munis;
  await _saveCoverage(coverage);
  return municipality;
};

export const deleteCoverageMunicipality = async (id) => {
  const coverage = await _getCoverage();
  const updated = coverage.map(r => ({
    ...r,
    municipalities: (r.municipalities || []).filter(m => m.id !== id),
  }));
  await _saveCoverage(updated);
};

// ==========================================
// CUSTOMER FEEDBACK SYSTEM
// ==========================================

export const submitFeedback = async ({ orderId, customerId, rating, message }) => {
  const { data, error } = await supabase
    .from('customer_feedback')
    .insert({
      order_id: orderId,
      customer_id: customerId,
      rating: rating,
      message: message
    })
    .select()
    .single();
    
  if (error) throw error;

  return data;
};

export const checkIfFeedbackExists = async (orderId) => {
  const { data, error } = await supabase
    .from('customer_feedback')
    .select('id')
    .eq('order_id', orderId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
};

/**
 * Public testimonials for the About page.
 *
 * Goes through the get_public_feedback() RPC rather than reading
 * customer_feedback directly. The old query relied on two over-broad RLS
 * policies that exposed customer_id — a stable identifier linking a public
 * review to a user account — to anonymous visitors. The RPC never returns it
 * and masks the author name via mask_name().
 *
 * The flat RPC rows are re-shaped into the nested { profiles, orders } form
 * the page already consumes, so rendering is unchanged.
 *
 * Note: authors now actually have names. The old PostgREST embed
 * profiles:customer_id(name) returned NULL for anon (profiles RLS blocks it),
 * so every public testimonial rendered as "Customer".
 *
 * This intentionally carries no photo/shipment-feature fields — a feedback
 * card shows only what the customer actually submitted (rating, message)
 * plus approved display details. See getFeaturedDeliveries() below for the
 * separate, admin-curated "Featured Shipments" gallery; a booking's delivery
 * photo is never auto-attached to its feedback (20260915140000).
 */
export const getPublicFeedback = async () => {
  const { data, error } = await supabase.rpc('get_public_feedback');
  if (error) throw error;

  return (data || []).map(row => ({
    id: row.id,
    rating: row.rating,
    message: row.message,
    created_at: row.created_at,
    profiles: { name: row.customer_name },
    orders: {
      receiver_city: row.receiver_city,
      receiver_province: row.receiver_province,
    },
  }));
};

/**
 * Admin-curated "Featured Shipments" gallery for the About page — distinct
 * from getPublicFeedback() above. Goes through the get_featured_deliveries()
 * RPC, which returns a single `featured_photo` TEXT path (the admin-selected
 * pickup or delivery proof) rather than the full pickup_photos/delivery_photos
 * JSONB arrays, preventing enumeration of every proof photo on a featured
 * order via the anon key. The RPC also requires a title to be set
 * (20260915140000) before a row is published here — see that migration for
 * why.
 */
export const getFeaturedDeliveries = async () => {
  const { data, error } = await supabase.rpc('get_featured_deliveries');
  if (error) throw error;
  return data || [];
};

export const getAdminFeedback = async () => {
  const { data, error } = await supabase
    .from('customer_feedback')
    .select(`
      id,
      rating,
      message,
      is_hidden,
      created_at,
      profiles:customer_id ( name, email ),
      orders:order_id ( tracking_number )
    `)
    .order('created_at', { ascending: false });
    
  if (error) throw error;
  return data;
};

export const updateFeedbackVisibility = async (id, isHidden) => {
  const { error } = await supabase
    .from('customer_feedback')
    .update({ is_hidden: isHidden })
    .eq('id', id);
    
  if (error) throw error;
};

/**
 * Upload a company website asset (hero banner, gallery image, timeline photo)
 * and return a durable public URL.
 *
 * These go to the dedicated PUBLIC `company-assets` bucket rather than
 * `cargo-photos`. Website decoration is meant to be world-readable; cargo
 * evidence is not, and sharing one bucket forced a single privacy setting on
 * both — which is why proof photos ended up publicly reachable.
 * See migration 20260804180000_customer_photo_access.sql.
 */
export const uploadPublicAsset = async (file, path) => {
  // Compress image before uploading
  const { compressImage } = await import('./storage');
  const compressed = await compressImage(file);

  const bucket = 'company-assets';
  const { data, error } = await supabase.storage.from(bucket).upload(path, compressed, { upsert: true });
  if (error) throw error;
  const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(path);
  return publicUrlData.publicUrl;
};

// Batch update functions for drag-and-drop ordering
export const updateCoverageRegionsOrder = async (updates) => {
  // updates: [{ id, display_order }]
  const coverage = await _getCoverage();
  updates.forEach(u => {
    const r = coverage.find(r => r.id === u.id);
    if (r) r.display_order = u.display_order;
  });
  coverage.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  await _saveCoverage(coverage);
};

export const updateCoverageMunicipalitiesOrder = async (updates) => {
  // updates: [{ id, region_id, display_order }]
  const coverage = await _getCoverage();
  updates.forEach(u => {
    const region = coverage.find(r => r.id === u.region_id);
    if (!region) return;
    const m = (region.municipalities || []).find(m => m.id === u.id);
    if (m) m.display_order = u.display_order;
  });
  coverage.forEach(r => {
    if (r.municipalities) r.municipalities.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  });
  await _saveCoverage(coverage);
};

export const updateCompanyFeaturesOrder = async (updates) => {
  const { data, error } = await supabase
    .from('company_information')
    .update({ features: updates })
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Public tracking (wraps the anon RPC so pages never touch supabase directly) Ã¢â€â‚¬Ã¢â€â‚¬
export const getPublicTrackingResult = async (trackingNumber) => {
  const { data, error } = await supabase
    .rpc('track_order_public', { p_tracking_number: trackingNumber })
    .maybeSingle();
  if (error) throw error;
  return data;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Profile self-service update (moved out of PersonalInfoPage) Ã¢â€â‚¬Ã¢â€â‚¬
export const updateOwnProfile = async (userId, fields) => {
  const { error } = await supabase
    .from('profiles')
    .update(fields)
    .eq('id', userId);
  if (error) throw error;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Admin inbox directory search (moved out of InboxPage) Ã¢â€â‚¬Ã¢â€â‚¬
export const searchCustomerDirectory = async (term) => {
  // Strip PostgREST filter delimiters so user input can't break the .or() expression
  const clean = String(term || '').replace(/[,()]/g, ' ').trim();
  if (!clean) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, phone')
    .eq('role', 'customer')
    .or(`name.ilike.%${clean}%,email.ilike.%${clean}%`)
    .order('name', { ascending: true })
    .limit(8);
  if (error) throw error;
  return data || [];
};

// Ã¢â€â‚¬Ã¢â€â‚¬ PayMongo reconcile helpers (moved out of PaymentCollectionPanel / AdditionalPaymentModal) Ã¢â€â‚¬Ã¢â€â‚¬
export const getPaymentAttemptBySource = async (sourceId) => {
  const { data, error } = await supabase
    .from('payment_attempts')
    .select('status, payment_status')
    .eq('source_id', sourceId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const getOrderPaymentSnapshot = async (orderId) => {
  const { data, error } = await supabase
    .from('orders')
    .select('amount_paid, remaining_balance, payment_status, payment_reference')
    .eq('id', orderId)
    .single();
  if (error) throw error;
  return data;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ New-inquiry badge count (moved out of Sidebar) Ã¢â€â‚¬Ã¢â€â‚¬
export const getNewInquiryCount = async () => {
  const { count, error } = await supabase
    .from('contact_inquiries')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new');
  if (error) throw error;
  return count || 0;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Receipt-cleanup step of Manual Evidence Cleanup (moved out of admin ODP) Ã¢â€â‚¬Ã¢â€â‚¬
export const clearPaymentReceiptUrls = async (orderId) => {
  // payment_transactions no longer accepts a direct admin UPDATE (see
  // 20260909030000_manual_payment_hardening.sql) — every write, including
  // this one, goes through a SECURITY DEFINER RPC now.
  const { error } = await supabase.rpc('clear_payment_receipt_url', { p_order_id: orderId });
  if (error) throw error;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Admin photo-storage monitoring: usage summary + live health Ã¢â€â‚¬Ã¢â€â‚¬
// get_effective_photo_storage_mode() / set_photo_storage_mode() remain in the
// database as a backend-only safety valve (Storage RLS still enforces
// whichever mode is set — see is_supabase_evidence_upload_allowed) but are no
// longer exposed from the admin UI, so no client wrapper is kept for them.
// An operator can still call them directly by SQL during an incident.
export const getPhotoStorageSummary = async () => {
  const { data, error } = await supabase.rpc('get_photo_storage_summary');
  if (error) throw error;
  return data?.[0] || null;
};

const photoFunctionError = async (error, fallbackMessage) => {
  try {
    const response = error?.context;
    const body = response && typeof response.clone === 'function'
      ? await response.clone().json()
      : null;
    if (body?.error) return new Error(body.error);
  } catch {
    // The response body is optional; use the safe message below when absent.
  }
  return new Error(error?.message || fallbackMessage);
};

export const checkPhotoStorageHealth = async () => {
  const { data, error } = await supabase.functions.invoke('photo-storage-health');
  if (error) throw await photoFunctionError(error, 'Could not check Photo Storage.');
  if (data?.error) throw new Error(data.error);
  return data;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Admin photo browser: booking folders, one folder's photos, select-and-delete Ã¢â€â‚¬Ã¢â€â‚¬
// Both listing functions are read-only and share one eligibility
// implementation (evidence_photo_rows(), not exposed directly); delete_
// evidence_photos() (called inside the Edge Function below) re-derives
// eligibility from scratch for every photo rather than trusting either list.
export const listEvidenceFolders = async ({ search = '', page = 1, pageSize = 30 } = {}) => {
  const { data, error } = await supabase.rpc('list_evidence_folders', {
    p_search: search || null,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) throw error;
  const rows = data || [];
  return { data: rows, count: rows[0]?.total_count ? Number(rows[0].total_count) : 0 };
};

// folderKey: a tracking_number, or '__unbooked__' for the "Photos Without Bookings" folder.
export const listFolderPhotos = async (folderKey, { page = 1, pageSize = 100 } = {}) => {
  const { data, error } = await supabase.rpc('list_folder_photos', {
    p_folder_key: folderKey,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) throw error;
  const rows = data || [];
  return { data: rows, count: rows[0]?.total_count ? Number(rows[0].total_count) : 0 };
};

// items: [{ order_id, photo_field, provider, storage_path }]
export const deleteEvidencePhotos = async (items) => {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Select at least one photo.');
  const { data, error } = await supabase.functions.invoke('delete-storage-photos', {
    body: { items },
  });
  if (error) throw await photoFunctionError(error, 'Could not delete the selected photos.');
  if (data?.error) throw new Error(data.error);
  return data;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Company Images (company-assets bucket) Ã¢â€â‚¬Ã¢â€â‚¬
// Listing/reading uses the Storage SDK directly (list()/createSignedUrl()) —
// admins already have full access to this bucket via its own RLS policy, so
// no RPC is needed just to browse it. The one thing the browser can't safely
// decide on its own — "is this the image currently live on the site" — is
// re-checked here before the caller is allowed to call storage.remove().
export const checkCompanyAssetDeletable = async (paths) => {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('Select at least one file.');
  const { data, error } = await supabase.rpc('check_company_asset_deletable', { p_paths: paths });
  if (error) throw error;
  return data || [];
};
