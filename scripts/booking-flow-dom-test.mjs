import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Run the real booking component, address pickers, drafts, and keyboard hook.
// Stub only the authenticated session and remote database: this test never
// creates a customer or booking in production.
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'https://example.test/customer/book', pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'SVGElement', 'Node', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.matchMedia = (query) => ({ matches: query.includes('pointer: coarse'), addEventListener() {}, removeEventListener() {} });
// Exercise the real selector precedence. Before the fix, the global keyboard
// rule won and replaced booking's stable padding as soon as the keyboard opened.
const viewportCss = await readFile('src/styles/viewport-hardening.css', 'utf8');
const globalRule = viewportCss.match(/body\.keyboard-open \.customer-main:not\(:has\(\.support-chat-page\)\)\s*\{[^}]+\}/)?.[0];
const bookingRule = viewportCss.match(/body \.customer-layout-v2 \.customer-main:has\(\.booking-page\)\s*\{[^}]+\}/)?.[0];
assert.ok(globalRule && bookingRule, 'both keyboard padding rules exist');
const selectorProbe = new JSDOM(`<style>${globalRule.replace(/padding-bottom:[^;]+;/, 'padding-bottom:24px;')}
  ${bookingRule.replace(/padding-bottom:[^;]+;/, 'padding-bottom:180px;')}</style>
  <body class="keyboard-open"><div class="customer-layout-v2"><main class="customer-main"><div class="booking-page"></div></main></div></body>`);
assert.equal(selectorProbe.window.getComputedStyle(selectorProbe.window.document.querySelector('main')).paddingBottom,
  '180px', 'booking bottom space must win over the global keyboard rule');
selectorProbe.window.close();
const visualViewport = new dom.window.EventTarget();
Object.assign(visualViewport, { height: 800, offsetTop: 0 });
Object.defineProperty(dom.window, 'visualViewport', { value: visualViewport });
Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 800 });
const pageScrolls = [];
dom.window.scrollTo = (...args) => pageScrolls.push(['to', ...args]);
dom.window.scrollBy = (...args) => pageScrolls.push(['by', ...args]);
dom.window.HTMLElement.prototype.scrollIntoView = () => pageScrolls.push(['into']);

const fixture = {
  user: { id: 'integration-test-account' },
  profile: {
    name: 'Alex Cruz', phone: '09123456789', facebook_name: 'Alex Cruz',
    address_province: 'Bohol', address_city: 'Balilihan', address_barangay: 'Cantomimbo',
    address_street: 'Purok 4', address_lot_block: 'Lot 12', address_landmark: 'Near School',
  },
  orders: [], errors: [],
};
globalThis.__bookingFlowFixture = fixture;

const mocks = new Map([
  ['AuthContext', "export const useAuth = () => ({user: globalThis.__bookingFlowFixture.user, userProfile: globalThis.__bookingFlowFixture.profile});"],
  ['database', `export const getTrips = async () => [];
    export const getSettings = async () => ({price_per_kilo: 70});
    export const getRecentContacts = async () => ({senders: [], receivers: []});
    export const createOrder = async (payload) => {
      globalThis.__bookingFlowFixture.orders.push(payload);
      return {...payload, id: 'test-order', tracking_number: 'TEST-123'};
    };`],
  ['useToast', 'export const useToast = () => ({error: message => globalThis.__bookingFlowFixture.errors.push(message)});'],
  ['activityLog', 'export const logOrder = async () => {};'],
]);
const mockImports = {
  name: 'booking-remote-boundaries',
  setup(esbuild) {
    esbuild.onResolve({ filter: /(?:AuthContext|lib\/database|hooks\/useToast|lib\/activityLog)$/ }, ({ path }) => {
      const name = [...mocks.keys()].find((key) => path.endsWith(key));
      return name ? { path: name, namespace: 'booking-mock' } : undefined;
    });
    esbuild.onLoad({ filter: /.*/, namespace: 'booking-mock' }, ({ path }) => ({ contents: mocks.get(path), loader: 'js' }));
  },
};

const outputDirectory = resolve('node_modules/.cache/booking-flow-dom-test');
await mkdir(outputDirectory, { recursive: true });
const outputFile = resolve(outputDirectory, 'component.mjs');
try {
  await build({
    entryPoints: ['src/pages/customer/BookShipmentPage.jsx'], outfile: outputFile,
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    loader: { '.js': 'jsx', '.jsx': 'jsx' }, jsx: 'automatic',
    plugins: [mockImports], logLevel: 'silent',
  });
  const [{ default: BookShipmentPage }, { default: useKeyboardInset, scrollFocusedFieldIntoView }, React, ReactDOM, Router] = await Promise.all([
    import(pathToFileURL(outputFile).href),
    import('../src/hooks/useKeyboardInset.js'),
    import('react'), import('react-dom/client'), import('react-router-dom'),
  ]);
  const { act, createElement } = React;
  const KeyboardListener = () => {
    useKeyboardInset((inset) => { if (inset > 0) requestAnimationFrame(scrollFocusedFieldIntoView); });
    return null;
  };
  const router = Router.createMemoryRouter([{
    path: '/customer/book',
    element: createElement(React.Fragment, null, createElement(KeyboardListener), createElement(BookShipmentPage)),
  }], { initialEntries: ['/customer/book'] });
  const root = ReactDOM.createRoot(document.getElementById('app'));
  const flush = async () => {
    await act(async () => { await new Promise((r) => setTimeout(r, 35)); });
  };
  const click = async (element) => {
    assert.ok(element, 'booking control exists');
    await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await flush();
  };
  const button = (name) => [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === name);
  const change = async (id, value) => {
    const el = document.getElementById(id);
    assert.ok(el, `${id} exists`);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const choose = async (id, optionName) => {
    await click(document.getElementById(id));
    assert.equal(document.getElementById(id).getAttribute('aria-expanded'), 'true', `${id} opened`);
    const option = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.trim() === optionName);
    await click(option);
  };
  const step = (n) => assert.match(document.querySelector('.booking-current-step').textContent, new RegExp(`Step ${n} of 5`));

  await act(async () => root.render(createElement(Router.RouterProvider, { router })));
  await flush();
  step(1);
  await click(button('Bohol → Manila'));
  await click(button('Continue'));
  step(2);
  assert.equal(document.querySelector('.step-progress [aria-current="step"]').textContent, '2');
  await click(button('Continue'));
  step(2);
  assert.equal(document.getElementById('sender-first_name').getAttribute('aria-invalid'), 'true',
    'incomplete sender details must not advance the wizard');
  await click(document.getElementById('useRegSender'));
  assert.equal(document.getElementById('sender-first_name').value, 'Alex');
  assert.equal(document.getElementById('sender-first_name').getAttribute('aria-invalid'), null,
    'autofilling must clear stale validation state');

  document.getElementById('sender-lot-block').focus();
  // Simulate the focused field being 150px below the visible viewport bottom,
  // which reproduced the second programmatic scroll in the previous build.
  document.getElementById('sender-lot-block').getBoundingClientRect = () => ({ top: 600, bottom: 650 });
  pageScrolls.length = 0;
  visualViewport.height = 500;
  visualViewport.dispatchEvent(new dom.window.Event('resize'));
  await flush();
  assert.equal(document.documentElement.style.getPropertyValue('--booking-keyboard-height'), '300px');
  await change('sender-lot-block', 'Lot 13');
  visualViewport.offsetTop = 120;
  visualViewport.dispatchEvent(new dom.window.Event('scroll'));
  await flush();
  assert.deepEqual(pageScrolls, [], 'typing and panning with the keyboard open must not scroll the booking page');
  assert.equal(document.documentElement.style.getPropertyValue('--booking-keyboard-height'), '300px',
    'booking bottom space must remain stable when the visual viewport pans');

  await click(button('Continue'));
  step(3);
  await change('receiver-first_name', 'Jamie');
  await change('receiver-last_name', 'Reyes');
  await change('receiver-phone', '09987654321');
  await change('receiver-facebook', 'Jamie Reyes');
  await choose('receiver-province', 'Metro Manila');
  const city = document.getElementById('receiver-city');
  city.parentElement.getBoundingClientRect = () => ({ top: 300, bottom: 350 });
  await click(city);
  visualViewport.dispatchEvent(new dom.window.Event('scroll'));
  await flush();
  assert.equal(city.getAttribute('aria-expanded'), 'true', 'an open city menu stays open during viewport movement');
  await click([...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.trim() === 'Manila'));
  await choose('receiver-barangay', 'Barangay 1');
  await click(button('Continue'));
  step(3);
  assert.equal(document.getElementById('receiver-street').getAttribute('aria-invalid'), 'true',
    'incomplete receiver details must not advance the wizard');
  await change('receiver-street', 'Mabini Street');
  await change('receiver-lot-block', 'Block 1');
  await change('receiver-landmark', 'Near Plaza');
  await click(button('Continue'));
  step(4);
  await click(button('Review Booking'));
  step(4);
  assert.equal(document.getElementById('package-description').getAttribute('aria-invalid'), 'true',
    'a missing package description must not reach review');
  await change('package-description', 'Documents');
  await click(button('Review Booking'));
  step(5);
  assert.match(document.querySelector('.booking-summary-card').textContent, /Bohol → Manila/);
  const confirm = button('Confirm Booking');
  await act(async () => {
    confirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    confirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
  assert.equal(fixture.orders.length, 1, 'one confirmation creates exactly one booking');
  assert.equal(fixture.orders[0].receiver_city, 'Manila');
  assert.equal(fixture.orders[0].sender_lot_block, 'Lot 13');
  assert.equal(fixture.errors.length, 3, 'only the three deliberately invalid steps should report errors');
  await act(async () => root.unmount());
  console.log('Booking DOM integration passed: five steps, validation, autofill, keyboard pan, dropdowns, review, and duplicate-submit guard.');
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
  dom.window.close();
  delete globalThis.__bookingFlowFixture;
}
