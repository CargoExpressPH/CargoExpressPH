import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createPaymentIdempotencyKey } from '../src/utils/paymentCollection.js';

const fixture = {
  id: '00000000-0000-4000-8000-000000000101',
  tracking_number: 'QA-PICKUP-LEGACY-001',
  status: 'Assigned',
  sender_name: 'Test Sender',
  receiver_name: 'Test Receiver',
  package_description: null,
  trip_id: '00000000-0000-4000-8000-000000000201',
  trips: { id: '00000000-0000-4000-8000-000000000201', capacity: 1000, price_per_kg: 70 },
  // Intentionally omit optional payment and discount fields to cover legacy rows.
};

const deterministicBytes = Uint8Array.from({ length: 16 }, (_, index) => index);
const fallbackKey = createPaymentIdempotencyKey({
  getRandomValues(bytes) {
    bytes.set(deterministicBytes);
    return bytes;
  },
});
assert.match(fallbackKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

const mockModules = {
  'lib/database': `export const getTripCurrentWeight = async () => 0;
    export const getPaymentAttemptBySource = async () => null;
    export const getOrderPaymentSnapshot = async () => null;`,
  'lib/paymongo': `export const createGCashSource = async () => { throw new Error('unexpected provider call'); };
    export const registerSource = async () => { throw new Error('unexpected provider call'); };
    export const pollPaymentStatus = async () => null;`,
  'lib/storage': `export const uploadMultiplePhotos = async () => [];
    export const uploadPhoto = async () => null;
    export const deletePhoto = async () => {};`,
  'lib/pendingPayment': `export const clearPendingPayment = () => {};
    export const savePendingPayment = () => {};`,
  'lib/paymentReturnContext': `export const savePaymentReturnContext = () => {};`,
  'lib/supabase': `export const supabase = {};`,
  'contexts/AuthContext': `export const useAuth = () => ({ user: null });`,
  'hooks/useToast': `export const useToast = () => ({ success() {}, error() {}, warning() {}, info() {} });`,
};

const bundle = await build({
  absWorkingDir: process.cwd(),
  entryPoints: [resolve('scripts/fixtures/PickupModalMountHarness.jsx')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  logLevel: 'silent',
  plugins: [{
    name: 'isolate-network-backed-modules',
    setup(buildApi) {
      buildApi.onResolve({ filter: /(?:lib\/database|lib\/paymongo|lib\/storage|lib\/pendingPayment|lib\/paymentReturnContext|lib\/supabase|contexts\/AuthContext|hooks\/useToast)(?:\.jsx?)?$/ }, (args) => {
        const key = Object.keys(mockModules).find((name) => args.path.replace(/\.jsx?$/, '').endsWith(name));
        return key ? { path: key, namespace: 'pickup-test-mock' } : undefined;
      });
      buildApi.onLoad({ filter: /.*/, namespace: 'pickup-test-mock' }, (args) => ({
        contents: mockModules[args.path],
        loader: 'js',
      }));
    },
  }],
});
const bundledHarness = bundle.outputFiles[0].text;

let browser;
const pageErrors = [];
const consoleErrors = [];
const requests = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  await context.addInitScript((order) => { window.__pickupRenderFixture = order; }, fixture);
  const page = await context.newPage();
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.evaluate((code) => { (new Function(code))(); }, bundledHarness);
  await page.getByRole('button', { name: 'Process Pickup' }).click();
  await page.getByRole('heading', { name: 'Pickup Processing' }).waitFor();
  assert.equal(await page.getByLabel('Actual Weight (kg) *').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Confirm Pickup' }).count(), 1);
  await page.getByLabel('Actual Weight (kg) *').fill('50');
  await page.getByText('Estimated cost: ₱3,500.00').waitFor();
  await page.getByLabel('Apply Discount').check();
  await page.getByLabel('Discount Amount (₱) *').fill('500');
  await page.getByText('Final Cargo Fee').waitFor();
  assert.equal(await page.getByText('₱3,000.00').count() > 0, true, 'weight and discount preview should render');

  // The harness intentionally has no production CSS, so invoke the real Cancel
  // button handler directly instead of asserting a visual viewport position.
  await page.getByRole('button', { name: 'Cancel' }).evaluate((button) => button.click());
  await page.getByRole('heading', { name: 'Pickup Processing' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Process Pickup' }).click();
  await page.getByRole('heading', { name: 'Pickup Processing' }).waitFor();

  assert.deepEqual(await page.evaluate(() => window.__pickupRenderCalls), { save: 0, prepare: 0 });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(requests, [], 'isolated component harness must not issue browser network requests');
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined', 'regression test must exercise a browser without randomUUID');
  assert.match(await page.evaluate(() => window.__pickupRenderInitialIdempotencyKey), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  console.log('PASS: Chromium without crypto.randomUUID mounted Process Pickup, closed/reopened it, and made no writes.');
  console.log('No browser network requests, page errors, or console errors.');
} catch (error) {
  console.error('FAIL: mounted pickup modal render reproduction');
  console.error(error.stack || error);
  if (pageErrors.length) console.error('Browser page errors:', pageErrors.join('\n'));
  if (consoleErrors.length) console.error('Browser console errors:', consoleErrors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
