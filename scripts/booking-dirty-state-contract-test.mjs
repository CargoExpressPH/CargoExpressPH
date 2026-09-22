import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOOKING_DATA_FIELDS,
  clearBookingDraftStorage,
  hasMeaningfulBookingData,
  persistBookingDraft,
  readBookingDraft,
} from '../src/lib/bookingDraft.js';

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    snapshot: () => Object.fromEntries(values),
  };
};

assert.equal(hasMeaningfulBookingData(), false);
for (const field of BOOKING_DATA_FIELDS) {
  assert.equal(hasMeaningfulBookingData({ [field]: 'Customer entry' }), true, `${field} must make a draft meaningful`);
}
assert.equal(hasMeaningfulBookingData({ route: 'Bohol → Manila', trip_id: 'trip-1' }), false);

const storage = createStorage({ booking_form: JSON.stringify({ sender_first_name: 'Legacy Person' }), booking_step: '3' });
const userA = '00000000-0000-4000-8000-00000000000a';
const userB = '00000000-0000-4000-8000-00000000000b';
assert.equal(readBookingDraft(userA, storage), null, 'legacy unscoped PII must never be adopted');
assert.equal(storage.getItem('booking_form'), null);
assert.equal(storage.getItem('booking_step'), null);

const formA = { route: 'Manila → Bohol', sender_first_name: 'Customer A', receiver_phone: '09170000000' };
assert.equal(persistBookingDraft(userA, formA, 3, storage), true);
assert.deepEqual(readBookingDraft(userA, storage), { form: formA, step: 3 }, 'same account refresh resumes its draft');
assert.equal(readBookingDraft(userB, storage), null, 'account B cannot restore account A data');
assert.equal(persistBookingDraft(null, formA, 3, storage), false, 'expired session cannot save personal data');

persistBookingDraft(userB, { sender_first_name: 'Customer B' }, 2, storage);
clearBookingDraftStorage(userA, storage);
assert.equal(readBookingDraft(userA, storage), null, 'logout clears the signed-out account draft');
assert.equal(readBookingDraft(userB, storage).form.sender_first_name, 'Customer B', 'logout does not indiscriminately clear other scoped state');

assert.equal(persistBookingDraft(userB, { route: 'Bohol → Manila' }, 1, storage), false);
assert.equal(readBookingDraft(userB, storage), null, 'non-meaningful state removes its scoped draft');
assert.ok(Object.keys(storage.snapshot()).every(key => !['booking_form', 'booking_step'].includes(key)));

const bookingPage = readFileSync('src/pages/customer/BookShipmentPage.jsx', 'utf8');
const authContext = readFileSync('src/contexts/AuthContext.jsx', 'utf8');
assert.match(bookingPage, /readBookingDraft\(userId\)/);
assert.match(bookingPage, /draftReadyUserId !== userId/);
assert.match(bookingPage, /activeDraftUserRef\.current === userId/);
assert.match(bookingPage, /persistBookingDraft\(userId, form, step\)/);
assert.doesNotMatch(bookingPage, /sessionStorage\.getItem\('booking_(?:form|step)'/);
assert.match(authContext, /clearBookingDraftStorage\(signedInUserId\)/);

console.log(`Booking draft isolation tests passed (${BOOKING_DATA_FIELDS.length} protected fields).`);
