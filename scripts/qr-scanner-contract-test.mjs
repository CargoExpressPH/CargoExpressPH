// Contract test for the admin topbar package-QR scanner.
//  - parseScanPayload() reads every QR this app prints, and nothing else
//  - the scanner is reachable from the admin topbar and loaded on demand
//  - its stylesheet keeps to the old-iPhone (Safari 14) CSS rules
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTrackingNumber, orderRouteForScan, parseScanPayload } from '../src/utils/scanPayload.js';
import { maskPersonName, maskPhone } from '../src/utils/maskName.js';
import { summarizeManualScans } from '../src/utils/manualScanFlags.js';

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

// ── Trip scanner field fallbacks ────────────────────────────────────────────
assert.equal(maskPersonName('Bea Sarong'), 'B*a S****g');
assert.equal(maskPersonName('Al'), 'A*');
assert.equal(maskPersonName(''), '');
assert.equal(maskPhone('09171234567'), '0917•••4567');

const tripScanner = read('src/components/ui/TripScannerModal.jsx');
assert.match(tripScanner, /Can&apos;t Scan QR\?/, 'Case A entry point');
assert.match(tripScanner, /onUnidentified=\{/, 'Case B is reached from the manual overlay');
assert.doesNotMatch(tripScanner, /Damaged \/ Unidentified Label/, 'single fallback button');
assert.match(tripScanner, /playWrongRouteSound\(\)/, 'wrong-route hard block');
assert.match(tripScanner, /findOrderTripForScan/, 'wrong-route names the other trip');
assert.match(tripScanner, /reportAndApproveShortfall/, 'shortfall release');
assert.match(tripScanner, /findDuplicateScan/, 'duplicate scans are caught locally');
assert.match(tripScanner, /startOnlineSync/, 'offline queue flushes when back online');
assert.doesNotMatch(tripScanner, /SUP-\d{4}/, 'no supervisor code may ship in the client');

const caseA = read('src/components/ui/ManualBoxMatchOverlay.jsx');
assert.match(caseA, /Confirm Match/);
assert.match(caseA, /maskPersonName/, 'recipient is masked on screen');

const caseB = read('src/components/ui/UnidentifiedBoxModal.jsx');
assert.match(caseB, /href=\{`tel:/, 'call-the-customer button');
assert.match(caseB, /capture="environment"/, 'damaged-box photo input');
assert.match(caseB, /Boolean\(pick && photo && signatureCanvas\)/, 'photo AND signature are both required');

// ── Manual-fallback audit flags ─────────────────────────────────────────────
const at = (sec) => new Date(Date.UTC(2026, 9, 20, 8, 0, sec)).toISOString();
const manual = (sec) => ({ method: 'manual_fallback', scanned_at: at(sec) });
const camera = (sec) => ({ method: 'qr', scanned_at: at(sec) });
assert.deepEqual(summarizeManualScans([camera(0), camera(5), manual(60)], 10).flags, [], 'one manual box in ten is normal');
assert.equal(summarizeManualScans([manual(0), manual(120), camera(5)], 4).flags[0].code, 'high_manual_rate');
assert.equal(summarizeManualScans([manual(0), manual(10), manual(20), camera(1)], 40).flags[0].code, 'manual_burst');
assert.deepEqual(summarizeManualScans([manual(0), manual(100), manual(200)], 40).flags, [], 'spread-out manual boxes are not a burst');
assert.equal(summarizeManualScans([], 0).manualCount, 0);

const overlay = read('src/components/ui/ManualBoxMatchOverlay.jsx');
assert.match(overlay, /disabled={!box || !reason || busy}/, 'Confirm Match is locked until a reason is chosen');

// ── No tap-to-verify shortcut; search accepts partial tracking numbers ──────
assert.doesNotMatch(tripScanner, /handleManualVerifyBox|\+ Verify Box/, 'boxes verify by camera or the reasoned fallback only');
assert.doesNotMatch(tripScanner, /Trip Manifest/);
assert.match(tripScanner, /Trip Cargo List/);
assert.doesNotMatch(overlay, /SHORT_CODE_LENGTH/, 'a typed code is not limited to exactly 6 characters');
assert.match(overlay, /code\.length < MIN_SEARCH_LENGTH/);
assert.match(overlay, /\.includes\(code\)/);

console.log('QR scanner contract tests passed.');
