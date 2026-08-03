import { STATUS_TIMELINE } from '../constants/status';

/**
 * Build a { status: ISO-string } map from order_status_events rows.
 *
 * Previously this module reconstructed the timeline from activity_logs by
 * string matching — a 20-entry action lookup table, a "Status Changed to X"
 * prefix parse, and substring sniffing on `details`. That was necessary only
 * because status history had no home of its own; activity_logs is purged after
 * 7 days, so timelines silently collapsed to created_at once they aged out.
 *
 * order_status_events is now the permanent source (written by the
 * orders_log_status_event trigger), so this reduces to a straight fold plus
 * the backfill below.
 *
 * @param {Array<{status?: string, changed_at?: string}>} events
 *   Status events in any order. Duplicates are fine — the earliest wins,
 *   because a status can legitimately be re-entered and the timeline shows
 *   when each step was FIRST reached.
 * @param {string|null} orderCreatedAt
 *   Fallback for the initial step when no event exists (pre-backfill rows).
 * @param {string|null} currentStatus
 *   Current order status, used to backfill steps that were passed through
 *   without producing an event.
 * @returns {Record<string, string>} status → ISO timestamp
 */
export const buildStatusTimestamps = (events, orderCreatedAt = null, currentStatus = null) => {
  const map = {};

  try {
    // Baseline for orders whose creation event predates this table.
    if (orderCreatedAt) {
      const iso = typeof orderCreatedAt === 'string' ? orderCreatedAt : String(orderCreatedAt);
      map[STATUS_TIMELINE[0]] = iso;
    }

    if (Array.isArray(events)) {
      for (const event of events) {
        const status = event?.status;
        const iso = event?.changed_at;
        if (!status || !iso) continue;

        const strIso = typeof iso === 'string' ? iso : String(iso);
        const existing = map[status];

        // Earliest occurrence wins. The baseline above is provisional, so a
        // real event always replaces it.
        if (!existing || existing === orderCreatedAt || Date.parse(strIso) < Date.parse(existing)) {
          map[status] = strIso;
        }
      }
    }

    // Backfill: if the order has reached a later step, any earlier completed
    // step with no event of its own inherits the preceding step's timestamp.
    // Still needed — trip-cascade updates can skip intermediate statuses, and
    // historical rows predate the events table.
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
    console.warn('[buildStatusTimestamps] Failed to build timestamps safely:', e);
  }

  return map;
};

export default buildStatusTimestamps;
