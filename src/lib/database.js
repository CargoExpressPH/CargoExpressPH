import { supabase } from './supabase';
import { logOrder, logPayment, logChat } from './activityLog';
import { validateStatusTransition, outstandingBalance, ORDER_STATUS, tripCapacityState, tripCapacityRefusal, canAdminCancelOrder } from '../constants/status';
import { detectPickupLocation } from '../constants/phLocations';
import { phDayRangeISO, formatPhDate } from '../utils/datetime';

// ==================== HELPER ====================
// ─────────────────────────────────────────────────────────────────────────────
// withTimeout is now a pass-through.
// Timeouts and automatic retries are now handled globally by the custom fetch
// wrapper in supabase.js (45 seconds timeout + 3 retries).
// ─────────────────────────────────────────────────────────────────────────────
export const withTimeout = (promise, ms = 60000) => {
  return promise;
};

const PUSH_RETRY_ATTEMPTS = 2;
const PUSH_RETRY_DELAY_MS = 600;

const waitForPushRetry = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Push is a secondary channel: the database notification is already the
 * durable record. It still deserves a bounded retry so a transient Edge
 * Function/network error is not silently lost while the page is open.
 * send-push deduplicates attempts when a notification id is available.
 */
const invokePushWithRetry = async (body, context = 'notification') => {
  let lastError = null;

  for (let attempt = 1; attempt <= PUSH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const { data, error } = await supabase.functions.invoke('send-push', { body });

      // A user without a registered device is an expected, successful skip;
      // retrying that response only adds needless traffic.
      if (!error && data?.skipped) return data;
      if (!error && data?.success !== false) return data;

      lastError = error || new Error(data?.error || 'Push delivery failed');
    } catch (error) {
      lastError = error;
    }

    if (attempt < PUSH_RETRY_ATTEMPTS) {
      await waitForPushRetry(PUSH_RETRY_DELAY_MS * attempt);
    }
  }

  console.warn(
    `[push] ${context} failed after ${PUSH_RETRY_ATTEMPTS} attempts:`,
    lastError?.message || lastError,
  );
  return null;
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
 * client-side query — and a client-side SUM() over it — silently undercounts
 * every other customer's cargo on the trip. The RPC does the SUM() inside
 * Postgres, bypassing RLS for the aggregate only, and returns nothing more
 * granular than trip_id + total weight.
 *
 * excludeOrderId is handled here by subtracting that one order's OWN weight
 * (which the caller can always read under RLS, since the excluded order is
 * always the caller's own) from the RPC's true total — re-weighing an order
 * still compares the NEW weight against the trip without that order's OLD
 * weight, exactly as before.
 */
const getTripCurrentWeight = async (tripId, excludeOrderId = null) => {
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
 * Refuses cargo that would put a trip past its absolute ceiling — planned
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
 * PostgREST call still writes whatever it likes — `20260526010000` removed the
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
  // row already exists — but with empty data (no name, phone, address, etc.).
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
  // shape — the rate is still resolved because it is shown to the customer.
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

  // ── Non-blocking: notify admin(s) of new booking ──────────────────────────
  void createAdminNotification(
    'New Booking',
    `New order ${trackingNumber} from ${orderData.sender_name || 'Customer'}`,
    'order_update',
    data.id
  );

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
 * { 'Pending': 12, 'In Transit': 3, … } across every order — admin only.
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
      // BEFORE the order status is saved — so the order may still be 'Pending' or
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
      // truth — and every downstream figure (price, balance, the trip's own
      // load) is derived from that weight. An overloaded trip is a dispatch
      // problem to be solved by reassigning cargo, which the assign and
      // reassign paths police.
      void weight;
    }
    const pricePerKilo = trip ? await effectiveTripPrice(trip) : await getGlobalPricePerKilo();
    updates.shipping_cost = weight * pricePerKilo;
  }
  
  // ── Payment totals are NOT derived here ──────────────────────────────────
  // amount_paid / remaining_balance / payment_status are owned exclusively by
  // the payment_transactions ledger, via the update_order_payment_totals
  // trigger. This function used to compute them client-side, which competed
  // with that trigger and with PickupModal — three writers for three columns.
  // Money now flows through record_pickup_payment / record_delivery_payment
  // (atomic) or recordPaymentTransaction (ledger insert). See P0-1 in
  // docs/database-architecture-review.md.
  // ─────────────────────────────────────────────────────────────────────────

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
 * Admin cancels a booking outright, stating why.
 *
 * Distinct from reviewOrderCancellation, which rules on a request the customer
 * made. Here nobody asked — the admin is ending the booking — so the reason is
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
 * cached copy — this is the last line of defense before the write, not a
 * pre-flight convenience, so a stale `order` object sitting in a page that
 * hasn't refreshed cannot force a cancellation the current row no longer
 * allows. It only re-implements the same rule the admin console's button
 * visibility already enforces (canAdminCancelOrder); it is not a substitute
 * for a database-level guarantee, which would need a dedicated RPC — nothing
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
  if (fetchError) throw fetchError;

  if (!canAdminCancelOrder(current)) {
    throw new Error(
      current.status === ORDER_STATUS.PENDING_CANCELLATION
        ? 'This order has a cancellation request awaiting review. Approve or decline it instead.'
        : `An order that is "${current.status}" can no longer be cancelled — it has already left for the other island.`
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
 * user_id, on purpose — that is what lets a non-techy customer who doesn't
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
 * rules on it. `cancelOwnOrder` — which flipped the row straight to
 * 'Cancelled' with no reason recorded — is gone with the RPC behind it
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

  // The RPC creates the admin notification rows atomically. The Edge Function
  // validates ownership and derives the push text from the saved order, so the
  // customer cannot forge a staff push payload.
  await invokePushWithRetry(
    { event: 'cancellation_request', order_id: orderId, reference_id: orderId, notification_type: 'order_update' },
    'cancellation request',
  );

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

  // The RPC has already written the customer's in-app notification. Push is
  // a non-blocking delivery channel and is derived from the reviewed order on
  // the server.
  await invokePushWithRetry(
    {
      event: 'cancellation_review',
      order_id: orderId,
      approved: Boolean(approve),
      reference_id: orderId,
      notification_type: 'order_update',
    },
    'cancellation review',
  );

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
 * identically — the admin should not be able to tell which one caught it.
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
 * This is a courtesy check, not the enforcement — two admins submitting at once
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
  // Our own flag, not a trips column — pulled out before the insert below,
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
  if (data.origin && data.destination) {
    const { data: pendingOrders, error: pendingErr } = await supabase
      .from('orders')
      .select('id, actual_weight')
      .eq('status', 'Pending')
      .is('trip_id', null)
      .eq('origin', data.origin)
      .eq('destination', data.destination)
      .order('created_at', { ascending: true });

    if (!pendingErr && pendingOrders?.length) {
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
          .select('id, user_id, tracking_number');
        
        if (!updateErr && updated?.length) {
          autoAssignedCount = updated.length;
          
          // Loop through auto-assigned orders to write activity logs and notifications
          await Promise.all(updated.map(async (order) => {
            try {
              // Log the activity
              logOrder('Order Assigned', order.id, order.tracking_number, {
                previousValue: { status: 'Pending', trip_id: null },
                newValue: { status: 'Assigned', trip_id: data.id },
                details: `System auto-assigned to Trip ${tripNumber} during creation`
              });

              // Create notification
              await createNotification(
                order.user_id,
                'Order Assigned',
                `Your order ${order.tracking_number} has been assigned to Trip ${tripNumber}.`,
                'order_update',
                order.id
              );
            } catch (err) {
              console.warn(`Failed to notify/log for auto-assigned order ${order.id}`, err);
            }
          }));
        }
      }
    }
  }

  // Trip-schedule email blast. Reuses createAnnouncement exactly as the
  // admin's own Announcements page does — same insert, same in-app +
  // push fan-out, same non-blocking broadcast-announcement invocation.
  // The consent check (profiles.wants_announcements / contact_inquiries.
  // wants_announcements) lives entirely inside that Edge Function; nothing
  // here bypasses or duplicates it.
  if (announce_via_email) {
    try {
      await createAnnouncement({
        title: `Bagong Biyahe: ${data.origin} → ${data.destination}`,
        content: `Bagong Biyahe! Mayroon kaming bagong scheduled trip papuntang ${data.destination} sa ${formatPhDate(data.departure_date)}. I-secure na ang slot ng inyong cargo habang may space pa!`,
        send_email: true,
      });
    } catch (announceErr) {
      // Non-critical — the trip itself is already created and usable.
      console.warn('[createTrip] trip announcement failed to publish:', announceErr);
    }
  }

  return { ...data, autoAssignedCount };
};

export const getTrips = async (statusFilter) => {
  let query = supabase
    .from('trips')
    .select('*');

  if (statusFilter === 'active') {
    // Only 'scheduled' trips whose PH calendar day hasn't passed — mirrors
    // guard_customer_order_insert()'s ph_calendar_day() cutoff exactly (see
    // 20260829160000_trip_date_only_scheduling.sql), so a trip shown here is
    // never one the database would then reject at booking time.
    //
    // phDayRangeISO's `start` is PH midnight of "today" as an offset-
    // qualified ISO string. A bare "YYYY-MM-DD" string here would be read by
    // PostgREST as UTC midnight — 8 hours ahead of PH midnight — which would
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

  // ── Batch weight query (avoids N+1) ──────────────────────
  // get_trips_load (20260830000000_get_trips_load_rpc.sql) is a SECURITY
  // DEFINER RPC, not a direct `.from('orders')` select: RLS ("Users can view
  // own orders") only lets a customer read their own rows, so a direct query
  // here would sum only that one customer's cargo per trip and report every
  // trip as far emptier than it truly is. The RPC aggregates server-side
  // across ALL orders on the trip and returns just trip_id + total weight —
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
    // shipping_cost + amount_paid are what outstandingBalance() derives from —
    // the trip-completion guard reads that, not the stored remaining_balance,
    // so it agrees with the Unsettled tab. remaining_balance is still selected
    // for the settlement column's stale-value annotation.
    // user_id + the profiles embed back the "Message customer" shortcut on
    // each row. The trip's order table shows addresses, not the booker, so
    // without the embed there is no name to put on the control.
    .select('id, tracking_number, sender_name, receiver_name, user_id, status, actual_weight, sender_province, sender_city, receiver_province, receiver_city, created_at, shipping_cost, amount_paid, remaining_balance, payment_status, promised_payment_date, profiles:user_id (name)')
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
// departure_at set here — guard_trip_status_transition() stamps it to the
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

  // Cascade status to orders
  const TRIP_TO_ORDER = {
    'in_progress': 'In Transit',
    'arrived': 'Arrived at Hub',
    'cancelled': 'Cancelled',
  };

  if (updates.status && TRIP_TO_ORDER[updates.status]) {
    const orderStatus = TRIP_TO_ORDER[updates.status];
    let filter;
    
    if (updates.status === 'in_progress') {
      filter = ['Assigned', 'Picked Up'];
    } else if (updates.status === 'arrived') {
      filter = ['In Transit'];
    } else if (updates.status === 'cancelled') {
      filter = ['Pending', 'Assigned', 'Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery'];
    }

    if (filter) {
      await supabase
        .from('orders')
        .update({ status: orderStatus })
        .eq('trip_id', tripId)
        .in('status', filter);
    }
  }

  return data;
};

export const deleteTrip = async (tripId) => {
  const { error } = await supabase
    .from('trips')
    .delete()
    .eq('id', tripId);
  if (error) {
    // trips.id is ON DELETE SET NULL, so deleting a trip tries to null the
    // trip_id of every order aboard — which orders_trip_required_for_active_status
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
  // rather than updateOrder, which is why the check has to be repeated here —
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
 * being served — a schedule change from four months ago is not information,
 * it is clutter that pushes the current notice down the page.
 */
export const ANNOUNCEMENT_MAX_AGE_DAYS = 60;

/**
 * The live announcements: active, and posted within the last 60 days.
 *
 * The cutoff is applied here rather than at each call site because both
 * surfaces that read announcements — the customer HomePage feed and the admin
 * Announcements page — want the same answer. It does mean an admin stops
 * seeing announcements older than the window, which is intended: they are
 * already invisible to every customer, so there is nothing left to manage.
 * Nothing is deleted; the rows stay, they are just no longer served.
 */
export const getAnnouncements = async () => {
  const cutoff = new Date(Date.now() - ANNOUNCEMENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('announcements')
    .select(`*, profiles:author_id (name)`)
    .eq('is_active', true)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false });
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

  // ── Non-blocking notification fan-out ────────────────────────────────────
  // We intentionally do NOT await this. Notifying all customers can take
  // several seconds with many users. The announcement is already saved;
  // notifications are a best-effort side effect and should never block the UI.
  void (async () => {
    try {
      const { data: customers } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'customer');

      if (customers && customers.length > 0) {
        const notifications = customers.map(c => ({
          user_id: c.id,
          title: 'New Announcement',
          message: announcement.title,
          type: 'announcement',
          reference_id: data.id,
        }));
        await supabase.from('notifications').insert(notifications);

        // Send push notifications via Edge Function in a single broadcast call
        await invokePushWithRetry(
          {
            user_id: 'all_customers',
            title: 'New Announcement',
            body: announcement.title,
            url: '/customer/notifications',
            reference_id: data.id,
            notification_type: 'announcement',
          },
          'announcement',
        );
      }
    } catch (notifErr) {
      // Non-critical — log but do not surface to the user
      // Notification fan-out is non-critical — announcement still created
    }
  })();

  // ── Non-blocking email broadcast ─────────────────────────────────────────
  // Same reasoning as the push fan-out above: emailing every opted-in
  // subscriber can take a while and is best-effort. The announcement is
  // already saved and visible in-app regardless of whether this succeeds.
  // The Edge Function re-checks the caller is an admin itself — it does not
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

/**
 * Post a comment on an announcement.
 *
 * Customers hold SELECT on `announcements` and nothing else, so this cannot be
 * an UPDATE from here — `add_announcement_comment` is SECURITY DEFINER and
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
 * now() is the transaction timestamp — so a customer with two parcels on the
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
};

export const markAllNotificationsRead = async (userId) => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) throw error;
};

export const deleteNotification = async (id) => {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', id);
  if (error) throw error;
};

export const deleteAllNotifications = async (userId) => {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId);
  if (error) throw error;
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
 * Fetch paginated, server-side filtered customer profiles.
 * @param {Object} options - { page, perPage, search }
 * @returns {{ data: Array, count: number }}
 */
export const getCustomers = async (options = {}) => {
  const { page = 1, perPage = 15, search = '' } = options;

  let query = supabase
    .from('profiles')
    .select('id, name, email, phone, address_province, created_at', { count: 'exact' })
    .eq('role', 'customer')
    .order('created_at', { ascending: false });

  if (search && search.trim()) {
    const term = search.trim();
    query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,address_province.ilike.%${term}%`);
  }

  const from = (page - 1) * perPage;
  const to = from + perPage - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { data: data || [], count: count || 0 };
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
  // ── Run all count queries in parallel with Promise.allSettled ─────────────
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
    .select('id, tracking_number, created_at, status, shipping_cost, payment_method, amount_paid, remaining_balance, payment_status')
    .neq('status', 'Cancelled');

  const orders = allOrders || [];
  // Revenue is what was billed; paidTotal is what was collected. Matches
  // get_sales_summary() so the fallback and the RPC do not report different
  // numbers for the same tile.
  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.shipping_cost || 0), 0);
  const paidTotal = orders.reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0);

  // Collections are split by the LEDGER's payment_method, not the order's —
  // orders.payment_method only records the most recent payment event, so an
  // order picked up on GCash and settled in cash would file both payments
  // under cash. Mirrors get_sales_summary(); see 20260806020000.
  const orderIds = orders.map(o => o.id);
  const { methodTotals, ledgerTotal } = await sumTransactionsByMethod(orderIds);
  const cashTotal = methodTotals.cash || 0;
  const gcashTotal = methodTotals.gcash || 0;
  const paylaterTotal = methodTotals.paylater || 0;
  // ONE definition of "outstanding", derived — never the stored
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
    monthlyMap[month].total_revenue += parseFloat(o.shipping_cost || 0);
    monthlyMap[month].collected += parseFloat(o.amount_paid || 0);
    monthlyMap[month].outstanding += outstandingOf(o);
  });
  const monthlySales = Object.values(monthlyMap).sort((a, b) => b.month.localeCompare(a.month));

  return {
    summary: {
      totalRevenue,
      cashTotal,
      gcashTotal,
      paylaterTotal,
      methodTotals: Object.entries(methodTotals).map(([method, total]) => ({ method, total })),
      ledgerTotal,
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
 * Only 'paid'/'partial' rows are counted — the same predicate
 * update_order_payment_totals uses to derive orders.amount_paid, so the split
 * reconciles against the total instead of drifting from it.
 *
 * @returns {Promise<{ methodTotals: Record<string, number>, ledgerTotal: number, methodCounts: Record<string, number> }>}
 */
const sumTransactionsByMethod = async (orderIds) => {
  const methodTotals = {};
  const methodCounts = {};
  let ledgerTotal = 0;
  if (!orderIds || orderIds.length === 0) return { methodTotals, ledgerTotal, methodCounts };

  const CHUNK = 200;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const { data } = await supabase
      .from('payment_transactions')
      .select('amount, payment_method, payment_status')
      .in('order_id', orderIds.slice(i, i + CHUNK))
      .in('payment_status', ['paid', 'partial']);

    (data || []).forEach(t => {
      const method = (t.payment_method || '').trim().toLowerCase() || 'unspecified';
      const amount = parseFloat(t.amount || 0);
      methodTotals[method] = (methodTotals[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      ledgerTotal += amount;
    });
  }

  return { methodTotals, ledgerTotal, methodCounts };
};

// ==================== UNSETTLED DELIVERIES ====================

/**
 * Settlement buckets — why an order still owes money, in the operational
 * sense the admin acts on. Derived from the same three columns the Phase 1b
 * guards read (status, payer_type, promised_payment_date), so what this list
 * shows and what the database will refuse to dispatch cannot drift apart.
 */
export const SETTLEMENT_BUCKETS = {
  HELD: 'held',              // Arrived at Hub, prepaid, no promise → dispatch BLOCKED by guard_order_update
  OVERDUE: 'overdue',        // A promise date that has already passed
  PROMISED: 'promised',      // Dispatched on a promise that is still in the future
  DELIVERED: 'delivered',    // Cargo handed over, balance still owing
  COLLECT: 'collect',        // Freight collect, in flight — due at the door, not late
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
  const promised = order.promised_payment_date ? new Date(`${order.promised_payment_date}T00:00:00`) : null;
  const isOverdue = promised && promised < today;
  const isCollect = (order.payer_type || 'sender') === 'receiver';

  if (isOverdue) return SETTLEMENT_BUCKETS.OVERDUE;
  if (order.status === 'Delivered') return SETTLEMENT_BUCKETS.DELIVERED;
  if (promised) return SETTLEMENT_BUCKETS.PROMISED;
  if (order.status === 'Arrived at Hub' && !isCollect) return SETTLEMENT_BUCKETS.HELD;
  if (isCollect) return SETTLEMENT_BUCKETS.COLLECT;
  return SETTLEMENT_BUCKETS.IN_FLIGHT;
};

/**
 * Every non-cancelled order that still owes money, for the admin settlement
 * list. Admin-only by RLS (`orders` grants admins full read); no widened
 * anon access and no new RPC needed.
 *
 * Only orders that have actually been picked up are included — a booking that
 * has not been weighed yet has a placeholder balance, not a receivable.
 *
 * WHAT COUNTS AS OWING (widened 2026-08-04):
 *   outstanding = MAX(0, shipping_cost - amount_paid)
 *
 * `remaining_balance` is not used as the filter. It is trigger-derived and
 * correct on every row the current triggers have touched, but legacy rows
 * predating them can carry NULL — and `.gt('remaining_balance', 0)` drops
 * NULLs silently, hiding genuinely unpaid old cargo. Deriving the figure from
 * the two columns that are always populated catches those rows.
 *
 * PostgREST cannot compare two columns in a filter, so the arithmetic happens
 * here and the query narrows by status only.
 *
 * Rows where the stored and derived figures disagree are flagged
 * `balance_mismatch` — that is a stale ledger total worth a human look, not
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
    .select('id, tracking_number, sender_name, sender_phone, receiver_name, user_id, status, payment_status, payment_method, payer_type, promised_payment_date, shipping_cost, amount_paid, remaining_balance, actual_weight, origin, destination, created_at, trip_id, profiles:user_id (name, phone, email)')
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
 * that arrived through the query — otherwise a payment that lands while the
 * admin is watching would render differently from the same payment after a
 * refresh.
 *
 * @param {Object} order  raw orders row
 * @param {Date}   [today] midnight reference; pass one instant for a whole list
 * @returns {{outstanding: number, balance_mismatch: boolean,
 *            settlement_bucket: string, days_overdue: number}}
 */
export const deriveSettlement = (order, today = null) => {
  const ref = today || (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

  // Shared with the dispatch gate, the admin badges and get_sales_summary() —
  // one implementation of "what is owed", so no two views can disagree.
  const outstanding = outstandingBalance(order);
  const stored = order.remaining_balance == null ? null : parseFloat(order.remaining_balance);

  let daysOverdue = 0;
  if (order.promised_payment_date) {
    const promised = new Date(`${order.promised_payment_date}T00:00:00`);
    daysOverdue = Math.max(0, Math.floor((ref - promised) / 86400000));
  }

  return {
    outstanding,
    // NULL is the legacy case the widening exists for — not a mismatch to
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
    // Insert error is non-critical — the ledger/order write that spawned this
    // notification has already succeeded, and a failed notice must not roll
    // the user's action back.
  } catch {
    // Network-level failure is non-critical for the same reason. Every caller
    // AWAITS this function before closing a modal or finishing a cascade, so
    // a rejected fetch here would block the pickup/delivery/status operation
    // for a notice nobody is waiting on.
  }

  await invokePushWithRetry(
    {
      user_id: userId,
      title,
      body: message,
      url: '/customer/notifications',
      notification_id: notificationId,
      reference_id: referenceId,
      notification_type: type,
    },
    `${type} notification`,
  );

  return notificationId;
};

export const createAdminNotification = async (title, message, type = 'general', referenceId = null) => {
  void (async () => {
    try {
      const { data: notifiedAdmins, error } = await supabase.rpc('create_admin_notifications_rpc', {
        p_title: title,
        p_message: message,
        p_type: type,
        p_reference_id: referenceId
      });

      if (error) throw error;
      if (!notifiedAdmins || notifiedAdmins.length === 0) return;

      // Use only the server-generated notification payload. The caller's
      // title/message are customer-controlled and must never reach a staff
      // push notification, even though the RPC ignores them for the in-app
      // notification row.
      await Promise.all(notifiedAdmins.filter(row => row.admin_id).map(row => invokePushWithRetry(
        {
          user_id: row.admin_id,
          title: row.notification_title || 'New admin notification',
          body: row.notification_message || 'Open the admin dashboard to review this update.',
          url: '/admin',
          notification_id: row.notification_id || null,
          reference_id: referenceId,
          notification_type: type,
        },
        `${type} admin notification`,
      )));
    } catch {
      // Admin notification fan-out is non-critical
    }
  })();
};

// ==================== CONTACT INQUIRIES ====================
/**
 * Submit a public contact inquiry.
 *
 * @param {Object} data
 * @param {string} data.name
 * @param {string} data.message
 * @param {string} [data.contact_phone] — mobile number, if supplied
 * @param {string} [data.contact_email] — email address, if supplied
 * @param {boolean} [data.wants_announcements] — opted in to trip/promo/announcement emails
 *
 * Writes the normalized contact_phone/contact_email columns and, for this
 * release only, keeps the legacy polymorphic `phone` column in sync so a
 * rollback loses nothing. `phone` is deprecated — see
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

export const getContactInquiries = async () => {
  const { data, error } = await supabase
    .from('contact_inquiries')
    .select('*, assigned_admin:assigned_admin_id (name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

/**
 * Claim an inquiry. Ownership is the whole point of Phase 1d: without it
 * nobody is answerable, and two admins can answer the same person.
 * `first_response_at` is stamped by trigger on the status change, not here.
 *
 * `.is('assigned_admin_id', null)` is the actual enforcement, not the UI that
 * calls this. Without it, two admins opening the same unclaimed inquiry
 * within the same round trip both "succeed" and whoever's write lands last
 * silently steals the other's claim — the exact failure this feature exists
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
      payer_type: attempt.payer_type || 'sender',
      pickup_photos: attempt.pickup_photos || [],
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

/** Latest PayMongo attempt for an order — the source the return path should poll. */
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
  // Try to find existing — use .limit(1) instead of .single() to avoid
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
  // This used to insert 'closed' — the same value an admin wrote when they
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
 * human sets is `resolved` — see 20260804260000_simplify_conversation_states.
 */
export const CONVERSATION_STATUS = {
  BOT_ACTIVE: 'bot_active',            // bot handling; new chat or a returning customer
  WAITING: 'waiting',                  // customer spoke last — OUR TURN, the queue
  WAITING_CUSTOMER: 'waiting_customer',// an admin spoke last — their turn
  RESOLVED: 'resolved',                // an admin said so; the only manual state
};

/**
 * Inbox ordering, shared by the initial fetch and the realtime updates so a
 * live change cannot reshuffle the list differently from a reload.
 * Waiting first — that is the whole point of the queue — then oldest wait
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
 * can disagree with the server's near the boundary — which is why the send path
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
// `.in()` takes an array and does not accept a query builder — passing one made
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
 * Scoped to conversations in 'waiting' — the state the trigger sets when the
 * customer spoke last AND a human owns the thread. Everything the bot handled
 * while the conversation sat in 'bot_active' is excluded, which is the whole
 * point: those messages were answered, just not by a person, and counting them
 * inflated the inbox badge to the size of total chat traffic. An admin looking
 * at "23" had no way to know that 20 of them were already resolved.
 *
 * Same PostgREST inner-join embed as getCustomerUnreadChatCount — one round
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
export const getReportData = async (period = 'daily', customStart = null, customEnd = null) => {
  const now = new Date();

  // Filter orders by period
  let startDate, endDate, periodLabel;
  if (customStart && customEnd) {
    startDate = new Date(customStart);
    endDate = new Date(customEnd);
    endDate.setHours(23, 59, 59, 999);
    periodLabel = `${startDate.toLocaleDateString('en-PH')} – ${endDate.toLocaleDateString('en-PH')}`;
  } else {
    switch (period) {
      case 'daily':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        periodLabel = `Today — ${now.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
        break;
      case 'weekly': {
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
        endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 6);
        endDate.setHours(23, 59, 59, 999);
        periodLabel = `Week of ${startDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })} – ${endDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        break;
      }
      case 'monthly':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        periodLabel = now.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
        break;
      case 'yearly':
        startDate = new Date(now.getFullYear(), 0, 1);
        endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
        periodLabel = `Year ${now.getFullYear()}`;
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        periodLabel = 'Today';
    }
  }

  const { data: filteredOrders, error } = await supabase
    .from('orders')
    .select(`
      id, tracking_number, user_id, trip_id, origin, destination,
      sender_name, status, actual_weight, shipping_cost,
      amount_paid, remaining_balance, payment_method, created_at,
      profiles:user_id (name, email, phone)
    `)
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString())
    .order('created_at', { ascending: false });
  if (error) throw error;

  const filtered = filteredOrders || [];

  // Summary calculations
  const totalOrders = filtered.length;
  const delivered = filtered.filter(o => o.status === 'Delivered');
  const cancelled = filtered.filter(o => o.status === 'Cancelled');
  const pending = filtered.filter(o => o.status === 'Pending');
  const inTransit = filtered.filter(o => ['In Transit', 'Picked Up', 'Assigned', 'Arrived at Hub', 'Out for Delivery'].includes(o.status));
  const totalRevenue = filtered.filter(o => o.status !== 'Cancelled').reduce((s, o) => s + parseFloat(o.amount_paid || 0), 0);
  const totalCollected = filtered.reduce((s, o) => s + parseFloat(o.amount_paid || 0), 0);
  const totalOutstanding = filtered.filter(o => o.status !== 'Cancelled').reduce((s, o) => s + outstandingBalance(o), 0);
  const totalWeight = filtered.filter(o => o.status !== 'Cancelled').reduce((s, o) => s + parseFloat(o.actual_weight || 0), 0);

  // Payment breakdown — from the ledger, grouped by each transaction's own
  // payment_method. orders.payment_method holds only the most recent payment
  // event, so bucketing the cumulative amount_paid by it misattributes every
  // order that paid twice by two different methods (see 20260806020000).
  // Counts are payments, not orders: one order can appear in two buckets.
  const activeOrders = filtered.filter(o => o.status !== 'Cancelled');
  const { methodTotals, ledgerTotal, methodCounts } = await sumTransactionsByMethod(
    activeOrders.map(o => o.id)
  );
  // Reconcile against the same population the ledger sum covers, so a
  // cancelled order's payments cannot masquerade as unattributed money.
  const collectedOnActiveOrders = activeOrders.reduce((s, o) => s + parseFloat(o.amount_paid || 0), 0);

  // Route breakdown
  const routeMap = {};
  filtered.filter(o => o.status !== 'Cancelled').forEach(o => {
    const key = `${o.origin || 'N/A'} → ${o.destination || 'N/A'}`;
    if (!routeMap[key]) routeMap[key] = { route: key, count: 0, revenue: 0, weight: 0 };
    routeMap[key].count++;
    routeMap[key].revenue += parseFloat(o.amount_paid || 0);
    routeMap[key].weight += parseFloat(o.actual_weight || 0);
  });
  const routeBreakdown = Object.values(routeMap).sort((a, b) => b.count - a.count);

  // Status breakdown
  const statusMap = {};
  filtered.forEach(o => {
    statusMap[o.status] = (statusMap[o.status] || 0) + 1;
  });

  return {
    periodLabel,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    generatedAt: new Date().toISOString(),
    summary: {
      totalOrders,
      deliveredCount: delivered.length,
      cancelledCount: cancelled.length,
      pendingCount: pending.length,
      inTransitCount: inTransit.length,
      totalRevenue,
      totalCollected,
      totalOutstanding,
      totalWeight,
      cashCount: methodCounts.cash || 0,
      cashTotal: methodTotals.cash || 0,
      gcashCount: methodCounts.gcash || 0,
      gcashTotal: methodTotals.gcash || 0,
      paylaterCount: methodCounts.paylater || 0,
      paylaterTotal: methodTotals.paylater || 0,
      methodTotals: Object.entries(methodTotals).map(([method, total]) => ({
        method,
        total,
        count: methodCounts[method] || 0,
      })),
      ledgerTotal,
      unattributedTotal: Math.max(collectedOnActiveOrders - ledgerTotal, 0),
    },
    statusBreakdown: statusMap,
    routeBreakdown,
    orders: filtered,
  };
};

// ==================== ACTIVITY LOGS ====================

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

  if (module) query = query.eq('module', module);
  if (action) query = query.ilike('action', `%${action}%`);
  if (adminId) query = query.eq('admin_id', adminId);
  if (dateFrom) query = query.gte('created_at', dateFrom);
  if (dateTo) query = query.lte('created_at', dateTo);
  if (hideLogins) query = query.not('action', 'ilike', '%Logged In%');
  if (search) query = query.or(`action.ilike.%${search}%,record_ref.ilike.%${search}%,admin_name.ilike.%${search}%,details.ilike.%${search}%`);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { logs: data || [], total: count || 0, page, pageSize };
};

/**
 * Fetch all activity log entries for a specific record (order/trip) for in-page timeline display.
 */
export const getActivityLogsByRecord = async (recordId) => {
  if (!recordId) return [];
  const { data, error } = await supabase
    .from('activity_logs')
    .select('*')
    .eq('record_id', recordId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
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
 * goes through an RPC that returns only status + timestamp — no names, no
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

    // Log the activity
    logOrder(`Status Changed to ${newStatus}`, order.id, order.tracking_number, {
      previousValue: { status: order.status },
      newValue: { status: newStatus },
      details: actionDescription || `Bulk update via Trip ${tripId}`
    });

    // Create notification
    await createNotification(
      order.user_id,
      'Order Updated',
      `Your order ${order.tracking_number} status has been updated to ${newStatus}`,
      'order_update',
      order.id
    );
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
 * Never pass amount_paid / remaining_balance / payment_status — the ledger
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
 * @param {?Object} [payload.payment] — { amount, payment_date, receipt_url }.
 *                  Null when a PayMongo QR is still pending; the webhook
 *                  records that payment into the ledger instead.
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
  });
  if (error) throw error;
  return data;
};

/**
 * Atomically record a delivery: order metadata UPDATE + optional balance
 * settlement in one transaction. Same contract as recordPickupPayment.
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
    // still owing — see 20260804100000_settlement_guards.sql.
    p_promised_payment_date: payload.promised_payment_date || null,
  });
  if (error) throw error;
  return data;
};

/**
 * Record a counter payment against an existing balance.
 *
 * This function is the ONE writer of the activity entry for such a payment.
 * Callers must not log their own: UnsettledDeliveriesPage used to add a
 * "Balance Settled" line on top of the "Full Payment Completed" written here,
 * so a single collection produced two entries that disagreed about what
 * happened. Pass `source` to record WHERE it was collected from instead.
 */
export const recordAdditionalPayment = async (orderId, amount, method, ref, notes, paymentDate = null, receiptUrl = null, skipInsert = false, source = null) => {
  const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
  if (!order) throw new Error('Order not found');

  const previousPaid = parseFloat(order.amount_paid || 0);
  const previousBalance = parseFloat(order.remaining_balance || order.shipping_cost || 0);

  if (!skipInsert) {
    // Determine the status for the transaction log based on the current balance
    const diff = previousBalance - parseFloat(amount);
    const newBalance = Math.max(0, Math.round(diff * 100) / 100);
    let txStatus = newBalance <= 0 ? 'paid' : 'partial';
    
    // Insert into payment_transactions. The DB trigger will automatically update orders.
    const pType = newBalance <= 0 && previousBalance > 0 ? 'Balance Settlement' : 'Additional Payment';
    await recordPaymentTransaction(orderId, amount, method, ref, txStatus, notes, pType, paymentDate, receiptUrl);
  }

  // Fetch the fresh order to get the accurately recalculated totals from the DB trigger
  const { data: freshOrder, error: fetchErr } = await supabase.from('orders').select('*').eq('id', orderId).single();
  if (fetchErr) throw fetchErr;

  // Outstanding is the DERIVED figure, never the stored remaining_balance,
  // which can lag the ledger write this function just triggered. Reading the
  // stored column here could name the entry "Additional Payment Recorded" for
  // a payment that in fact settled the order.
  const newOutstanding = outstandingBalance(freshOrder);
  const settled = newOutstanding <= 0 && previousBalance > 0;

  // One entry, one name. "Payment Completed" when this payment cleared the
  // balance, otherwise "Additional Payment Recorded" — never both.
  const actionName = settled ? 'Payment Completed' : 'Additional Payment Recorded';

  logPayment(actionName, orderId, order.tracking_number, {
    previousValue: { amount_paid: previousPaid, remaining_balance: previousBalance },
    newValue: { amount_paid: freshOrder.amount_paid, remaining_balance: newOutstanding },
    details: `Collected ₱${amount} via ${method}${source ? ` from ${source}` : ''}. ${
      settled ? 'Balance fully settled.' : `Balance is now ₱${newOutstanding}.`
    }`,
  });

  return { 
    newAmountPaid: freshOrder.amount_paid, 
    newBalance: freshOrder.remaining_balance, 
    newStatus: freshOrder.payment_status 
  };
};

export const getPaymentTransactions = async (orderId) => {
  const { data, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
};

/**
 * C-3 fix: Batch-fetch payment transactions for multiple orders in a single query.
 * Replaces the N+1 pattern of calling getPaymentTransactions() per order.
 * @param {string[]} orderIds - Array of order IDs to fetch transactions for.
 * @returns {Object} Map of orderId -> transaction[]
 */
export const getPaymentTransactionsBatch = async (orderIds) => {
  if (!orderIds || orderIds.length === 0) return {};
  const { data, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .in('order_id', orderIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  // Group by order_id
  const grouped = {};
  for (const tx of data || []) {
    if (!grouped[tx.order_id]) grouped[tx.order_id] = [];
    grouped[tx.order_id].push(tx);
  }
  return grouped;
};

// ==================== CHAT EXTENSIONS ====================

// Conversation ASSIGNMENT is gone (20260808150000). `assignConversation`,
// `unassignConversation` and `reassignConversation` all wrote
// conversations.assigned_admin_id, a column that no longer exists — support
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
 * Not final — if the customer writes again the trigger returns the
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
 * `bot_resolved` starts NULL — "we do not know". 12 of the conversations in
 * the service study ended with a bot reply and no human follow-up, and
 * success (the bot deflected the question) was indistinguishable from
 * failure (the customer gave up). This is the one signal that separates
 * them, and it comes from the only party who knows: the customer.
 *
 * Written on every vote, including repeat votes in a long conversation —
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
 * `escalated` flag — status answers "whose turn", escalated answers
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


// ── Coverage helpers (JSONB on company_information) ──────────────────────────
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

  // ── Non-blocking: notify admin(s) of new feedback ───────────────────────
  void createAdminNotification(
    'New Customer Feedback',
    `${rating}★ rating${message ? ': ' + message.slice(0, 60) : ''}`,
    'feedback',
    orderId
  );

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
 * policies that exposed customer_id — a stable identifier linking a public
 * review to a user account — to anonymous visitors. The RPC never returns it
 * and masks the author name via mask_name().
 *
 * The flat RPC rows are re-shaped into the nested { profiles, orders } form
 * the page already consumes, so rendering is unchanged.
 *
 * Note: authors now actually have names. The old PostgREST embed
 * profiles:customer_id(name) returned NULL for anon (profiles RLS blocks it),
 * so every public testimonial rendered as "Customer".
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
      featured_on_website: row.featured_on_website,
      featured_image_type: row.featured_image_type,
      featured_photo: row.featured_photo,   // single admin-selected path (replaces pickup/delivery arrays)
      receiver_city: row.receiver_city,
      receiver_province: row.receiver_province,
    },
  }));
};

/**
 * Featured delivery gallery for the About page.
 *
 * Goes through the get_featured_deliveries() RPC. The RPC returns a single
 * `featured_photo` TEXT path (the admin-selected pickup or delivery proof)
 * instead of the full pickup_photos / delivery_photos JSONB arrays, preventing
 * enumeration of all proof photos for a featured order via the anon key.
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
 * both — which is why proof photos ended up publicly reachable.
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

// ── Public tracking (wraps the anon RPC so pages never touch supabase directly) ──
export const getPublicTrackingResult = async (trackingNumber) => {
  const { data, error } = await supabase
    .rpc('track_order_public', { p_tracking_number: trackingNumber })
    .maybeSingle();
  if (error) throw error;
  return data;
};

// ── Profile self-service update (moved out of PersonalInfoPage) ──
export const updateOwnProfile = async (userId, fields) => {
  const { error } = await supabase
    .from('profiles')
    .update(fields)
    .eq('id', userId);
  if (error) throw error;
};

// ── Admin inbox directory search (moved out of InboxPage) ──
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

// ── PayMongo reconcile helpers (moved out of PaymentCollectionPanel / AdditionalPaymentModal) ──
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

// ── New-inquiry badge count (moved out of Sidebar) ──
export const getNewInquiryCount = async () => {
  const { count, error } = await supabase
    .from('contact_inquiries')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new');
  if (error) throw error;
  return count || 0;
};

// ── Receipt-cleanup step of Manual Evidence Cleanup (moved out of admin ODP) ──
export const clearPaymentReceiptUrls = async (orderId) => {
  const { error } = await supabase
    .from('payment_transactions')
    .update({ receipt_url: null })
    .eq('order_id', orderId);
  if (error) throw error;
};

// â”€â”€ Admin photo-storage monitoring and new-upload routing â”€â”€
export const getPhotoStorageMode = async () => {
  const { data, error } = await supabase.rpc('get_effective_photo_storage_mode');
  if (error) throw error;
  return data?.[0] || null;
};

export const setPhotoStorageMode = async (uploadMode, reason = null, expiresAt = null) => {
  const { data, error } = await supabase.rpc('set_photo_storage_mode', {
    p_upload_mode: uploadMode,
    p_reason: reason,
    p_force_firebase_expires_at: expiresAt,
  });
  if (error) throw error;
  return data?.[0] || null;
};

export const getPhotoStorageSummary = async () => {
  const { data, error } = await supabase.rpc('get_photo_storage_summary');
  if (error) throw error;
  return data?.[0] || null;
};

export const getPhotoStorageEvents = async (limit = 50) => {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  const { data, error } = await supabase
    .from('photo_storage_events')
    .select('id, event_type, provider, outcome, photo_type, order_id, storage_path, size_bytes, message, metadata, created_at, created_by, profiles:created_by(name, email)')
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error) throw error;
  return data || [];
};

export const checkPhotoStorageHealth = async () => {
  const { data, error } = await supabase.functions.invoke('photo-storage-health');
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
};

// Scans pickup-proofs/delivery-proofs/receipts for evidence whose
// tracking-number folder no longer matches an order, and deletes it. The
// list of what qualifies is computed server-side (list_orphaned_evidence_photos)
// — this call never sends paths, so there is nothing here for a caller to redirect.
export const cleanupOrphanedPhotos = async () => {
  const { data, error } = await supabase.functions.invoke('cleanup-orphaned-photos');
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
};
