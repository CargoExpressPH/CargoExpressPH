import { ORDER_STATUS, STATUS_TIMELINE } from '../constants/status';

// Action strings that imply a status change but don't carry new_value.status.
// Keep this list in sync with the logOrder(...) and logTrip(...) call sites across the app.
const ACTION_STATUS_FALLBACK = {
  'Booking Created': ORDER_STATUS.PENDING_REVIEW,
  'Out-of-Coverage Booking Submitted': ORDER_STATUS.PENDING_REVIEW,
  'Order Created': ORDER_STATUS.PENDING_REVIEW,
  'Out-of-Coverage Request Approved': ORDER_STATUS.PENDING,
  'Request Approved': ORDER_STATUS.PENDING,
  'Assigned to Trip': ORDER_STATUS.ASSIGNED,
  'Order Assigned': ORDER_STATUS.ASSIGNED,
  'Trip Assigned': ORDER_STATUS.ASSIGNED,
  'Trip Reassigned': ORDER_STATUS.ASSIGNED,
  'Assigned': ORDER_STATUS.ASSIGNED,
  'Pickup Processed': ORDER_STATUS.PICKED_UP,
  'Picked Up': ORDER_STATUS.PICKED_UP,
  'In Transit': ORDER_STATUS.IN_TRANSIT,
  'Trip Started': ORDER_STATUS.IN_TRANSIT,
  'Arrived at Hub': ORDER_STATUS.ARRIVED_HUB,
  'Trip Arrived': ORDER_STATUS.ARRIVED_HUB,
  'Out for Delivery': ORDER_STATUS.OUT_FOR_DELIVERY,
  'Delivery Proof Uploaded': ORDER_STATUS.DELIVERED,
  'Delivered': ORDER_STATUS.DELIVERED,
};

const VALID_STATUS_VALUES = new Set(Object.values(ORDER_STATUS));

/**
 * Extract a status string from a single activity log entry.
 * @returns {string|null} a value from ORDER_STATUS, or null if not a status change.
 */
const statusFromLog = (log) => {
  if (!log || typeof log !== 'object') return null;

  let nv = log.new_value;
  if (typeof nv === 'string') {
    try {
      nv = JSON.parse(nv);
    } catch {
      // nv remains a raw string
    }
  }
  
  // 1. Authoritative: explicit new_value.status
  if (nv && typeof nv === 'object' && typeof nv.status === 'string' && nv.status.trim()) {
    const val = nv.status.trim();
    if (VALID_STATUS_VALUES.has(val)) return val;
  }
  if (typeof nv === 'string' && nv.trim() && VALID_STATUS_VALUES.has(nv.trim())) {
    return nv.trim();
  }
  
  // 2. Fallback: known action strings
  const action = log.action;
  if (action && typeof action === 'string') {
    const trimmedAction = action.trim();
    if (Object.prototype.hasOwnProperty.call(ACTION_STATUS_FALLBACK, trimmedAction)) {
      return ACTION_STATUS_FALLBACK[trimmedAction];
    }
    
    // 3. `Status Changed to X` or `Status advanced from A to B`
    if (trimmedAction.startsWith('Status Changed to ')) {
      const target = trimmedAction.slice('Status Changed to '.length).trim();
      if (VALID_STATUS_VALUES.has(target)) return target;
    }
  }

  // 4. Inspect details string for trip trigger fallbacks
  const details = log.details;
  if (details && typeof details === 'string') {
    if (details.includes('Triggered by Trip Start')) return ORDER_STATUS.IN_TRANSIT;
    if (details.includes('Triggered by Trip Arrival')) return ORDER_STATUS.ARRIVED_HUB;
    if (details.includes('auto-assigned to Trip') || details.includes('assigned to Trip')) return ORDER_STATUS.ASSIGNED;
    if (details.includes('Status advanced from')) {
      const match = details.match(/to\s+["']?([^"']+)["']?$/i);
      if (match && match[1] && VALID_STATUS_VALUES.has(match[1].trim())) {
        return match[1].trim();
      }
    }
  }
  
  return null;
};

/**
 * Build a { status: ISO-string } map from activity logs.
 *
 * @param {Array<{created_at?: string, new_value?: any, action?: string, details?: string}>} logs
 *   Activity log entries, in any order. `created_at` is an ISO timestamp.
 * @param {string|null} orderCreatedAt
 *   Fallback timestamp for initial PENDING_REVIEW & PENDING steps.
 * @param {string|null} currentStatus
 *   Current order status to backfill missing timestamps for completed steps.
 * @returns {Record<string, string>}
 *   Map of ORDER_STATUS value → ISO timestamp of when it was first reached.
 */
export const deriveStatusTimestamps = (logs, orderCreatedAt = null, currentStatus = null) => {
  const map = {};

  try {
    // Baseline: Initialize initial creation statuses with order.created_at
    if (orderCreatedAt) {
      const iso = typeof orderCreatedAt === 'string' ? orderCreatedAt : String(orderCreatedAt);
      map[ORDER_STATUS.PENDING_REVIEW] = iso;
      map[ORDER_STATUS.PENDING] = iso;
    }

    if (Array.isArray(logs) && logs.length > 0) {
      // Sort ascending by created_at so "first occurrence" = earliest transition.
      const sorted = [...logs].filter(Boolean).sort((a, b) => {
        const ta = a?.created_at ? Date.parse(a.created_at) : NaN;
        const tb = b?.created_at ? Date.parse(b.created_at) : NaN;
        if (isNaN(ta) && isNaN(tb)) return 0;
        if (isNaN(ta)) return 1;
        if (isNaN(tb)) return -1;
        return ta - tb;
      });

      for (const log of sorted) {
        const status = statusFromLog(log);
        if (!status) continue;
        const iso = log?.created_at;
        if (!iso) continue;
        const strIso = typeof iso === 'string' ? iso : String(iso);

        // Explicit log entry overrides baseline orderCreatedAt
        if (!map[status] || map[status] === orderCreatedAt) {
          map[status] = strIso;
        }
      }
    }

    // Backfill missing timestamps for completed prior steps:
    // If an order has reached a later status, any completed step lacking an explicit log
    // inherits the timestamp of the preceding completed step.
    if (currentStatus) {
      const currentIdx = STATUS_TIMELINE.indexOf(currentStatus);
      if (currentIdx > 0) {
        let lastKnownTs = orderCreatedAt || map[STATUS_TIMELINE[0]];
        for (let i = 0; i <= currentIdx; i++) {
          const stepStatus = STATUS_TIMELINE[i];
          if (map[stepStatus]) {
            lastKnownTs = map[stepStatus];
          } else if (lastKnownTs) {
            map[stepStatus] = lastKnownTs;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[deriveStatusTimestamps] Failed to derive timestamps safely:', e);
  }

  return map;
};

export default deriveStatusTimestamps;
