import assert from 'node:assert/strict';
import {
  BOOKING_DATA_FIELDS,
  hasMeaningfulBookingData,
} from '../src/lib/bookingDraft.js';

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

console.log(`Booking dirty-state contract tests passed (${BOOKING_DATA_FIELDS.length} protected fields).`);
