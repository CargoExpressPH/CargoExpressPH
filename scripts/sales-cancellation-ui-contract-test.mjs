import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');

const salesPage = read('src/pages/admin/SalesPage.jsx');
const chart = read('src/components/ui/MiniBarChart.jsx');
const reportsPage = read('src/pages/admin/ReportsPage.jsx');
const adminOrder = read('src/pages/admin/OrderDetailPage.jsx');
const customerOrder = read('src/pages/customer/OrderDetailPage.jsx');
const settlementSummary = read('src/components/ui/CancellationSettlementSummary.jsx');
const settlementModal = read('src/components/ui/CancellationSettlementModal.jsx');
const statuses = read('src/constants/status.js');

assert.match(salesPage, /useRealtimeOrders\(\{[\s\S]*debounceMs:\s*1200[\s\S]*onBatch:/,
  'Sales Overview must debounce realtime order refreshes.');
assert.match(salesPage, /requestSequenceRef[\s\S]*sequence !== requestSequenceRef\.current/,
  'Stale Sales Overview requests must not replace newer results.');
assert.match(salesPage, /addEventListener\('focus',[\s\S]*addEventListener\('pageshow'/,
  'Sales Overview must refresh after tab/window restoration.');
assert.match(salesPage, /phDateKey[\s\S]*T00:00:00\+08:00/,
  'Sales Overview must schedule its day boundary using Manila time.');
assert.match(salesPage, /Last updated[\s\S]*Refreshing…[\s\S]*Refresh/,
  'Sales Overview must expose freshness and manual refresh controls.');
assert.match(salesPage, /Net Collected Today[\s\S]*Successful collections minus successful refunds, using Asia\/Manila dates\./,
  'The Today metric must explain its net, Manila-date meaning.');
assert.doesNotMatch(salesPage, /202[0-9]/,
  'Sales Overview must not hardcode a display year.');
assert.match(chart, /numericValue <= 0 \? 0/,
  'A zero-value month must render as a zero-height bar.');

for (const label of [
  'Original Payment Method',
  'Gross Received',
  'Refunds of These Payments',
  'Net Retained',
]) {
  assert.ok(reportsPage.includes(label), `Reports must include “${label}” on screen and in print.`);
}
assert.ok(
  reportsPage.includes('Refunds are grouped by the original payment method; refund destination details remain in the transaction history.'),
  'Reports must explain original-method grouping without hiding refund destinations.',
);

for (const source of [adminOrder, customerOrder]) {
  assert.match(source, /CancellationSettlementSummary/,
    'Both order-detail experiences must use the canonical cancelled summary.');
}
for (const label of [
  'Payment & Refund Summary',
  'Historical final charge',
  'Gross collected',
  'Successfully refunded',
  'Net retained',
  'Agreed cancellation fee',
  'Refund still due',
]) {
  assert.ok(settlementSummary.includes(label), `Cancelled summary must include “${label}”.`);
}
assert.match(settlementSummary, /Historical payment promise:[\s\S]*no longer actionable after cancellation/,
  'A cancelled booking may show the promise only as historical context.');
assert.match(settlementModal, /does not move money/i,
  'The decision UI must make clear that confirmation does not issue a refund.');
assert.match(settlementModal, /Amend recorded decision/,
  'Changing a confirmed decision must be an explicit amendment.');
assert.match(statuses, /CANCELLED:\s*'cancelled'/,
  'Cancelled must be a canonical settlement state, not Settled.');

console.log('Sales and cancellation UI contract tests passed.');
