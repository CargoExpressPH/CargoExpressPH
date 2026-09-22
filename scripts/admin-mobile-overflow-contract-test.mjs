import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const orderPage = read('src/pages/admin/OrderDetailPage.jsx');
const activityPage = read('src/pages/admin/ActivityLogsPage.jsx');
const composition = read('src/styles/admin-composition.css');
const layout = read('src/styles/layout-admin.css');
const density = read('src/styles/mobile-density.css');

assert.match(orderPage, /className="admin-order-heading mb-8"/);
assert.match(orderPage, /className="admin-order-heading-status"/);
assert.match(orderPage, /className="admin-order-payment-badges flex gap-8 flex-wrap mb-16"/);
assert.doesNotMatch(orderPage, /badge badge-error ml-8[\s\S]{0,100}height: 28/);

assert.match(composition, /\.admin-order-heading\s*\{[\s\S]*?flex-wrap:\s*wrap/);
assert.match(composition, /\.admin-order-heading h1\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
assert.match(density, /\.app-layout \.admin-order-heading h1\s*\{[\s\S]*?flex-basis:\s*100%/);
assert.match(density, /\.app-layout \.admin-order-heading-status \.badge,[\s\S]*?white-space:\s*normal/);

assert.match(activityPage, /className="activity-log-reference"/);
assert.match(activityPage, /data-label="Details" className="details-cell"/);
assert.match(layout, /\.activity-log-reference\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
assert.match(layout, /\.activity-logs-table-card \.details-cell\s*\{[\s\S]*?word-break:\s*break-word/);
assert.match(density, /@media \(max-width: 900px\)[\s\S]*?\.activity-logs-table-card \.details-cell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);

console.log('Admin mobile overflow contract tests passed.');
