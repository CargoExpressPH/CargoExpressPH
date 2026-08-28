// CargoExpress PH Order Status System
// Mirrors the original backend's sequential status flow

import { formatMoney } from '../utils/currencyInput';

export const ORDER_STATUS = {
  PENDING_REVIEW: 'Pending Review',
  PENDING: 'Pending',
  ASSIGNED: 'Assigned',
  PICKED_UP: 'Picked Up',
  IN_TRANSIT: 'In Transit',
  ARRIVED_HUB: 'Arrived at Hub',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered',
  // A customer has asked to cancel and stated a reason; an admin has not
  // decided yet. Deliberately a status and not a flag beside one: the point is
  // that the order stops advancing while a human looks at it, and every
  // surface here — badges, the Advance button, STATUS_FLOW, the filters —
  // already keys off `status`. See 20260816100000_cancellation_requests.sql.
  PENDING_CANCELLATION: 'Pending Cancellation',
  CANCELLED: 'Cancelled',
};

export const VALID_STATUSES = Object.values(ORDER_STATUS);

// Sequential status flow (each status maps to its next allowed status)
export const STATUS_FLOW = {
  [ORDER_STATUS.PENDING_REVIEW]: ORDER_STATUS.PENDING,
  [ORDER_STATUS.PENDING]: ORDER_STATUS.ASSIGNED,
  [ORDER_STATUS.ASSIGNED]: ORDER_STATUS.PICKED_UP,
  [ORDER_STATUS.PICKED_UP]: ORDER_STATUS.IN_TRANSIT,
  [ORDER_STATUS.IN_TRANSIT]: ORDER_STATUS.ARRIVED_HUB,
  [ORDER_STATUS.ARRIVED_HUB]: ORDER_STATUS.OUT_FOR_DELIVERY,
  [ORDER_STATUS.OUT_FOR_DELIVERY]: ORDER_STATUS.DELIVERED,
};

// Status flow as ordered array for timeline rendering
export const STATUS_TIMELINE = [
  ORDER_STATUS.PENDING_REVIEW,
  ORDER_STATUS.PENDING,
  ORDER_STATUS.ASSIGNED,
  ORDER_STATUS.PICKED_UP,
  ORDER_STATUS.IN_TRANSIT,
  ORDER_STATUS.ARRIVED_HUB,
  ORDER_STATUS.OUT_FOR_DELIVERY,
  ORDER_STATUS.DELIVERED,
];

// Statuses that require trip_id.
//
// Every status from Assigned onward: "Assigned" is a claim about a specific
// trip, so an order that is Assigned to nothing is a contradiction that then
// propagates — it shows as scheduled to the customer, counts against no trip's
// capacity, and reaches the pickup screen with no vessel to load onto. The list
// used to start at In Transit, which only caught it two steps too late.
//
// Mirrors the CHECK constraint orders_trip_required_for_active_status
// (20260818110000). The database is the enforcement; this is the message.
export const REQUIRES_TRIP = [
  ORDER_STATUS.ASSIGNED,
  ORDER_STATUS.PICKED_UP,
  ORDER_STATUS.IN_TRANSIT,
  ORDER_STATUS.ARRIVED_HUB,
  ORDER_STATUS.OUT_FOR_DELIVERY,
  ORDER_STATUS.DELIVERED,
];

// Trip status enum
export const TRIP_STATUS = {
  SCHEDULED: 'scheduled',
  IN_PROGRESS: 'in_progress',
  ARRIVED: 'arrived',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

// Map trip status → order status for batch cascade
export const TRIP_TO_ORDER_STATUS = {
  [TRIP_STATUS.IN_PROGRESS]: ORDER_STATUS.IN_TRANSIT,
  [TRIP_STATUS.ARRIVED]: ORDER_STATUS.ARRIVED_HUB,
  [TRIP_STATUS.CANCELLED]: ORDER_STATUS.CANCELLED,
};

/**
 * Order statuses the TRIP owns.
 *
 * These are written by the trip lifecycle cascade for every order on the trip
 * at once — the cargo is on one vehicle, so "it has departed" and "it has
 * arrived" are facts about the vehicle, not about any single parcel. Advancing
 * one order into them by hand desynchronises it from the trip it is physically
 * sitting on.
 *
 * Cancelled is excluded: the trip cascades it, but cancelling a single order is
 * also a legitimate standalone act, so it is not trip-owned.
 *
 * Everything after arrival is per-order on purpose — Out for Delivery and
 * Delivered are last-mile events that happen to one parcel at one door.
 */
export const TRIP_CONTROLLED_STATUSES = [
  ORDER_STATUS.IN_TRANSIT,
  ORDER_STATUS.ARRIVED_HUB,
];

/**
 * Is this order's next step the trip's to take, rather than an admin's?
 *
 * True only while the order is actually attached to a trip. An order with no
 * trip has no cascade coming for it, so hiding its advance button would strand
 * it with no way forward at all.
 */
export const isTripControlledAdvance = (order) => {
  if (!order?.trip_id) return false;
  const next = STATUS_FLOW[order.status];
  return Boolean(next) && TRIP_CONTROLLED_STATUSES.includes(next);
};

/**
 * Statuses at which the cargo has already left the customer's hands. Past
 * this line the parcel is in the network — collected, on a vehicle, in a hub,
 * or on a doorstep run — and a customer-initiated "cancel" no longer
 * describes anything that can physically happen. Unwinding it is a return or
 * a refund, which is a different act with different money, and is a decision
 * only an admin makes — see canAdminCancelOrder below, which is deliberately
 * NOT built on this list.
 *
 * Mirrors the status list enforced server-side in request_order_cancellation()
 * (supabase/migrations/20260826000001_refactor_cancellation_to_jsonb.sql). The
 * two used to disagree — this list stopped at IN_TRANSIT while the RPC also
 * blocked PICKED_UP, so a customer could submit a cancellation request on a
 * Picked Up order that the server would always reject. This is the client
 * copy of that same line, kept in sync on purpose.
 */
export const IN_NETWORK_STATUSES = [
  ORDER_STATUS.PICKED_UP,
  ORDER_STATUS.IN_TRANSIT,
  ORDER_STATUS.ARRIVED_HUB,
  ORDER_STATUS.OUT_FOR_DELIVERY,
  ORDER_STATUS.DELIVERED,
];

/**
 * Can the CUSTOMER still request cancellation of this order?
 *
 * This governs only the customer-facing "Request Cancellation" button and the
 * request_order_cancellation() RPC behind it — it has no bearing on an admin's
 * ability to force-cancel a booking. Use canAdminCancelOrder for that; the two
 * used to be the same function, which meant tightening this one for customers
 * (adding PICKED_UP above) would have silently taken the "Cancel Order"
 * button away from admins on picked-up orders too — the opposite of the
 * intended effect, since ending an already-picked-up booking (a return, a
 * refund, cargo lost in transit) is exactly the kind of judgment call that
 * should stay an admin decision.
 */
export const canCancelOrder = (order) => {
  if (!order?.status) return false;
  if (order.status === ORDER_STATUS.CANCELLED) return false;
  // Already asked. Offering "Cancel" again would open a second request against
  // a booking that is by definition already frozen waiting on the first.
  if (order.status === ORDER_STATUS.PENDING_CANCELLATION) return false;
  return !IN_NETWORK_STATUSES.includes(order.status);
};

/**
 * Statuses at which the shipment has physically left the origin island —
 * on the ferry/truck between Manila and Bohol, already arrived at the
 * destination hub, out on a doorstep run, or delivered. Business rule: past
 * this line NOBODY cancels the booking from the app, not even an admin. Once
 * it is In Transit the cargo already left for the other island; turning it
 * back is a logistics/refund matter handled outside the ordinary
 * cancellation flow, not a button click.
 *
 * One step later than IN_NETWORK_STATUSES on purpose: Picked Up (collected
 * from the sender, not yet moved) is still an admin-cancellable state — the
 * parcel could still be turned back before it boards. In Transit means it
 * already left.
 */
export const ADMIN_LOCKED_STATUSES = [
  ORDER_STATUS.IN_TRANSIT,
  ORDER_STATUS.ARRIVED_HUB,
  ORDER_STATUS.OUT_FOR_DELIVERY,
  ORDER_STATUS.DELIVERED,
];

/**
 * Can an ADMIN force-cancel this order directly — the "Cancel Order" action
 * in the admin console, backed by cancelOrderAsAdmin() in lib/database.js?
 *
 * Allows Pending Review / Pending / Assigned / Picked Up — everything up to
 * and including the moment the courier collects the parcel from the sender.
 * Blocks ADMIN_LOCKED_STATUSES (In Transit onward: the shipment already left
 * for the other island) exactly as strictly as canCancelOrder blocks a
 * customer from IN_NETWORK_STATUSES — the two lists differ by exactly one
 * status (Picked Up), which is the entire point of having two functions.
 *
 * Pending Cancellation is excluded for a different reason: that status has
 * its own dedicated Approve/Decline review flow (reviewOrderCancellation),
 * which MERGES into the existing cancellation_details JSONB. Force-cancelling
 * through this path instead would overwrite that object outright —
 * cancelOrderAsAdmin() writes a brand-new { reason, reviewed_at, reviewed_by }
 * — silently discarding the customer's original stated reason and
 * requested_at. Route that case through the review modal instead.
 */
export const canAdminCancelOrder = (order) => {
  if (!order?.status) return false;
  if (order.status === ORDER_STATUS.CANCELLED) return false;
  if (order.status === ORDER_STATUS.PENDING_CANCELLATION) return false;
  return !ADMIN_LOCKED_STATUSES.includes(order.status);
};

/** Is this order frozen waiting for an admin to rule on a cancellation? */
export const hasPendingCancellation = (order) =>
  order?.status === ORDER_STATUS.PENDING_CANCELLATION;

/**
 * Which step the tracking timeline should light up.
 *
 * 'Pending Cancellation' is not on STATUS_TIMELINE — it is a hold, not a place
 * the cargo has reached — so passing it straight through gives `indexOf` a -1
 * and blanks the whole timeline, which reads as "nothing has happened to this
 * parcel". The cargo has not moved backwards just because a request is under
 * review, so the timeline shows where it actually is: the status it was in
 * when the request was made.
 *
 * The 'Pending' fallback covers rows with no recorded previous status — the
 * public tracking RPC does not return that column, and neither do orders that
 * predate the cancellation-request flow.
 */
export const timelineStatus = (order) => {
  if (!order?.status) return undefined;
  if (order.status !== ORDER_STATUS.PENDING_CANCELLATION) return order.status;
  return order.cancellation_details?.previous_status || ORDER_STATUS.PENDING;
};

/**
 * Status groups for the CUSTOMER orders list.
 *
 * The filter used to be `['All', ...VALID_STATUSES]` — ten chips, one per
 * internal status, wrapping onto three rows on a phone. Most of them answer a
 * question no customer asks: the difference between "Assigned" and "Picked Up"
 * is an operational one, and "Arrived at Hub" and "Out for Delivery" are the
 * same answer ("nearly there") to the only question being asked. Four groups
 * cover what a customer actually wants to narrow to, and the card still shows
 * the exact status on its badge, so nothing is hidden — only the filter is
 * coarser than the data.
 *
 * `statuses: null` means "everything".
 */
export const CUSTOMER_ORDER_FILTERS = [
  { value: 'all', label: 'All', statuses: null },
  {
    value: 'processing',
    label: 'Processing',
    statuses: [ORDER_STATUS.PENDING_REVIEW, ORDER_STATUS.PENDING, ORDER_STATUS.ASSIGNED],
  },
  {
    value: 'in-transit',
    label: 'In Transit',
    statuses: [
      ORDER_STATUS.PICKED_UP,
      ORDER_STATUS.IN_TRANSIT,
      ORDER_STATUS.ARRIVED_HUB,
      ORDER_STATUS.OUT_FOR_DELIVERY,
    ],
  },
  { value: 'delivered', label: 'Delivered', statuses: [ORDER_STATUS.DELIVERED] },
  {
    value: 'cancelled',
    label: 'Cancelled',
    // A pending request lives here rather than in Processing: the customer's
    // reason for looking is "what happened to the one I tried to cancel".
    statuses: [ORDER_STATUS.PENDING_CANCELLATION, ORDER_STATUS.CANCELLED],
  },
];

// Status color mapping using theme variables
export const STATUS_COLORS = {
  [ORDER_STATUS.PENDING_REVIEW]: { bg: 'var(--warning-bg)', text: 'var(--warning-dark)', border: 'var(--warning)' },
  [ORDER_STATUS.PENDING]: { bg: 'var(--warning-bg)', text: 'var(--warning-dark)', border: 'var(--warning)' },
  [ORDER_STATUS.ASSIGNED]: { bg: 'var(--info-bg)', text: 'var(--info-dark)', border: 'var(--info)' },
  [ORDER_STATUS.PICKED_UP]: { bg: 'var(--success-bg)', text: 'var(--success-dark)', border: 'var(--success)' },
  [ORDER_STATUS.IN_TRANSIT]: { bg: 'var(--info-bg)', text: 'var(--info-dark)', border: 'var(--info)' },
  [ORDER_STATUS.ARRIVED_HUB]: { bg: 'var(--success-bg)', text: 'var(--success-dark)', border: 'var(--success)' },
  [ORDER_STATUS.OUT_FOR_DELIVERY]: { bg: 'var(--primary-bg)', text: 'var(--primary)', border: 'var(--primary-light)' },
  [ORDER_STATUS.DELIVERED]: { bg: 'var(--success-bg)', text: 'var(--success-dark)', border: 'var(--success)' },
  [ORDER_STATUS.PENDING_CANCELLATION]: { bg: 'var(--warning-bg)', text: 'var(--warning-dark)', border: 'var(--warning)' },
  [ORDER_STATUS.CANCELLED]: { bg: 'var(--error-bg)', text: 'var(--error-dark)', border: 'var(--error)' },
};

// Status → semantic "tone" used by the tracking result card banner/tiles.
// Single source of truth — extends STATUS_COLORS with the extra `iconBg`
// token the tracking card needs. Resolves the previous drift where the
// public TrackingPage redefined its own (incomplete) map that disagreed
// with STATUS_COLORS (e.g. "Out for Delivery" was purple here, primary
// there) and silently dropped "Pending Review" / "Pending".
export const TRACKING_STATUS_TONES = {
  [ORDER_STATUS.PENDING_REVIEW]: { ...STATUS_COLORS[ORDER_STATUS.PENDING_REVIEW], iconBg: 'var(--warning-icon-bg)' },
  [ORDER_STATUS.PENDING]:         { ...STATUS_COLORS[ORDER_STATUS.PENDING],         iconBg: 'var(--warning-icon-bg)' },
  [ORDER_STATUS.ASSIGNED]:        { ...STATUS_COLORS[ORDER_STATUS.ASSIGNED],        iconBg: 'var(--info-icon-bg)' },
  [ORDER_STATUS.PICKED_UP]:       { ...STATUS_COLORS[ORDER_STATUS.PICKED_UP],       iconBg: 'var(--success-icon-bg)' },
  [ORDER_STATUS.IN_TRANSIT]:      { ...STATUS_COLORS[ORDER_STATUS.IN_TRANSIT],      iconBg: 'var(--info-icon-bg)' },
  [ORDER_STATUS.ARRIVED_HUB]:     { ...STATUS_COLORS[ORDER_STATUS.ARRIVED_HUB],     iconBg: 'var(--success-icon-bg)' },
  [ORDER_STATUS.OUT_FOR_DELIVERY]:{ ...STATUS_COLORS[ORDER_STATUS.OUT_FOR_DELIVERY],iconBg: 'var(--primary-icon-bg)' },
  [ORDER_STATUS.DELIVERED]:       { ...STATUS_COLORS[ORDER_STATUS.DELIVERED],       iconBg: 'var(--success-icon-bg)' },
  [ORDER_STATUS.PENDING_CANCELLATION]: { ...STATUS_COLORS[ORDER_STATUS.PENDING_CANCELLATION], iconBg: 'var(--warning-icon-bg)' },
  [ORDER_STATUS.CANCELLED]:       { ...STATUS_COLORS[ORDER_STATUS.CANCELLED],       iconBg: 'var(--error-icon-bg)' },
};

// Canonical status → icon-name mapping (resolved by the component to a
// lucide-react icon). Centralised so every surface (banner, tiles,
// timelines) shows a consistent, complete icon instead of falling back
// to a generic "Package" for half the statuses.
export const STATUS_ICONS = {
  [ORDER_STATUS.PENDING_REVIEW]: 'clipboardCheck',
  [ORDER_STATUS.PENDING]: 'clock',
  [ORDER_STATUS.ASSIGNED]: 'package',
  [ORDER_STATUS.PICKED_UP]: 'package',
  [ORDER_STATUS.IN_TRANSIT]: 'truck',
  [ORDER_STATUS.ARRIVED_HUB]: 'building',
  [ORDER_STATUS.OUT_FOR_DELIVERY]: 'bike',
  [ORDER_STATUS.DELIVERED]: 'checkCircle',
  [ORDER_STATUS.PENDING_CANCELLATION]: 'clock',
  [ORDER_STATUS.CANCELLED]: 'xCircle',
};

export const TRIP_STATUS_COLORS = {
  [TRIP_STATUS.SCHEDULED]: { bg: 'var(--info-bg)', text: 'var(--info-dark)', border: 'var(--info)' },
  [TRIP_STATUS.IN_PROGRESS]: { bg: 'var(--warning-bg)', text: 'var(--warning-dark)', border: 'var(--warning)' },
  [TRIP_STATUS.ARRIVED]: { bg: 'var(--success-bg)', text: 'var(--success-dark)', border: 'var(--success)' },
  [TRIP_STATUS.COMPLETED]: { bg: 'var(--success-bg)', text: 'var(--success-dark)', border: 'var(--success)' },
  [TRIP_STATUS.CANCELLED]: { bg: 'var(--error-bg)', text: 'var(--error-dark)', border: 'var(--error)' },
};

// Payment methods
export const PAYMENT_METHODS = ['cash', 'gcash', 'paylater'];
export const PAYMENT_STATUSES = ['paid', 'partial', 'unpaid'];

// Payer types
export const PAYER_TYPES = ['sender', 'receiver'];

// Validate status transition
/**
 * canDispatchForDelivery — the warehouse hold rule.
 *
 * Cargo always travels to the destination warehouse, paid or not. An UNPAID
 * shipment is then held there and is NOT dispatched for doorstep delivery
 * until the balance is settled — unless an admin records a Promise Date,
 * which is the explicit, logged override.
 *
 * Freight Collect (payer_type = 'receiver') is exempt: payment is due at the
 * door, so a COD order is unpaid by definition until delivery. Gating it
 * would deadlock it in the warehouse forever.
 *
 * Mirrors the server-side gate in guard_order_update. This copy exists only
 * to produce a good message before the round trip — the database is the
 * authority.
 *
 * @param {Object} order — needs payer_type, actual_weight, shipping_cost,
 *                         amount_paid, promised_payment_date
 * @returns {{ allowed: boolean, reason?: string }}
 */
export const canDispatchForDelivery = (order) => {
  if (!order) return { allowed: true };

  // An unweighed parcel has no price — its balance is 0 because nothing was
  // ever billed, not because anything was paid. Letting that ₱0.00 satisfy the
  // payment gate is how cargo walks out of the warehouse having never been
  // charged. Checked BEFORE the freight-collect exemption: collect only says
  // *who* pays and *when*, it does not excuse an order from having a price,
  // and weight is captured at pickup, long before dispatch.
  if (!isOrderPriced(order)) {
    return {
      allowed: false,
      reason: 'This parcel has not been weighed, so it has no price yet. Record the actual weight before dispatching it for delivery.',
    };
  }

  if ((order.payer_type || 'sender') === 'receiver') return { allowed: true };

  const balance = outstandingBalance(order);
  if (balance <= 0) return { allowed: true };
  if (order.promised_payment_date) return { allowed: true };

  return {
    allowed: false,
    reason: `There is a remaining balance of ${formatMoney(balance)} on this order. Settle the balance, or record a Promise Date to dispatch anyway.`,
  };
};

/**
 * isOrderPriced — has this parcel been weighed, and therefore billed?
 *
 * `actual_weight` is the single input to the pricing formula and it enters the
 * system exactly once, from the scale at pickup. Until then `shipping_cost`
 * and `remaining_balance` are both 0 — and those two zeros mean "not priced
 * yet", never "paid in full". Every settlement question has to ask this first,
 * or an unweighed booking reads as a fully settled one.
 */
export const isOrderPriced = (order) => {
  if (!order) return false;
  return (parseFloat(order.actual_weight || 0) || 0) > 0;
};

/**
 * outstandingBalance — THE single client-side definition of "what is owed".
 *
 * Derived from `shipping_cost - amount_paid` rather than read from the stored
 * `remaining_balance` column. Both are maintained by the database, but the
 * stored copy can lag a ledger write, and two views reading two different
 * columns is exactly what produced two different "Outstanding" figures in one
 * report. Mirrors the SQL in get_sales_summary() / get_unsettled_summary().
 */
export const outstandingBalance = (order) => {
  if (!order) return 0;
  const cost = parseFloat(order.shipping_cost || 0) || 0;
  const paid = parseFloat(order.amount_paid || 0) || 0;
  return Math.max(0, Math.round((cost - paid) * 100) / 100);
};

/**
 * Settlement state of one order, as three mutually exclusive answers rather
 * than a boolean. The boolean was the bug: it had no way to say "there is no
 * money question yet because there is no price yet", so it answered "settled"
 * and the UI rendered `Unpaid` and `Settled` side by side on the same ₱0 row.
 *
 *   'unpriced' — not weighed; no cost exists. Not settled, not owing.
 *   'settled'  — priced and fully collected (or cancelled).
 *   'owing'    — priced with a balance outstanding.
 */
export const SETTLEMENT_STATE = {
  UNPRICED: 'unpriced',
  SETTLED: 'settled',
  OWING: 'owing',
};

export const getSettlementState = (order) => {
  if (!order) return SETTLEMENT_STATE.UNPRICED;
  if (order.status === ORDER_STATUS.CANCELLED) return SETTLEMENT_STATE.SETTLED;
  if (!isOrderPriced(order)) return SETTLEMENT_STATE.UNPRICED;
  return outstandingBalance(order) <= 0 ? SETTLEMENT_STATE.SETTLED : SETTLEMENT_STATE.OWING;
};

/**
 * isOrderSettled — has the money actually been collected?
 *
 * Deliberately separate from `status`: status answers "where is the cargo",
 * this answers "where is the money". Keeping them independent is what makes
 * "delivered, balance owing, payment promised" representable.
 *
 * An UNWEIGHED order is not settled. It has no price, so there is nothing to
 * have collected — see getSettlementState() when you need to tell "nothing is
 * owed" apart from "nothing is billed yet".
 */
export const isOrderSettled = (order) =>
  getSettlementState(order) === SETTLEMENT_STATE.SETTLED;

export const validateStatusTransition = (currentStatus, newStatus, tripId, order = null) => {
  if (currentStatus === ORDER_STATUS.DELIVERED || currentStatus === ORDER_STATUS.CANCELLED) {
    return { valid: false, error: `Cannot update an order that is already "${currentStatus}"` };
  }
  // Frozen pending review. The only ways out are approve → Cancelled and
  // reject → the recorded previous status, both written by
  // review_order_cancellation(). Mirrors the hold in guard_order_update.
  if (currentStatus === ORDER_STATUS.PENDING_CANCELLATION && newStatus !== ORDER_STATUS.CANCELLED) {
    return {
      valid: false,
      error: 'This order has a cancellation request awaiting review. Approve or reject it first.',
    };
  }
  if (newStatus === ORDER_STATUS.CANCELLED) {
    return { valid: true };
  }
  if (!VALID_STATUSES.includes(newStatus)) {
    return { valid: false, error: `Invalid status: "${newStatus}"` };
  }
  if (REQUIRES_TRIP.includes(newStatus) && !tripId) {
    return { valid: false, error: `Cannot set status to "${newStatus}" without an assigned trip.` };
  }
  const expectedNext = STATUS_FLOW[currentStatus];
  if (newStatus !== expectedNext) {
    return {
      valid: false,
      error: `Invalid transition: "${currentStatus}" → "${newStatus}". Next: "${expectedNext || 'none'}"`,
    };
  }

  // Warehouse hold: an unpaid Prepaid shipment is not dispatched for doorstep
  // delivery without a Promise Date. Only checked when the caller supplied the
  // order, so existing 3-arg callers are unaffected.
  if (newStatus === ORDER_STATUS.OUT_FOR_DELIVERY && order) {
    const dispatch = canDispatchForDelivery(order);
    if (!dispatch.allowed) {
      return { valid: false, error: dispatch.reason };
    }
  }

  return { valid: true };
};

/**
 * isTripBookable — can a customer still book onto this trip?
 *
 * A trip whose departure date has already passed must never appear as a
 * booking option, even if an admin forgot to close it. Without this, a trip
 * that departed on 17 Jul was still selectable on 2 Aug.
 *
 * Deliberately scoped to the CUSTOMER booking flow only:
 *   • the trip row is not modified — no status change, no order cascade
 *   • admins keep seeing stale trips so they can close them
 *
 * Compares against the start of today, so a trip departing later TODAY stays
 * bookable all day. A pre-departure cutoff (e.g. "closes 6 h before") is a
 * separate business rule and is not applied here.
 */
export const isTripBookable = (trip) => {
  if (!trip) return false;
  if (!trip.departure_date) return true;          // no date set — don't hide it
  const departure = new Date(trip.departure_date);
  if (Number.isNaN(departure.getTime())) return true;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return departure >= startOfToday;
};

// ── Trip van capacity ────────────────────────────────────────────────────────
/**
 * Slack the van can physically take beyond its planned capacity, in kilograms.
 *
 * A trip's `capacity` is the figure the admin plans against; this allowance is
 * the hard ceiling on top of it. A 1000 kg trip accepts cargo up to 1200 kg and
 * not a gram more.
 *
 * Note what this reverses: `20260526010000_remove_capacity_guard.sql` removed
 * the database's capacity check specifically so admins could overbook by
 * judgement. Overbooking is still allowed — that is what the allowance IS —
 * but it now stops at a fixed line instead of being unbounded.
 */
export const TRIP_CAPACITY_ALLOWANCE_KG = 200;

/**
 * The absolute ceiling for a trip: planned capacity + the allowance.
 *
 * Returns Infinity for a trip with no capacity recorded. A missing capacity is
 * unknown, not zero, and treating it as zero would block every booking on that
 * trip — refusing work over a blank field is worse than not enforcing a limit
 * nobody has set.
 */
export const tripMaxCapacity = (capacity) => {
  const base = parseFloat(capacity ?? 0) || 0;
  return base > 0 ? base + TRIP_CAPACITY_ALLOWANCE_KG : Infinity;
};

/**
 * Everything the UI and the guard need to say about a trip's load, derived in
 * one place so a badge, a progress bar and a thrown error cannot disagree.
 *
 * IMPORTANT — what `currentWeight` actually counts. Weight enters this system
 * exactly once, from the scale at pickup (`orders.actual_weight`; the
 * customer-declared estimate was removed in `20260805130000`). A booking that
 * has not been weighed yet therefore contributes 0 kg to the total, so the
 * ceiling only bites once cargo has been weighed. This is a property of the
 * data, not a shortcut here: there is no honest number to count for a parcel
 * nobody has put on a scale.
 *
 * @param {object}  trip            the trip, or anything carrying `capacity`
 * @param {number}  currentWeight   kg already committed to the trip
 * @param {number} [incomingWeight] kg about to be added
 */
export const tripCapacityState = (trip, currentWeight, incomingWeight = 0) => {
  const base = parseFloat(trip?.capacity ?? 0) || 0;
  const used = parseFloat(currentWeight ?? 0) || 0;
  const incoming = parseFloat(incomingWeight ?? 0) || 0;
  const max = tripMaxCapacity(base);
  const hasLimit = Number.isFinite(max);

  return {
    base,
    max,
    used,
    hasLimit,
    allowance: TRIP_CAPACITY_ALLOWANCE_KG,
    // Headroom to the ABSOLUTE ceiling, which is the only figure that governs
    // whether a booking can be accepted.
    remaining: hasLimit ? Math.max(0, max - used) : Infinity,
    // Headroom to the PLANNED capacity — what the admin is working to. Goes
    // negative into the allowance, which is the state worth showing.
    remainingToPlanned: hasLimit ? base - used : Infinity,
    isOverPlanned: hasLimit && used > base,
    isFull: hasLimit && used >= max,
    wouldExceed: hasLimit && used + incoming > max,
    overBy: hasLimit ? Math.max(0, (used + incoming) - max) : 0,
  };
};

/**
 * The message shown when the ceiling refuses a booking. Shared so the toast
 * raised by the data layer and the text printed beside a disabled trip in the
 * assign modal are the same sentence.
 */
export const tripCapacityRefusal = (trip, currentWeight, incomingWeight = 0) => {
  const { base, max, used, overBy } = tripCapacityState(trip, currentWeight, incomingWeight);
  return `Cannot accept booking: exceeds maximum van capacity of ${max} kg `
    + `(${base} kg planned + ${TRIP_CAPACITY_ALLOWANCE_KG} kg allowance). `
    + `This trip is carrying ${used.toFixed(1)} kg and this booking would put it ${overBy.toFixed(1)} kg over.`;
};
