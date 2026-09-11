import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clearPendingPayment,
  getPendingPayment,
  savePendingPayment,
} from '../src/lib/pendingPayment.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

const ORDER_ID = '00000000-0000-0000-0000-000000000123';
const CUSTOMER_ID = '00000000-0000-0000-0000-000000000456';
const ADMIN_ID = '00000000-0000-0000-0000-000000000789';

const storage = new MemoryStorage();
assert.equal(savePendingPayment({
  orderId: ORDER_ID,
  sourceId: 'src_unscoped',
  amount: 100,
  role: 'customer',
  userId: undefined,
}, storage), false, 'new pending-payment records must always be account-scoped');

assert.equal(savePendingPayment({
  orderId: ORDER_ID,
  sourceId: 'src_customer',
  amount: 100,
  role: 'customer',
  userId: CUSTOMER_ID,
}, storage), true);

assert.deepEqual(
  getPendingPayment({ orderId: ORDER_ID, role: 'customer', userId: CUSTOMER_ID }, storage),
  { sourceId: 'src_customer', amount: 100 },
  'the initiating customer should recover their exact source',
);
assert.equal(
  getPendingPayment({ orderId: ORDER_ID, role: 'admin', userId: ADMIN_ID }, storage),
  null,
  'an admin must never inherit a customer source from the same browser',
);
assert.equal(
  getPendingPayment({ orderId: ORDER_ID, role: 'customer', userId: 'another-user' }, storage),
  null,
  'a different customer account must never inherit the source',
);
assert.equal(
  getPendingPayment({ orderId: ORDER_ID, role: 'customer', userId: undefined }, storage),
  null,
  'an account-bound source must wait until the active user is known',
);

savePendingPayment({
  orderId: ORDER_ID,
  sourceId: 'src_admin',
  amount: 125,
  role: 'admin',
  userId: ADMIN_ID,
}, storage);
assert.deepEqual(
  getPendingPayment({ orderId: ORDER_ID, role: 'admin', userId: ADMIN_ID }, storage),
  { sourceId: 'src_admin', amount: 125 },
  'opening GCash as admin should replace the browser context with the exact admin source',
);
assert.equal(
  getPendingPayment({ orderId: ORDER_ID, role: 'customer', userId: CUSTOMER_ID }, storage),
  null,
  'the replaced admin context must not be visible to a customer',
);

clearPendingPayment(ORDER_ID, storage);
assert.equal(getPendingPayment({ orderId: ORDER_ID, role: 'admin', userId: ADMIN_ID }, storage), null);

// Compatibility for a customer who entered checkout before this release.
storage.setItem(`pending_payment_${ORDER_ID}`, 'src_legacy_customer');
storage.setItem(`pending_payment_amount_${ORDER_ID}`, '75');
assert.deepEqual(
  getPendingPayment({ orderId: ORDER_ID, role: 'customer', userId: CUSTOMER_ID }, storage),
  { sourceId: 'src_legacy_customer', amount: 75 },
);
assert.equal(
  getPendingPayment({ orderId: ORDER_ID, role: 'admin', userId: ADMIN_ID }, storage),
  null,
  'legacy unscoped sources are deliberately ignored by admins',
);

clearPendingPayment(ORDER_ID, storage);
assert.equal(storage.getItem(`pending_payment_${ORDER_ID}`), null);
assert.equal(storage.getItem(`pending_payment_amount_${ORDER_ID}`), null);

const customerPage = readFileSync('src/pages/customer/OrderDetailPage.jsx', 'utf8');
const returnPage = readFileSync('src/pages/shared/PaymentReturnPage.jsx', 'utf8');
const collectionPanel = readFileSync('src/components/ui/PaymentCollectionPanel.jsx', 'utf8');
const additionalModal = readFileSync('src/components/ui/AdditionalPaymentModal.jsx', 'utf8');

assert.match(customerPage, /addEventListener\('pageshow',\s*handlePageShow\)/);
assert.match(customerPage, /setProcessingPayment\(false\)/);
assert.match(returnPage, /getPendingPayment\(\{ orderId, role, userId: user\?\.id \}\)/);
assert.match(collectionPanel, /await registerSource\([\s\S]*?savePendingPayment\(\{[\s\S]*?role: 'admin',[\s\S]*?userId: user\?\.id/);
assert.match(additionalModal, /await registerSource\([\s\S]*?savePendingPayment\(\{[\s\S]*?role: 'admin',[\s\S]*?userId: user\?\.id/);

console.log('Payment return state contract tests passed.');
