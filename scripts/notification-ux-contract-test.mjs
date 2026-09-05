import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getAdminNotificationRoute,
  getCustomerNotificationRoute,
} from '../src/lib/notification-routing.js';

const read = path => readFileSync(path, 'utf8');
const customerPage = read('src/pages/customer/NotificationsPage.jsx');
const customerLayout = read('src/components/layout/CustomerLayout.jsx');
const adminLayout = read('src/components/layout/AdminLayout.jsx');
const database = read('src/lib/database.js');

const orderId = '5f35aeb0-0abd-4e8d-8c92-ac72775e03f7';

assert.equal(getCustomerNotificationRoute({ type: 'order_update', reference_id: orderId }), `/customer/orders/${orderId}`);
assert.equal(getCustomerNotificationRoute({ type: 'payment_update', reference_id: orderId }), `/customer/orders/${orderId}`);
assert.equal(getCustomerNotificationRoute({ type: 'general', reference_id: orderId }), `/customer/orders/${orderId}`);
assert.equal(getCustomerNotificationRoute({ type: 'trip_update', reference_id: orderId }), '/customer/trips');
assert.equal(getCustomerNotificationRoute({ type: 'chat_message' }), '/customer/support');
assert.equal(getCustomerNotificationRoute({ type: 'system_alert' }), null);

assert.equal(getAdminNotificationRoute({ type: 'order_update', reference_id: orderId }), `/admin/orders/${orderId}`);
assert.equal(getAdminNotificationRoute({ type: 'inquiry' }), '/admin/contact-inquiries');
assert.equal(getAdminNotificationRoute({ type: 'chat_message' }), '/admin/inbox');
assert.equal(getAdminNotificationRoute({ type: 'feedback' }), '/admin/feedback');
assert.equal(getAdminNotificationRoute({ type: 'system_alert', title: 'Storage Warning' }), '/admin/storage-monitoring');
assert.equal(getAdminNotificationRoute({ type: 'system_alert', title: 'Push Delivery Health Alert' }), '/admin');

for (const type of [
  'order_update',
  'trip_update',
  'announcement',
  'general',
  'inquiry',
  'feedback',
  'chat_message',
  'system_alert',
  'payment_update',
]) {
  assert.match(customerPage, new RegExp(`${type}:`), `customer icon missing for ${type}`);
}

assert.match(customerPage, /getCustomerNotificationRoute\(n\)/);
assert.match(database, /emitNotificationsChanged\(\)/);
assert.match(customerLayout, /NOTIFICATIONS_CHANGED_EVENT/);
assert.match(adminLayout, /NOTIFICATIONS_CHANGED_EVENT/);

console.log('Notification UX contract tests passed.');
