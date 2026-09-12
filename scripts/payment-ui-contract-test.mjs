import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatRecordedBy } from '../src/utils/paymentDisplay.js';
import { isPaymentPollReconciled } from '../src/utils/paymentReconciliation.js';

const read = path => readFileSync(path, 'utf8');
const modal = read('src/components/ui/PaymentResultModal.jsx');
const styles = read('src/styles/feedback.css');
const tokens = read('src/styles/tokens.css');
const customerOrderDetail = read('src/pages/customer/OrderDetailPage.jsx');
const adminOrderDetail = read('src/pages/admin/OrderDetailPage.jsx');

assert.equal(isPaymentPollReconciled({ orderReconciled: true, status: 'paid' }), true);
assert.equal(isPaymentPollReconciled({ orderReconciled: false, status: 'paid', settling: true }), false);
assert.equal(isPaymentPollReconciled({ status: 'paid' }), false);
assert.doesNotMatch(customerOrderDetail, /result\.orderReconciled\s*\|\|\s*result\.status\s*===\s*['"]paid['"]/);
assert.doesNotMatch(adminOrderDetail, /result\.orderReconciled\s*\|\|\s*result\.status\s*===\s*['"]paid['"]/);
assert.match(customerOrderDetail, /isPaymentPollReconciled\(result\)/);
assert.equal((adminOrderDetail.match(/isPaymentPollReconciled\(result\)/g) || []).length, 2);

assert.match(modal, /payment was not completed\. Try again or choose another payment option\./);
assert.doesNotMatch(modal, /No charges were made/);
assert.match(styles, /\.pr-btn-success\s*\{[\s\S]*?background:\s*var\(--success-fill\)/);
assert.match(styles, /\.pr-btn-danger\s*\{[\s\S]*?background:\s*var\(--error-fill\)/);
assert.equal(formatRecordedBy('System Webhook', 'customer'), 'Payment System (GCash verified)');
assert.equal(formatRecordedBy('System', 'customer'), 'Payment System (GCash verified)');
assert.equal(formatRecordedBy('Maria Santos', 'customer'), 'Maria Santos');

const relativeLuminance = hex => {
  const channels = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255);
  const linear = channels.map(value => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
};

const contrastWithWhite = hex => (1.05 / (relativeLuminance(hex) + 0.05));
for (const token of ['success-fill', 'error-fill']) {
  const match = tokens.match(new RegExp(`--${token}:\\s*(#[a-f\\d]{6})`, 'i'));
  assert.ok(match, `Missing --${token}`);
  assert.ok(contrastWithWhite(match[1]) >= 4.5, `${token} must pass WCAG AA with white text`);
}

console.log('Payment UI contract tests passed.');
