import assert from 'node:assert/strict';
import { changeBookingRoute } from '../src/lib/bookingDraft.js';
import { scrollFocusedFieldIntoView } from '../src/hooks/useKeyboardInset.js';

const manila = { origin: 'Manila', destination: 'Bohol' };
const bohol = { origin: 'Bohol', destination: 'Manila' };
const address = {
  route: 'Manila → Bohol', trip_id: 'trip-1',
  sender_first_name: 'Alex', sender_province: 'Metro Manila', sender_city: 'Manila', sender_barangay: 'Ermita',
  receiver_province: 'Bohol', receiver_city: 'Tagbilaran City', receiver_barangay: 'Bool',
};

assert.equal(changeBookingRoute(address, address.route, manila), address,
  'reselecting the current route must not erase a typed address');
assert.deepEqual(changeBookingRoute(address, 'Bohol → Manila', bohol), {
  ...address, route: 'Bohol → Manila', trip_id: '',
  sender_province: '', sender_city: '', sender_barangay: '', sender_other_province: '',
  receiver_province: '', receiver_city: '', receiver_barangay: '',
}, 'switching routes clears the trip and dependent address levels, while keeping names');
const boholSender = { ...address, sender_province: 'Bohol', sender_city: 'Ubay', sender_barangay: 'Fatima' };
assert.equal(changeBookingRoute(boholSender, 'Bohol → Manila', bohol).sender_city, 'Ubay',
  'an already valid sender address must be preserved');

const scrolls = [];
let bottom = 650;
globalThis.window = {
  visualViewport: { offsetTop: 90, height: 450 },
  scrollBy: (options) => scrolls.push(options),
};
globalThis.document = {
  body: {},
  activeElement: {
    matches: () => true,
    closest: () => ({}),
    getBoundingClientRect: () => ({ top: bottom - 44, bottom }),
  },
};
scrollFocusedFieldIntoView();
assert.deepEqual(scrolls, [{ top: 126, behavior: 'instant' }],
  'keyboard clearance moves only the covered distance, without smooth scrolling');
bottom = 420;
scrollFocusedFieldIntoView();
assert.equal(scrolls.length, 1, 'a visible field should not cause another page jump');

console.log('Booking route and keyboard focus regression checks passed.');
