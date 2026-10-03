import assert from 'node:assert/strict';
import { chromium, webkit } from '@playwright/test';
import { preview } from 'vite';

// Smoke-test the actual production build and actual worker with fixture-only
// external responses. No login, money, notification or business writes occur.
// Same-origin production assets do not need the preview server's CORS layer.
// Its Vary: Origin header makes script requests miss worker precache entries
// created without an Origin header, unlike the deployed static host.
let networkUnavailable = false;
const server = await preview({
  configFile: false,
  plugins: [{
    name: 'history-pwa-network-control',
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (networkUnavailable) request.socket.destroy();
        else next();
      });
    },
  }],
  preview: { host: '127.0.0.1', port: 0, open: false, cors: false },
});
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
let browser;
try {
  browser = engine === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chrome', headless: true });
  for (const standalone of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 375, height: 667 }, reducedMotion: 'reduce' });
    try {
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base) return route.continue();
        if (!/\/rest\/v1\/|\/auth\/v1\/|\/functions\/v1\//.test(url.pathname)) return route.abort();
        const company = { id: 1, company_name: 'CargoExpress PH', default_price_per_kg: 70, default_capacity: 3000, features: [], coverage_regions: [] };
        const body = /company_information|get_public_business_profile/.test(url.pathname) ? company : [];
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await context.addInitScript(standalone => {
        if (standalone) {
          Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
          const original = window.matchMedia.bind(window);
          window.matchMedia = query => {
            const result = original(query);
            if (query.includes('display-mode: standalone')) Object.defineProperty(result, 'matches', { value: true });
            return result;
          };
        }
        for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = () => { throw new DOMException('Fixture denied storage', 'SecurityError'); };
      }, standalone);
      const page = await context.newPage();
      const errors = [];
      const diagnostics = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
      const waitForLogin = async () => {
        try { await page.locator('input[type="password"]').waitFor(); }
        catch (error) { throw new Error(`Production login did not render: ${JSON.stringify({ errors, diagnostics, body: await page.locator('body').innerText() })}`, { cause: error }); }
      };
      await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
      await waitForLogin();
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30000 });
      const cacheState = await page.evaluate(async () => {
        const names = await caches.keys();
        const name = names.find(name => name.startsWith('cargoexpress-static-'));
        const cache = await caches.open(name);
        const requests = await cache.keys();
        const manifest = await (await cache.match('/manifest.json')).json();
        return { assets: requests.filter(request => /\/assets\/.*\.(js|css|woff2?)$/.test(new URL(request.url).pathname)).length, display: manifest.display };
      });
      assert.ok(cacheState.assets > 100, 'production worker must cache complete application assets');
      assert.equal(cacheState.display, 'standalone');
      // Windows WebKit's driver errors internally on offline navigation. A
      // refused server connection exercises the worker's real fetch failure
      // path while retaining navigation support in that test environment.
      if (engine === 'webkit') networkUnavailable = true;
      else await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForLogin();
      assert.equal(await page.locator('input[type="email"]').count(), 1);
      assert.deepEqual(errors, []);
      if (engine === 'webkit') networkUnavailable = false;
      else await context.setOffline(false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForLogin();
      assert.deepEqual(errors, []);
      console.log(`PASS production ${engine} ${standalone ? 'standalone-emulated' : 'browser'}: denied-storage login, active worker, ${cacheState.assets} cached assets, offline reload and recovery`);
    } finally { networkUnavailable = false; await context.close(); }
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
