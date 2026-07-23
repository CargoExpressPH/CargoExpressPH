// CargoExpress PH Order Status System
// Mirrors the original backend's sequential status flow

export const ORDER_STATUS = {
  PENDING_REVIEW: 'Pending Review',
  PENDING: 'Pending',
  ASSIGNED: 'Assigned',
  PICKED_UP: 'Picked Up',
  IN_TRANSIT: 'In Transit',
  ARRIVED_HUB: 'Arrived at Hub',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered',
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

// Statuses that require trip_id
export const REQUIRES_TRIP = [
  ORDER_STATUS.IN_TRANSIT,
  ORDER_STATUS.ARRIVED_HUB,
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
export const validateStatusTransition = (currentStatus, newStatus, tripId) => {
  if (currentStatus === ORDER_STATUS.DELIVERED || currentStatus === ORDER_STATUS.CANCELLED) {
    return { valid: false, error: `Cannot update an order that is already "${currentStatus}"` };
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
  return { valid: true };
};
