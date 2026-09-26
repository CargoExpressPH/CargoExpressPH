import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const orderPage = read('src/pages/admin/OrderDetailPage.jsx');
const activityPage = read('src/pages/admin/ActivityLogsPage.jsx');
const composition = read('src/styles/admin-composition.css');
const layout = read('src/styles/layout-admin.css');
const density = read('src/styles/mobile-density.css');
const mainStyles = read('src/styles/main.css');
const tripDetail = read('src/styles/trip-detail.css');
const adminLayout = read('src/components/layout/AdminLayout.jsx');

// These selectors have equal specificity in the same layer. Keep the mobile
// overrides after the desktop rules, including when changing CSS loading.
const compositionImport = mainStyles.indexOf("@import './admin-composition.css' layer(pages);");
const tripDetailImport = mainStyles.indexOf("@import './trip-detail.css' layer(pages);");
assert.ok(compositionImport >= 0 && tripDetailImport > compositionImport,
  'Admin composition must load before the mobile trip detail overrides');
assert.doesNotMatch(adminLayout, /admin-route\.css/);
assert.match(tripDetail, /@media \(max-width: 820px\)\s*\{\s*\.admin-toolbar\s*\{\s*grid-template-columns:\s*1fr/);
assert.match(tripDetail, /\.admin-page-meta\s*\{\s*justify-content:\s*flex-start;\s*width:\s*100%/);
assert.match(tripDetail, /\.admin-detail-grid\s*\{\s*grid-template-columns:\s*1fr/);
assert.match(tripDetail, /\.admin-action-card \.card-body\s*\{\s*align-items:\s*stretch/);

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
