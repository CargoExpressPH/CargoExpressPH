import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const functions = [...readFileSync('src/lib/database.js', 'utf8').matchAll(/export const (\w+)/g)].map(match => match[1]);
const virtual = kind => `\0history-ui-${kind}`;
const mocks = {
  database: functions.map(name => name === 'withTimeout'
    ? 'export const withTimeout = promise => promise;'
    : `export const ${name} = (...args) => globalThis.__historyUI.call('${name}', args);`).join('\n'),
  auth: `export const useAuth = () => ({ user: { id: 'fixture-user' }, userProfile: { role: 'admin' }, login: async () => ({ success: true, profile: { name: 'Fixture' } }), resendSignupConfirmation: async () => ({ success: true }) });`,
  toast: `const toast = { error() {}, success() {} }; export const useToast = () => toast;`,
  activity: `export const logAuth = async () => {}; export const logOrder = async () => {}; export const logChat = async () => {};`,
  supabase: `export const supabase = { channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} }; export default supabase;`,
  realtime: `import { useEffect } from 'react'; export default function useRealtimeOrders(options) { useEffect(() => { globalThis.__historyUI.refresh = options.onBatch; }, [options.onBatch]); }`,
  network: `export default function useNetworkRecovery() {}`,
};
const plugin = {
  name: 'isolated-history-ui', enforce: 'pre',
  resolveId(source) {
    if (/(?:^|\/)lib\/database$/.test(source)) return virtual('database');
    if (/(?:^|\/)contexts\/AuthContext$/.test(source)) return virtual('auth');
    if (/(?:^|\/)useToast$/.test(source)) return virtual('toast');
    if (/(?:^|\/)activityLog$/.test(source)) return virtual('activity');
    if (/(?:^|\/)supabase$/.test(source)) return virtual('supabase');
    if (/(?:^|\/)useRealtimeOrders$/.test(source)) return virtual('realtime');
    if (/(?:^|\/)useNetworkRecovery$/.test(source)) return virtual('network');
    return null;
  },
  load(id) {
    const kind = Object.keys(mocks).find(key => id === virtual(key));
    return kind ? mocks[kind] : null;
  },
  configureServer(server) {
    server.middlewares.use('/__history_test__', async (_request, response, next) => {
      try {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/history-browser-harness.jsx"></script></body></html>';
      response.end(await server.transformIndexHtml('/__history_test__', html));
      } catch (error) { next(error); }
    });
  },
};
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const server = await createServer({
  configFile: false, root: process.cwd(), appType: 'custom', logLevel: 'error',
  cacheDir: `node_modules/.vite-history-${engine}`,
  optimizeDeps: {
    entries: ['scripts/fixtures/history-browser-harness.jsx'],
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'lucide-react', 'framer-motion'],
  },
  plugins: [plugin, react()], server: { host: '127.0.0.1', port: 0 },
});
let browser;
let checks = 0;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = engine === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chrome', headless: true });

  const setup = async ({ deniedStorage = false, viewport = { width: 1100, height: 900 }, olderAPI = false } = {}) => {
    const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block', viewport });
    // Any unexpected external network request fails closed. All fixtures are
    // local, including auth, realtime and payment-provider interactions.
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(({ deniedStorage, olderAPI }) => {
      if (olderAPI) String.prototype.replaceAll = undefined;
      if (deniedStorage) for (const name of ['getItem', 'setItem', 'removeItem']) Storage.prototype[name] = () => { throw new DOMException('Fixture denied storage', 'SecurityError'); };
      const state = {
        pending: [], calls: [], holds: {}, detailFailure: false, paymentFailure: false, large: false,
        order(id, status = 'Delivered') { return { id, tracking_number: `FIXTURE-${id}`, user_id: 'fixture-user', status, origin: 'Bohol', destination: 'Manila', created_at: new Date().toISOString(), shipping_cost: 10, amount_paid: 10, actual_weight: 1, sender_first_name: 'Fixture', receiver_first_name: 'Receiver', profiles: { name: 'Fixture' } }; },
        customer(id) { return { customer: { id, name: `CUSTOMER-${id}`, email: 'fixture@example.test', created_at: new Date().toISOString() }, orders: [], summary: { totalOrders: 0, completedOrders: 0, pendingOrders: 0, totalSpent: 0 } }; },
        trip(id) { return { trip: { id, trip_number: `TRIP-${id}`, origin: 'Bohol', destination: 'Manila', status: 'completed', capacity: 3000, price_per_kg: 70 }, orders: [], current_weight: 0, start_gate: null }; },
        async call(name, args) {
          this.calls.push({ name, args });
          let value = [];
          let key = '';
          if (name === 'getOrderStatusCounts') return {};
          if (name === 'getOrders') {
            if (!args[1] && this.paymentFailure) throw new Error('Fixture history query failed');
            if (args[1]) {
              const status = args[2]?.statusFilter?.[0] || 'All';
              key = `orders:${status}`;
              value = { data: [this.order(status, status === 'All' ? 'Delivered' : status)], count: 1 };
            } else value = this.large ? Array.from({ length: 1005 }, (_, index) => this.order(`HISTORY-${index + 1}`)) : [this.order('customer-current')];
          } else if (name === 'getCustomerById' || name === 'getTripById') {
            if (this.detailFailure) throw new Error('Fixture order query failed');
            key = `${name}:${args[0]}`;
            value = name === 'getCustomerById' ? this.customer(args[0]) : this.trip(args[0]);
          } else if (name === 'getPaymentTransactionsBatch') {
            return Object.fromEntries(args[0].map(id => [id, [{ id: `PAYMENT-${id}`, order_id: id, amount: 10, financial_amount: 10, payment_status: 'paid', payment_method: 'cash', payment_type: 'Full', payment_date: new Date().toISOString(), created_at: new Date().toISOString() }]]));
          }
          if (this.holds[key]) return new Promise((resolve, reject) => this.pending.push({ key, resolve, reject, value }));
          return value;
        },
        release(key, error = false) {
          for (const item of this.pending.filter(item => item.key === key)) error ? item.reject(new Error('Obsolete fixture failure')) : item.resolve(item.value);
          this.pending = this.pending.filter(item => item.key !== key);
        },
      };
      globalThis.__historyUI = state;
    }, { deniedStorage, olderAPI });
    const page = await context.newPage();
    const errors = [];
    const diagnostics = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    page.on('requestfailed', request => diagnostics.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
    await page.goto(`${base}/__history_test__`);
    try { await page.waitForFunction(() => globalThis.__historyUI?.ready); }
    catch (error) { await context.close(); throw new Error(`Browser harness failed to load: ${[...errors, ...diagnostics].join('; ') || error.message}`); }
    return { context, page, errors };
  };
  const mount = (page, path) => page.evaluate(path => globalThis.__historyUI.mount(path), path);
  const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const check = async (name, run, options) => {
    const fixture = await setup(options);
    try { await run(fixture.page); assert.deepEqual(fixture.errors, []); checks += 1; console.log(`PASS ${name}`); }
    finally { await fixture.context.close(); }
  };

  for (const obsoleteError of [false, true]) {
    await check(`booking filter rejects obsolete ${obsoleteError ? 'errors' : 'successes'} under StrictMode`, async page => {
      await mount(page, '/admin/orders');
      await page.getByText('FIXTURE-All', { exact: true }).waitFor();
      await page.evaluate(() => { globalThis.__historyUI.holds['orders:Pending'] = true; });
      await page.getByRole('button', { name: 'Pending', exact: true }).click();
      await page.waitForFunction(() => globalThis.__historyUI.pending.length > 0);
      await page.getByRole('button', { name: 'Completed', exact: true }).click();
      await page.getByText('FIXTURE-Delivered', { exact: true }).waitFor();
      await page.evaluate(error => globalThis.__historyUI.release('orders:Pending', error), obsoleteError);
      await flush(page);
      assert.equal(await page.getByText('FIXTURE-Delivered', { exact: true }).count(), 1);
      assert.equal(await page.getByText('FIXTURE-Pending', { exact: true }).count(), 0);
      assert.equal(await page.locator('.filter-chip.active').innerText(), 'Completed');
      assert.equal(await page.locator('.admin-error-card').count(), 0);
    });
  }
  for (const [kind, name, label] of [['customers', 'getCustomerById', 'CUSTOMER'], ['trips', 'getTripById', 'TRIP']]) {
    await check(`${kind} obsolete completion cannot clear a newer request's loading state`, async page => {
      await page.evaluate(name => { globalThis.__historyUI.holds[`${name}:A`] = true; globalThis.__historyUI.holds[`${name}:B`] = true; }, name);
      await mount(page, `/admin/${kind}/A`);
      await page.waitForFunction(() => globalThis.__historyUI.pending.length > 0);
      await page.evaluate(path => globalThis.__historyUI.navigate(path), `/admin/${kind}/B`);
      await page.waitForFunction(name => globalThis.__historyUI.pending.some(item => item.key === `${name}:B`), name);
      await page.evaluate(name => globalThis.__historyUI.release(`${name}:A`), name);
      await flush(page);
      assert.equal(await page.getByRole('status', { name: 'Loading', exact: true }).count(), 1);
      await page.evaluate(name => globalThis.__historyUI.release(`${name}:B`), name);
      await page.getByRole('heading', { name: `${label}-B`, exact: true }).waitFor();
    });
    for (const obsoleteError of [false, true]) {
      await check(`${kind} route rejects obsolete ${obsoleteError ? 'errors' : 'successes'} under StrictMode`, async page => {
        await page.evaluate(name => { globalThis.__historyUI.holds[`${name}:A`] = true; }, name);
        await mount(page, `/admin/${kind}/A`);
        await page.waitForFunction(() => globalThis.__historyUI.pending.length > 0);
        await page.evaluate(path => globalThis.__historyUI.navigate(path), `/admin/${kind}/B`);
        await page.getByRole('heading', { name: `${label}-B`, exact: true }).waitFor();
        await page.evaluate(({ name, obsoleteError }) => globalThis.__historyUI.release(`${name}:A`, obsoleteError), { name, obsoleteError });
        await flush(page);
        assert.equal(await page.getByRole('heading', { name: `${label}-B`, exact: true }).count(), 1);
        assert.equal(await page.getByRole('heading', { name: `${label}-A`, exact: true }).count(), 0);
      });
    }
    await check(`${kind} failure shows Retry and recovers to legitimate empty details`, async page => {
      await page.evaluate(() => { globalThis.__historyUI.detailFailure = true; });
      await mount(page, `/admin/${kind}/B`);
      await page.getByText('Fixture order query failed', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: `${label}-B`, exact: true }).count(), 0);
      await page.evaluate(() => { globalThis.__historyUI.detailFailure = false; });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.getByRole('heading', { name: `${label}-B`, exact: true }).waitFor();
    });
  }
  await check('obsolete response after unmount cannot affect the destination', async page => {
    await page.evaluate(() => { globalThis.__historyUI.holds['getCustomerById:A'] = true; });
    await mount(page, '/admin/customers/A');
    await page.waitForFunction(() => globalThis.__historyUI.pending.length > 0);
    await page.evaluate(() => globalThis.__historyUI.navigate('/destination'));
    await page.getByTestId('signed-in').waitFor();
    await page.evaluate(() => globalThis.__historyUI.release('getCustomerById:A'));
    await flush(page);
    assert.equal(await page.getByTestId('signed-in').count(), 1);
  });
  for (const remember of [false, true]) {
    await check(`storage-denied login renders and completes with remember=${remember}`, async page => {
      await mount(page, '/login');
      await page.locator('input[type="email"]').fill('fixture@example.test');
      await page.locator('input[type="password"]').fill('fixture-password');
      if (remember) await page.locator('input[type="checkbox"]').check();
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await page.getByTestId('signed-in').waitFor();
    }, { deniedStorage: true });
  }
  await check('storage-denied onboarding opens and dismisses without a route error', async page => {
    await mount(page, '/onboarding');
    const dialog = page.getByRole('dialog', { name: 'Welcome tour', exact: true });
    await dialog.waitFor();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }, { deniedStorage: true });
  await check('normal login preserves remembered preferences', async page => {
    await page.evaluate(() => { localStorage.setItem('remembered_email', 'remembered@example.test'); localStorage.setItem('remember_me', 'true'); });
    await mount(page, '/login');
    assert.equal(await page.locator('input[type="email"]').inputValue(), 'remembered@example.test');
    assert.equal(await page.locator('input[type="checkbox"]').isChecked(), true);
    await page.locator('input[type="password"]').fill('fixture-password');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByTestId('signed-in').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('remembered_email')), 'remembered@example.test');
  });
  await check('customer booking pager reaches records beyond 1,000', async page => {
    await page.evaluate(() => { globalThis.__historyUI.large = true; });
    await mount(page, '/customer/orders');
    await page.locator('.pagination-info').waitFor();
    assert.match(await page.locator('.pagination-info').innerText(), /1005/);
    await page.getByRole('button', { name: 'Page 101', exact: true }).click();
    await page.getByText('FIXTURE-HISTORY-1005', { exact: true }).waitFor();
  });
  await check('payment summary includes all 1,005 orders and their ledgers', async page => {
    await page.evaluate(() => { globalThis.__historyUI.large = true; });
    await mount(page, '/customer/payments');
    await page.getByText('Total Paid', { exact: true }).waitFor();
    const summary = page.locator('.grid.grid-3');
    assert.match(await summary.innerText(), /₱10,050\.00/);
    assert.match(await summary.innerText(), /1005/);
    const ids = await page.evaluate(() => globalThis.__historyUI.calls.find(call => call.name === 'getPaymentTransactionsBatch').args[0]);
    assert.equal(ids.length, 1005);
    assert.equal(ids.at(-1), 'HISTORY-1005');
  });
  await check('payment history error offers Retry without showing partial totals', async page => {
    await page.evaluate(() => { globalThis.__historyUI.paymentFailure = true; });
    await mount(page, '/customer/payments');
    await page.getByText('Fixture history query failed', { exact: true }).waitFor();
    assert.equal(await page.getByText('Total Paid', { exact: true }).count(), 0);
    await page.evaluate(() => { globalThis.__historyUI.paymentFailure = false; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('Total Paid', { exact: true }).waitFor();
  });
  for (const width of [320, 375, 390, 768]) {
    await check(`changed flows render with real styles at width ${width}`, async page => {
      await mount(page, '/login');
      await page.locator('input[type="password"]').waitFor();
      const field = await page.locator('input[type="email"]').boundingBox();
      assert.ok(field.width > 100 && field.x >= 0 && field.x + field.width <= width + 1, 'login field must fit the viewport');
      await page.locator('input[type="email"]').fill('fixture@example.test');
      await page.locator('input[type="password"]').fill('fixture-password');
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await page.getByTestId('signed-in').waitFor();
      await page.evaluate(() => { globalThis.__historyUI.large = true; });
      await mount(page, '/customer/orders');
      await page.locator('.pagination-info').waitFor();
      await page.getByRole('button', { name: 'Page 101', exact: true }).click();
      await page.getByText('FIXTURE-HISTORY-1005', { exact: true }).waitFor();
      await mount(page, '/customer/payments');
      await page.getByText('Total Paid', { exact: true }).waitFor();
      assert.match(await page.locator('.grid.grid-3').innerText(), /₱10,050\.00/);
      await mount(page, '/admin/customers/B');
      await page.getByRole('heading', { name: 'CUSTOMER-B', exact: true }).waitFor();
      await mount(page, '/admin/trips/B');
      await page.getByRole('heading', { name: 'TRIP-B', exact: true }).waitFor();
    }, { viewport: { width, height: 844 }, olderAPI: true });
  }
  console.log(`History browser reliability (${engine}): ${checks} checks passed.`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
