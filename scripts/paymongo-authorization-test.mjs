import assert from 'node:assert/strict';
import { authorizeOrderUpdate } from '../supabase/functions/paymongo-create-payment/authorization.js';

const ORDER_ID = '00000000-0000-0000-0000-000000000123';

const customerOrderOnly = authorizeOrderUpdate({ orderId: ORDER_ID }, false);
assert.deepEqual(customerOrderOnly, { value: { orderId: ORDER_ID } });

for (const maliciousUpdate of [
  { orderId: ORDER_ID, actualWeight: 1 },
  { orderId: ORDER_ID, payerType: 'receiver' },
  { orderId: ORDER_ID, pickupPhotos: ['pickup-proofs/another-order/photo.jpg'] },
  { orderId: ORDER_ID, actualWeight: null },
]) {
  const result = authorizeOrderUpdate(maliciousUpdate, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /Customers are not authorized/);
  assert.equal(result.value, undefined);
}

const adminPickup = authorizeOrderUpdate({
  orderId: ORDER_ID,
  actualWeight: 10.25,
  payerType: 'receiver',
  pickupPhotos: [{ type: 'supabase_storage', path: 'pickup-proofs/CE-TEST/photo.jpg' }],
}, true);
assert.deepEqual(adminPickup, {
  value: {
    orderId: ORDER_ID,
    actualWeight: 10.25,
    payerType: 'receiver',
    pickupPhotos: [{ type: 'supabase_storage', path: 'pickup-proofs/CE-TEST/photo.jpg' }],
  },
});

for (const weight of [0, -1, 10000.01, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
  const result = authorizeOrderUpdate({ orderId: ORDER_ID, actualWeight: weight }, true);
  assert.equal(result.status, 400);
  assert.match(result.error, /Actual weight/);
}

for (const payerType of ['', 'customer', 'Sender', null]) {
  const result = authorizeOrderUpdate({ orderId: ORDER_ID, payerType }, true);
  assert.equal(result.status, 400);
  assert.match(result.error, /Payer type/);
}

const tooManyPhotos = authorizeOrderUpdate({
  orderId: ORDER_ID,
  pickupPhotos: ['1.jpg', '2.jpg', '3.jpg', '4.jpg'],
}, true);
assert.equal(tooManyPhotos.status, 400);

assert.equal(authorizeOrderUpdate(null, false).status, 400);
assert.equal(authorizeOrderUpdate({}, true).status, 400);

console.log('PayMongo authorization tests passed.');
