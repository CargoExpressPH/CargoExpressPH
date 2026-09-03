import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/pages/admin/UnsettledDeliveriesPage.jsx', 'utf8');
const styles = readFileSync('src/styles/tables-mobile.css', 'utf8');
const adminStyles = readFileSync('src/styles/admin-modern-refresh.css', 'utf8');

for (const className of [
  'unsettled-table-card',
  'unsettled-table',
  'unsettled-settlement-cell',
  'unsettled-money-cell',
  'unsettled-action-cell',
]) {
  assert.match(page, new RegExp(`className=[^\\n]*${className}`), `${className} must remain in the report markup.`);
  assert.match(styles, new RegExp(`\\.${className}(?:[\\s.{:#]|$)`), `${className} must remain covered by mobile CSS.`);
}

assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
assert.match(styles, /\.unsettled-action-cell \.btn:not\(\.message-customer-btn\)[\s\S]*?width: 100%/);
assert.match(styles, /\.unsettled-settlement-cell[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
assert.match(adminStyles, /@media \(hover: none\) and \(pointer: coarse\)/);
assert.match(adminStyles, /\.app-layout \.unsettled-table tbody tr:hover/);

console.log('Unsettled deliveries mobile-layout contract passed.');
