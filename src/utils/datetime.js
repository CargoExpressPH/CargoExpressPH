/**
 * Philippine-time date helpers.
 *
 * Cargo Express operates on a single route inside one country, so every date a
 * user reads or types is Philippine Standard Time (UTC+8, no DST). Two places
 * previously let the browser decide instead, and they cancelled out into an
 * off-by-one-day ETA:
 *
 *  1. WRITE — a `datetime-local` input yields a naive string with no
 *     offset ("2026-08-11T18:00"). Sent as-is into a TIMESTAMPTZ column,
 *     Postgres resolves it in the *server's* zone (UTC), so 6:00 PM Manila was
 *     stored as 18:00Z — eight hours late, which is 2:00 AM the next day here.
 *  2. READ — `toLocaleDateString()` with no `timeZone` renders in whatever zone
 *     the viewer's machine is set to, so the same row read differently abroad.
 *
 * Both ends are now pinned to Asia/Manila.
 */

export const PH_TIME_ZONE = 'Asia/Manila';
export const PH_LOCALE = 'en-PH';
const PH_UTC_OFFSET = '+08:00';

/**
 * Naive `datetime-local` value → offset-qualified ISO string.
 * "2026-08-11T18:00" → "2026-08-11T18:00:00+08:00"
 *
 * The offset is fixed rather than read from the browser on purpose: an admin
 * travelling (or a machine with a wrong clock zone) must still book 6:00 PM as
 * 6:00 PM Manila, because that is when the vessel actually leaves.
 */
export const phLocalInputToISO = (value) => {
  if (!value) return null;
  // Already carries a zone (ISO with Z or ±hh:mm) — leave it alone.
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return `${withSeconds}${PH_UTC_OFFSET}`;
};

/**
 * Timestamp → the `datetime-local` value that renders it in PH time, for
 * populating an edit form without shifting the instant.
 */
export const isoToPhLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PH_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const formatInPH = (value, opts) => {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(PH_LOCALE, { timeZone: PH_TIME_ZONE, ...opts }).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, { timeZone: PH_TIME_ZONE, ...opts }).format(d);
  }
};

/** "Aug 11, 2026" — always the PH calendar day. */
export const formatPhDate = (value, opts = {}) =>
  formatInPH(value, { year: 'numeric', month: 'short', day: 'numeric', ...opts });

/** "Aug 11, 2026, 6:00 PM" — always the PH wall clock. */
export const formatPhDateTime = (value, opts = {}) =>
  formatInPH(value, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', ...opts,
  });
