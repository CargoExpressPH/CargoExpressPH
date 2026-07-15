import { supabase } from './supabase';
import { logOrder, logPayment, logChat } from './activityLog';
import { validateStatusTransition } from '../constants/status';
import { detectPickupLocation } from '../constants/phLocations';

// ==================== HELPER ====================
// ─────────────────────────────────────────────────────────────────────────────
// withTimeout is now a pass-through.
// Timeouts and automatic retries are now handled globally by the custom fetch
// wrapper in supabase.js (45 seconds timeout + 3 retries).
// ─────────────────────────────────────────────────────────────────────────────
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

const getTripCurrentWeight = async (tripId, excludeOrderId = null) => {
  if (!tripId) return 0;
  let query = supabase
    .from('orders')
    .select('id, actual_weight, package_weight')
    .eq('trip_id', tripId)
    .neq('status', 'Cancelled');

  if (excludeOrderId) query = query.neq('id', excludeOrderId);

  const { data, error } = await query;
  if (error) throw error;

  return (data || []).reduce(
    (sum, order) => sum + parseFloat(order.actual_weight || order.package_weight || 0),
    0
  );
};

const assertTripCapacity = async (trip, incomingWeight, excludeOrderId = null) => {
  // Removed strict capacity blocking. The UI now only serves as a visual 
  // tracker, allowing administrators to intentionally exceed capacity limits.
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

  const weight = parseFloat(orderData.package_weight) || 0;
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

  if (statusFilter && statusFilter !== 'All') {
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

export const getOrderById = async (orderId) => {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      profiles:user_id (name, phone, email),
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
      .select('status, trip_id, actual_weight, package_weight, amount_paid, shipping_cost')
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
        const validation = validateStatusTransition(currentOrder.status, updates.status, tripId);
        if (!validation.valid) {
          throw new Error(validation.error);
        }
      }
    }
  }

  if (!currentOrder && (updates.trip_id !== undefined || updates.actual_weight !== undefined || updates.amount_paid !== undefined)) {
    const { data } = await supabase
      .from('orders')
      .select('status, trip_id, actual_weight, package_weight, amount_paid, shipping_cost')
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
      updates.actual_weight ?? currentOrder?.actual_weight ?? currentOrder?.package_weight ?? 0,
      orderId
    );
  }

  // If actual_weight changed, recalculate shipping cost
  if (updates.actual_weight !== undefined) {
    let trip = null;
    const tripId = updates.trip_id || currentOrder?.trip_id;
    if (tripId) {
      const { data: tripData } = await supabase
        .from('trips')
        .select('id, capacity, price_per_kg')
        .eq('id', tripId)
        .single();
      trip = tripData;
      await assertTripCapacity(trip, updates.actual_weight, orderId);
    }
    const pricePerKilo = trip ? await effectiveTripPrice(trip) : await getGlobalPricePerKilo();
    
    const weight = parseFloat(updates.actual_weight);
    updates.shipping_cost = weight * pricePerKilo;
  }
  
  // Recalculate balance if shipping_cost or amount_paid changed —
  // but only when the caller did NOT explicitly provide remaining_balance.
  // PickupModal always passes remaining_balance for GCash Pay Later orders,
  // and overwriting it here was silently zeroing out unpaid balances.
  if ((updates.shipping_cost !== undefined || updates.amount_paid !== undefined) && updates.remaining_balance === undefined) {
    const newCost = updates.shipping_cost ?? currentOrder?.shipping_cost ?? 0;
    const amtPaid = parseFloat(updates.amount_paid ?? currentOrder?.amount_paid ?? 0) || 0;
    updates.remaining_balance = Math.max(0, newCost - amtPaid);
    if (updates.remaining_balance <= 0) {
      updates.payment_status = 'paid';
    } else if (amtPaid > 0) {
      updates.payment_status = 'partial';
    } else {
      updates.payment_status = 'unpaid';
    }
  }

  const { data, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', orderId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const cancelOwnOrder = async (orderId) => {
  const { data, error } = await supabase.rpc('cancel_own_pending_order', {
    p_order_id: orderId,
  });
  if (error) throw error;
  return data;
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
export const createTrip = async (tripData) => {
  const tripNumber = generateTripNumber();
  
  const { data: user } = await supabase.auth.getUser();
  
  const { data, error } = await supabase
    .from('trips')
    .insert({
      ...tripData,
      trip_number: tripNumber,
      available_slots: tripData.capacity || 1000,
      created_by: user?.user?.id || null,
    })
    .select()
    .single();
  if (error) throw error;

  // Auto-assign pending orders matching this route
  let autoAssignedCount = 0;
  if (data.origin && data.destination) {
    const { data: pendingOrders, error: pendingErr } = await supabase
      .from('orders')
      .select('id, actual_weight, package_weight')
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
        const weight = parseFloat(order.actual_weight || order.package_weight || 0);
        if (capacity > 0 && plannedWeight + weight > capacity) continue;
        plannedWeight += weight;
        selectedIds.push(order.id);
      }

      if (selectedIds.length > 0) {
        const { data: updated } = await supabase
          .from('orders')
          .update({ trip_id: data.id, status: 'Assigned' })
          .in('id', selectedIds)
          .select('id');
        autoAssignedCount = updated?.length || 0;
      }
    }
  }

  return { ...data, autoAssignedCount };
};

export const getTrips = async (statusFilter) => {
  let query = supabase
    .from('trips')
    .select('*')
    .order('departure_date', { ascending: false });

  if (statusFilter === 'active') {
    query = query.in('status', ['scheduled', 'in_progress']);
  } else if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  const { data, error } = await query;
  if (error) throw error;

  const trips = data || [];
  if (trips.length === 0) return trips;

  // ── Batch weight query (avoids N+1) ──────────────────────
  const tripIds = trips.map(t => t.id);
  if (tripIds.length > 0) {
    const { data: allWeightData } = await supabase
      .from('orders')
      .select('trip_id, actual_weight, package_weight')
      .in('trip_id', tripIds)
      .neq('status', 'Cancelled');

    const weightByTrip = new Map();
    for (const row of allWeightData || []) {
      const prev = weightByTrip.get(row.trip_id) || 0;
      weightByTrip.set(row.trip_id, prev + parseFloat(row.actual_weight || row.package_weight || 0));
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
    .select('id, tracking_number, sender_name, receiver_name, status, package_weight, actual_weight, sender_province, sender_city, receiver_province, receiver_city, created_at')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true });

  const currentWeight = (orders || [])
    .filter(o => o.status !== 'Cancelled')
    .reduce((sum, o) => sum + parseFloat(o.actual_weight || o.package_weight || 0), 0);

  return { trip, orders: orders || [], current_weight: currentWeight };
};

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
  if (error) throw error;
};

export const reassignTrip = async (orderId, newTripId, reason) => {
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
export const getAnnouncements = async () => {
  const { data, error } = await supabase
    .from('announcements')
    .select(`*, profiles:author_id (name)`)
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
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
      }
    } catch (notifErr) {
      // Non-critical — log but do not surface to the user
      // Notification fan-out is non-critical — announcement still created
    }
  })();

  return data;
};

export const deleteAnnouncement = async (id) => {
  const { error } = await supabase
    .from('announcements')
    .update({ is_active: false })
    .eq('id', id);
  if (error) throw error;
};

// ==================== NOTIFICATIONS ====================
export const getNotifications = async (userId) => {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
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
export const getCustomers = async () => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('role', 'customer')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
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
    .reduce((sum, o) => sum + parseFloat(o.shipping_cost || 0), 0) || 0;

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
      .select('actual_weight, package_weight')
      .eq('trip_id', activeTrip.id)
      .neq('status', 'Cancelled');

    totalWeight = (orders || []).reduce((sum, o) =>
      sum + parseFloat(o.actual_weight || o.package_weight || 0), 0);
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
  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.shipping_cost || 0), 0);
  const cashTotal = orders.filter(o => o.payment_method === 'cash').reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0);
  const gcashTotal = orders.filter(o => o.payment_method === 'gcash').reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0);
  const paylaterTotal = orders.filter(o => o.payment_method === 'paylater' || o.payment_status === 'partial' || o.payment_status === 'unpaid').reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0);
  const paidTotal = orders.reduce((sum, o) => sum + parseFloat(o.amount_paid || 0), 0);
  const unpaidTotal = orders.reduce((sum, o) => sum + parseFloat(o.remaining_balance || 0), 0);
  const unpaidOrders = orders.filter(o => !o.payment_status || o.payment_status === 'unpaid' || o.payment_status === 'partial');

  // Monthly breakdown
  const monthlyMap = {};
  orders.forEach(o => {
    const month = o.created_at?.substring(0, 7);
    if (!month) return;
    if (!monthlyMap[month]) monthlyMap[month] = { month, total_revenue: 0, collected: 0, outstanding: 0 };
    monthlyMap[month].total_revenue += parseFloat(o.shipping_cost || 0);
    monthlyMap[month].collected += parseFloat(o.amount_paid || 0);
    monthlyMap[month].outstanding += parseFloat(o.remaining_balance || 0);
  });
  const monthlySales = Object.values(monthlyMap).sort((a, b) => b.month.localeCompare(a.month));

  return {
    summary: { totalRevenue, cashTotal, gcashTotal, paylaterTotal, paidTotal, unpaidTotal, unpaidCount: unpaidOrders.length },
    monthlySales,
    unpaidOrders,
  };
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
  const { error } = await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      title,
      message,
      type,
      reference_id: referenceId,
    });
  // Notification insert error is non-critical

  // Fire-and-forget: send push notification via Edge Function
  // Non-blocking — never slows down the UI even if it fails
  void supabase.functions.invoke('send-push', {
    body: { user_id: userId, title, body: message, url: '/customer/notifications' },
  }).catch(() => { /* Edge function failure is non-critical */ });
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

      // Push notification to each admin device (fire-and-forget)
      notifiedAdmins.forEach(row => {
        if (row.admin_id) {
          void supabase.functions.invoke('send-push', {
            body: { user_id: row.admin_id, title, body: message, url: '/admin' },
          }).catch(() => {});
        }
      });
    } catch {
      // Admin notification fan-out is non-critical
    }
  })();
};

// ==================== CONTACT INQUIRIES ====================
export const createContactInquiry = async (data) => {
  const { error } = await supabase
    .from('contact_inquiries')
    .insert(data);
  if (error) throw error;

  // ── Non-blocking: notify admin(s) of new inquiry ────────────────────────
  void createAdminNotification(
    'New Contact Inquiry',
    `Inquiry from ${data.name || data.email || 'Visitor'}: ${(data.subject || data.message || '').slice(0, 80)}`,
    'inquiry',
    null
  );
};

export const getContactInquiries = async () => {
  const { data, error } = await supabase
    .from('contact_inquiries')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

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

// ==================== CHAT SUPPORT ====================
export const getOrCreateConversation = async (customerId) => {
  // Try to find existing — use .limit(1) instead of .single() to avoid
  // PGRST116 errors when multiple rows exist (no unique constraint on
  // customer_id). .single() fails when 0 OR 2+ rows match, which caused
  // the snowballing duplicate-conversation bug.
  let { data: convRows, error } = await supabase
    .from('conversations')
    .select('*, assigned_admin:assigned_admin_id(name)')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true })
    .limit(1);
    
  if (error) throw error;
  
  let conv = convRows && convRows.length > 0 ? convRows[0] : null;
  
  // If not exists, create with status='closed' so the chatbot becomes the
  // first responder. Status flips to 'waiting_admin' / 'open' only when
  // the customer escalates to a live admin.
  if (!conv) {
    const { data: newConv, error: createError } = await supabase
      .from('conversations')
      .insert({ customer_id: customerId, status: 'closed' })
      .select()
      .single();
    if (createError) throw createError;
    conv = newConv;
  }
  return conv;
};


export const getAdminConversations = async () => {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      id,
      created_at,
      status,
      assigned_admin_id,
      profiles:customer_id (id, name, email),
      assigned_admin:assigned_admin_id (name)
    `)
    .order('created_at', { ascending: true });
  if (error) throw error;

  // Deduplicate: keep only the earliest conversation per customer
  // This prevents duplicate names in the admin inbox even if the DB
  // still has leftover duplicates from before the unique constraint fix.
  const seen = new Map();
  for (const conv of data || []) {
    const custId = conv.profiles?.id;
    if (custId && !seen.has(custId)) {
      seen.set(custId, conv);
    }
  }

  // Sort: 'waiting_admin' conversations float to the top, then reverse-chron
  const all = Array.from(seen.values());
  all.sort((a, b) => {
    if (a.status === 'waiting_admin' && b.status !== 'waiting_admin') return -1;
    if (b.status === 'waiting_admin' && a.status !== 'waiting_admin') return 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  return all;
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

export const markCustomerMessagesRead = async (conversationId) => {
  const { error } = await supabase
    .from('chat_messages')
    .update({ is_read: true })
    .eq('conversation_id', conversationId)
    .eq('sender_role', 'customer')
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
      sender_name, status, package_weight, actual_weight, shipping_cost,
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
  const totalRevenue = filtered.filter(o => o.status !== 'Cancelled').reduce((s, o) => s + parseFloat(o.shipping_cost || 0), 0);
  const totalCollected = filtered.reduce((s, o) => s + parseFloat(o.amount_paid || 0), 0);
  const totalOutstanding = filtered.filter(o => o.status !== 'Cancelled').reduce((s, o) => s + parseFloat(o.remaining_balance || 0), 0);
  const totalWeight = filtered.filter(o => o.status !== 'Cancelled').reduce((s, o) => s + parseFloat(o.actual_weight || o.package_weight || 0), 0);

  // Payment breakdown
  const cashOrders = filtered.filter(o => o.payment_method === 'cash');
  const gcashOrders = filtered.filter(o => o.payment_method === 'gcash');
  const paylaterOrders = filtered.filter(o => o.payment_method === 'paylater');

  // Route breakdown
  const routeMap = {};
  filtered.filter(o => o.status !== 'Cancelled').forEach(o => {
    const key = `${o.origin || 'N/A'} → ${o.destination || 'N/A'}`;
    if (!routeMap[key]) routeMap[key] = { route: key, count: 0, revenue: 0, weight: 0 };
    routeMap[key].count++;
    routeMap[key].revenue += parseFloat(o.shipping_cost || 0);
    routeMap[key].weight += parseFloat(o.actual_weight || o.package_weight || 0);
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
      cashCount: cashOrders.length,
      cashTotal: cashOrders.reduce((s, o) => s + parseFloat(o.amount_paid || 0), 0),
      gcashCount: gcashOrders.length,
      gcashTotal: gcashOrders.reduce((s, o) => s + parseFloat(o.amount_paid || 0), 0),
      paylaterCount: paylaterOrders.length,
      paylaterTotal: paylaterOrders.reduce((s, o) => s + parseFloat(o.amount_paid || 0), 0),
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

export const recordAdditionalPayment = async (orderId, amount, method, ref, notes, paymentDate = null, receiptUrl = null, skipInsert = false) => {
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

  let actionName = 'Additional Payment Recorded';
  if (freshOrder.remaining_balance <= 0 && previousBalance > 0) actionName = 'Full Payment Completed';

  logPayment(actionName, orderId, order.tracking_number, {
    previousValue: { amount_paid: previousPaid, remaining_balance: previousBalance },
    newValue: { amount_paid: freshOrder.amount_paid, remaining_balance: freshOrder.remaining_balance },
    details: `Added ₱${amount} via ${method}. Balance is now ₱${freshOrder.remaining_balance}.`
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

export const assignConversation = async (conversationId) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  // Also flip status back to 'open' to clear the 'waiting_admin' state
  const { error } = await supabase
    .from('conversations')
    .update({ assigned_admin_id: user.id, status: 'open' })
    .eq('id', conversationId);
  if (error) throw error;
};

export const closeConversation = async (conversationId) => {
  const { error } = await supabase.from('conversations').update({ status: 'closed' }).eq('id', conversationId);
  if (error) throw error;
};

export const reopenConversation = async (conversationId) => {
  const { error } = await supabase.from('conversations').update({ status: 'open' }).eq('id', conversationId);
  if (error) throw error;
};

/**
 * setConversationWaitingAdmin
 * Called by the bot when the customer indicates their concern is unresolved.
 * Sets status to 'waiting_admin' so the admin inbox highlights it.
 */
export const setConversationWaitingAdmin = async (conversationId) => {
  const { error } = await supabase
    .from('conversations')
    .update({ status: 'waiting_admin' })
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

export const getPublicFeedback = async () => {
  const { data, error } = await supabase
    .from('customer_feedback')
    .select(`
      id,
      rating,
      message,
      created_at,
      profiles:customer_id ( name ),
      orders:order_id (
        featured_on_website,
        featured_image_type,
        pickup_photos,
        delivery_photos,
        receiver_city,
        receiver_province
      )
    `)
    .eq('is_hidden', false)
    .order('rating', { ascending: false })
    .order('created_at', { ascending: false });
    
  if (error) throw error;
  return data;
};

export const getFeaturedDeliveries = async () => {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id,
      tracking_number,
      featured_title,
      featured_caption,
      featured_image_type,
      featured_at,
      pickup_photos,
      delivery_photos,
      updated_at,
      receiver_city,
      receiver_province
    `)
    .eq('featured_on_website', true)
    .order('featured_at', { ascending: false });
    
  if (error) throw error;
  return data;
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

export const uploadPublicAsset = async (file, path) => {
  // Compress image before uploading
  const { compressImage } = await import('./storage');
  const compressed = await compressImage(file);
  
  const bucket = import.meta.env.VITE_SUPABASE_PHOTOS_BUCKET || 'cargo-photos';
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
