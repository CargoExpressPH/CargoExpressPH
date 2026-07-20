// ─────────────────────────────────────────────────────────────────────────────
// deriveStatusTimestamps
//
// Maps a list of activity-log entries (as fetched by getActivityLogsByRecord)
// to a { [status]: ISO-string } map — the timestamp at which each shipment
// status was first reached.
//
// Used by the admin Order Detail page to show a real, per-step timestamp
// under each node of the TrackingTimeline.
//
// Data source note:
//   The `orders` table has no per-status timestamp columns, and activity_logs
//   is admin-only (RLS `is_admin()`). So this derivation is only valid in
//   contexts that can already read activity_logs (the admin order detail page,
//   which loads activityHistory up-front). Customer and public pages cannot
//   use this and must omit timestamps.
//
// Resolution order per log entry (most authoritative first):
//   1. log.new_value.status  → direct "this status was set to X" (covers
//      `Status Changed to X`, `Order Assigned`, `Order Cancelled`, trip
//      cascade updates, and the historical auto-assign path in database.js)
//   2. action-string fallback → for logs that set status implicitly without
//      recording it in new_value:
//        'Pickup Processed'        → 'Picked Up'
//        'Delivery Proof Uploaded' → 'Delivered'
//        'Assigned to Trip'        → 'Assigned'
//        'Out-of-Coverage Request Approved' → 'Pending'
//
// Only the FIRST occurrence of each status is kept (earliest transition wins),
// which matches user expectation: the timeline shows when the step was reached.
// ─────────────────────────────────────────────────────────────────────────────

import { ORDER_STATUS } from '../constants/status';

// Action strings that imply a status change but don't carry new_value.status.
// Keep this list in sync with the logOrder(...) call sites across the app.
const ACTION_STATUS_FALLBACK = {
  'Pickup Processed': ORDER_STATUS.PICKED_UP,
  'Delivery Proof Uploaded': ORDER_STATUS.DELIVERED,
  'Assigned to Trip': ORDER_STATUS.ASSIGNED,
  'Out-of-Coverage Request Approved': ORDER_STATUS.PENDING,
};

/**
 * Extract a status string from a single activity log entry.
 * @returns {string|null} a value from ORDER_STATUS, or null if not a status change.
 */
const statusFromLog = (log) => {
  // 1. Authoritative: explicit new_value.status
  const nv = log?.new_value;
  if (nv && typeof nv === 'object' && typeof nv.status === 'string' && nv.status.trim()) {
    return nv.status.trim();
  }
  // 2. Fallback: known action strings
  const action = log?.action;
  if (action && Object.prototype.hasOwnProperty.call(ACTION_STATUS_FALLBACK, action)) {
    return ACTION_STATUS_FALLBACK[action];
  }
  // 3. `Status Changed to X` — defensive parse in case new_value was stripped
  //    but the action still carries the target status.
  if (typeof action === 'string' && action.startsWith('Status Changed to ')) {
    const target = action.slice('Status Changed to '.length).trim();
    if (target) return target;
  }
  return null;
};

/**
 * Build a { status: ISO-string } map from activity logs.
 *
 * @param {Array<{created_at?: string, new_value?: any, action?: string}>} logs
 *   Activity log entries, in any order. `created_at` is an ISO timestamp.
 * @returns {Record<string, string>}
 *   Map of ORDER_STATUS value → ISO timestamp of when it was first reached.
 *   Empty object if logs is empty/invalid.
 */
export const deriveStatusTimestamps = (logs) => {
  if (!Array.isArray(logs) || logs.length === 0) return {};

  // Sort ascending by created_at so "first occurrence" = earliest transition.
  // Guard against malformed entries (missing/invalid created_at → sent to end).
  const sorted = [...logs].sort((a, b) => {
    const ta = a?.created_at ? Date.parse(a.created_at) : NaN;
    const tb = b?.created_at ? Date.parse(b.created_at) : NaN;
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return ta - tb;
  });

  const map = {};
  for (const log of sorted) {
    const status = statusFromLog(log);
    if (!status) continue;
    // Earliest wins — once set, don't overwrite.
    if (map[status]) continue;
    const iso = log?.created_at;
    if (!iso) continue;
    map[status] = iso;
  }
  return map;
};

export default deriveStatusTimestamps;
