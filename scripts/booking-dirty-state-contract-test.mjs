import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOOKING_DATA_FIELDS,
  clearBookingDraftStorage,
  hasMeaningfulBookingData,
  persistBookingDraft,
} from '../src/lib/bookingDraft.js';

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

assert.equal(hasMeaningfulBookingData(), false, 'An empty booking must be clean.');

for (const route of ['Bohol → Manila', 'Manila → Bohol']) {
  assert.equal(
    hasMeaningfulBookingData({ route }),
    false,
    `Selecting ${route} alone must not trigger the discard modal.`,
  );
}

assert.equal(
  hasMeaningfulBookingData({
    route: 'Manila → Bohol',
    trip_id: 'trip-123',
    payer_type: 'receiver',
    payment_preference: 'gcash',
  }),
  false,
  'Setup selections alone must not be treated as entered booking data.',
);

assert.equal(
  hasMeaningfulBookingData({ sender_name: '   ', receiver_phone: '\t' }),
  false,
  'Whitespace-only values must not make a booking dirty.',
);

for (const field of BOOKING_DATA_FIELDS) {
  assert.equal(
    hasMeaningfulBookingData({ route: 'Bohol → Manila', [field]: 'Customer entry' }),
    true,
    `${field} must be protected as meaningful booking data.`,
  );
}

const setupOnlyStorage = createStorage({
  booking_form: 'stale route-only draft',
  booking_step: '2',
});
assert.equal(
  persistBookingDraft({ route: 'Bohol → Manila', trip_id: 'trip-123' }, 2, setupOnlyStorage),
  false,
  'Route/trip-only state must not be persisted.',
);
assert.equal(setupOnlyStorage.getItem('booking_form'), null);
assert.equal(setupOnlyStorage.getItem('booking_step'), null);

const meaningfulStorage = createStorage();
const meaningfulForm = { route: 'Manila → Bohol', sender_name: 'Jessie' };
assert.equal(persistBookingDraft(meaningfulForm, 3, meaningfulStorage), true);
assert.deepEqual(JSON.parse(meaningfulStorage.getItem('booking_form')), meaningfulForm);
assert.equal(meaningfulStorage.getItem('booking_step'), '3');
clearBookingDraftStorage(meaningfulStorage);
assert.equal(meaningfulStorage.getItem('booking_form'), null);
assert.equal(meaningfulStorage.getItem('booking_step'), null);

const bookingPage = readFileSync('src/pages/customer/BookShipmentPage.jsx', 'utf8');
assert.match(bookingPage, /persistBookingDraft\(form, step\)/);
assert.match(bookingPage, /delete nextLocationState\.preselectedRoute/);
assert.match(bookingPage, /delete nextLocationState\.preselectedTripId/);
assert.doesNotMatch(bookingPage, /sessionStorage\.setItem\('booking_(?:form|step)'/);

console.log(`Booking dirty-state contract tests passed (${BOOKING_DATA_FIELDS.length} protected fields).`);
