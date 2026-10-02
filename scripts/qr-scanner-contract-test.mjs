// Contract test for the admin topbar package-QR scanner.
//  - parseScanPayload() reads every QR this app prints, and nothing else
//  - the scanner is reachable from the admin topbar and loaded on demand
//  - its stylesheet keeps to the old-iPhone (Safari 14) CSS rules
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTrackingNumber, orderRouteForScan, parseScanPayload } from '../src/utils/scanPayload.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const ORDER_ID = '5f35aeb0-0abd-4e8d-8c92-ac72775e03f7';

// ── Package labels (PackageQrLabels.jsx buildLabel) ─────────────────────────
assert.deepEqual(
  parseScanPayload(`https://cargoexpress-ph.vercel.app/admin/orders/${ORDER_ID}?box=2`),
  { kind: 'order', orderId: ORDER_ID, box: 2 },
);
// Labels printed from another deployment (VITE_APP_URL) still resolve in-app.
assert.deepEqual(
  parseScanPayload(`http://localhost:5173/admin/orders/${ORDER_ID.toUpperCase()}`),
  { kind: 'order', orderId: ORDER_ID, box: null },
);
assert.deepEqual(parseScanPayload(`  https://x.example/admin/orders/${ORDER_ID}/?box=0  `), { kind: 'order', orderId: ORDER_ID, box: null });
assert.equal(parseScanPayload(`https://x.example/admin/orders/${ORDER_ID}?box=2abc`).box, null);
assert.equal(parseScanPayload(`https://x.example/admin/orders/${ORDER_ID}?box=-1`).box, null);
assert.equal(parseScanPayload('https://x.example/admin/orders/not-a-uuid?box=1').kind, 'unknown');
assert.equal(parseScanPayload(`https://x.example/admin/orders/${ORDER_ID}/edit`).kind, 'unknown');
assert.equal(parseScanPayload(`https://x.example/customer/orders/${ORDER_ID}`).kind, 'unknown');

assert.equal(orderRouteForScan({ orderId: ORDER_ID, box: 3 }), `/admin/orders/${ORDER_ID}?box=3`);
assert.equal(orderRouteForScan({ orderId: ORDER_ID, box: null }), `/admin/orders/${ORDER_ID}`);

// ── Tracking numbers ────────────────────────────────────────────────────────
assert.deepEqual(parseScanPayload('CE-20260801-3261'), { kind: 'tracking', trackingNumber: 'CE-20260801-3261' });
assert.deepEqual(parseScanPayload('ce 20260801 3261'), { kind: 'tracking', trackingNumber: 'CE-20260801-3261' });
assert.deepEqual(parseScanPayload('CE202608013261'), { kind: 'tracking', trackingNumber: 'CE-20260801-3261' });
assert.deepEqual(
  parseScanPayload('https://cargoexpress-ph.vercel.app/track?q=CE-20260801-3261'),
  { kind: 'tracking', trackingNumber: 'CE-20260801-3261' },
);
assert.deepEqual(
  parseScanPayload('https://cargoexpress-ph.vercel.app/customer/track?q=ce-20260801-3261'),
  { kind: 'tracking', trackingNumber: 'CE-20260801-3261' },
);
assert.equal(parseScanPayload('https://cargoexpress-ph.vercel.app/track').kind, 'unknown');
assert.equal(normalizeTrackingNumber('CE-2026080-3261'), null);
assert.equal(normalizeTrackingNumber('xCE-20260801-3261'), null);

// ── Payment QR and everything else ──────────────────────────────────────────
assert.equal(parseScanPayload('https://checkout.paymongo.com/sources?id=src_123').kind, 'payment');
assert.equal(parseScanPayload('https://pm.link/abc').kind, 'payment');
assert.equal(parseScanPayload('https://notpaymongo.com/x').kind, 'unknown');
assert.equal(parseScanPayload('WIFI:S:office;T:WPA;P:secret;;').kind, 'unknown');
assert.equal(parseScanPayload('https://').kind, 'unknown');
assert.equal(parseScanPayload('').kind, 'unknown');
assert.equal(parseScanPayload(null).kind, 'unknown');

// ── Topbar wiring ───────────────────────────────────────────────────────────
const adminLayout = read('src/components/layout/AdminLayout.jsx');
assert.match(adminLayout, /aria-label="Scan package QR code"/);
assert.match(adminLayout, /onClick=\{openScanner\}/);
// Loaded on first tap, never in the admin shell's own chunk.
assert.match(adminLayout, /import\('\.\.\/ui\/QrScannerModal'\)/);
assert.doesNotMatch(adminLayout, /^import .*QrScannerModal/m);

const scanner = read('src/components/ui/QrScannerModal.jsx');
assert.match(scanner, /import\('jsqr'\)/, 'jsQR must stay a lazy chunk');
assert.match(scanner, /facingMode: \{ ideal: 'environment' \}/, 'an exact facingMode throws on laptops with one camera');
assert.match(scanner, /stopStream\(stream\)/, 'the camera must be released on close');
assert.match(scanner, /createPortal\(/);
assert.match(scanner, /useScrollLock\(true\)/);
assert.doesNotMatch(scanner, /\(\?<[=!]/, 'regex lookbehind breaks Safari < 16.4');

// ── Old-iPhone CSS rules ────────────────────────────────────────────────────
const css = read('src/styles/qr-scanner.css').replace(/\/\*[\s\S]*?\*\//g, '');
assert.match(read('src/styles/main.css'), /@import '\.\/qr-scanner\.css' layer\(pages\);/);
for (const match of css.matchAll(/(?:^|[;{\s])gap:\s*([^;]+);/g)) {
  assert.equal(match[1].trim(), '0', 'use margins, not flex gap (iOS < 14.5)');
}
assert.doesNotMatch(css, /aspect-ratio/, 'aspect-ratio needs iOS 15');
assert.doesNotMatch(css, /:has\(/, ':has() needs iOS 15.4');
assert.doesNotMatch(css, /color-mix\(/);
for (const match of css.matchAll(/max-height:\s*calc\(100dvh[^;]*;/g)) {
  const before = css.slice(Math.max(0, match.index - 80), match.index);
  assert.match(before, /max-height:\s*calc\(100vh[^;]*;\s*$/, 'every dvh needs a vh fallback first');
}

console.log('QR scanner contract tests passed.');
