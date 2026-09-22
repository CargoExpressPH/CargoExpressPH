import { TRIP_STATUS } from '../constants/status';
import { phDateKey } from '../utils/datetime';

const CAPACITY_TRIP_STATUSES = new Set([
  TRIP_STATUS.SCHEDULED,
  TRIP_STATUS.IN_PROGRESS,
  TRIP_STATUS.ARRIVED,
]);

const compareStableText = (left, right) => {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a.localeCompare(b, 'en', { sensitivity: 'base' })
    || a.localeCompare(b, 'en');
};

/**
 * Select the earliest still-operational trip for the single capacity summary.
 * `departure_date` is a date-only Manila schedule stored as timestamptz, so
 * compare its Asia/Manila calendar key rather than the viewer's local date.
 * Ties are resolved by trip number and then primary key, never creation time.
 */
export const selectEarliestCapacityTrip = (trips = []) => trips
  .filter((trip) => CAPACITY_TRIP_STATUSES.has(trip?.status) && phDateKey(trip?.departure_date))
  .slice()
  .sort((a, b) => (
    phDateKey(a.departure_date).localeCompare(phDateKey(b.departure_date))
    || compareStableText(a.trip_number, b.trip_number)
    || compareStableText(a.id, b.id)
  ))[0] || null;

export const isScheduledTripOverdue = (trip, now = new Date()) => (
  trip?.status === TRIP_STATUS.SCHEDULED
  && Boolean(phDateKey(trip.departure_date))
  && phDateKey(trip.departure_date) < phDateKey(now)
);
