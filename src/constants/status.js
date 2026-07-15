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
