import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the real data functions through the real Supabase query builder.
// The transport is entirely local; no credentials or live records are used.
const bundle = await build({
  stdin: { contents: "export { getOrders, getCustomerById, getTripById, getActivityLogs, getPaymentTransactionsBatch } from './src/lib/database.js';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{
    name: 'isolated-supabase',
    setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)supabase(?:\.js)?$/ }, () => ({ path: 'supabase', namespace: 'fixture' }));
      builder.onResolve({ filter: /(?:^|\/)activityLog(?:\.js)?$/ }, () => ({ path: 'activity', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'activity'
        ? 'export const logOrder = async () => {}; export const logChat = async () => {};'
        : `export const supabase = new Proxy({}, { get(_target, key) { const client = globalThis.__historyTestClient; const value = client[key]; return typeof value === 'function' ? value.bind(client) : value; } });` }));
    },
  }],
});
const directory = await mkdtemp(join(tmpdir(), 'cargo-history-test-'));
const bundlePath = join(directory, 'functions.mjs');
let api;
try {
  await writeFile(bundlePath, bundle.outputFiles[0].text);
  api = await import(pathToFileURL(bundlePath));
} finally {
  await unlink(bundlePath);
  await rmdir(directory);
}
const dates = await import(pathToFileURL(`${process.cwd()}/src/utils/datetime.js`));
const storage = await import(pathToFileURL(`${process.cwd()}/src/utils/safeStorage.js`));

const uuid = (index, prefix = '10000000') => `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
const userId = uuid(1, '20000000');
const otherUserId = uuid(2, '20000000');
const tripId = uuid(1, '30000000');
const makeOrder = index => ({
  id: uuid(index), user_id: userId, trip_id: tripId,
  created_at: new Date(Date.UTC(2026, 8, 1, 0, Math.floor(index / 7))).toISOString(),
  status: index % 5 === 0 ? 'Cancelled' : index % 3 === 0 ? 'Delivered' : 'Pending',
  amount_paid: String(index % 17), shipping_cost: 100, discount_amount: 0,
  tracking_number: `FIXTURE-${index}`, sender_first_name: 'Juan,', sender_last_name: 'Dela Cruz',
  receiver_first_name: 'Ana', receiver_last_name: 'Receiver', actual_weight: 1,
});

// Parse only the PostgREST grammar used by these queries. Quoted values retain
// their commas/parentheses instead of becoming additional filter expressions.
const splitExpressions = value => {
  const parts = [];
  let start = 0, depth = 0, quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted && char === '\\') { index += 1; continue; }
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
    assert.ok(depth >= 0, 'unbalanced filter parentheses');
  }
  assert.equal(depth, 0, 'unbalanced filter parentheses');
  assert.equal(quoted, false, 'unbalanced filter quotes');
  parts.push(value.slice(start));
  return parts;
};
const unquote = value => value.startsWith('"') ? JSON.parse(value) : value;
const like = (actual, pattern) => {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '%') expression += '.*';
    else if (char === '_') expression += '.';
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`, 'i').test(String(actual ?? ''));
};
const matches = (row, expression) => {
  if (expression.startsWith('and(') || expression.startsWith('or(')) {
    const isAnd = expression.startsWith('and(');
    const children = splitExpressions(expression.slice(isAnd ? 4 : 3, -1));
    return isAnd ? children.every(child => matches(row, child)) : children.some(child => matches(row, child));
  }
  const parsed = expression.match(/^([a-z_]+)\.(eq|lt|gt|ilike|is|not\.is)\.(.*)$/s);
  assert.ok(parsed, `unsupported fixture expression: ${expression}`);
  const [, field, operator, raw] = parsed;
  const value = unquote(raw);
  if (operator === 'ilike') return like(row[field], value);
  if (operator === 'is') return row[field] == null;
  if (operator === 'not.is') return row[field] != null;
  if (operator === 'eq') return String(row[field]) === value;
  if (row[field] == null) return false;
  return operator === 'lt' ? row[field] < value : row[field] > value;
};

const fixture = ({ orders = [], cap = 1000, failOrderPage = 0, payments = [], refunds = [], attempts = [], failRpc = '', onOrderPage = null } = {}) => {
  const requests = [];
  let orderPages = 0;
  const fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    requests.push({ table, params: new URLSearchParams(url.search), method: options.method });
    let rows;
    if (table === 'orders') {
      orderPages += 1;
      if (orderPages === failOrderPage) return new Response(JSON.stringify({ message: 'fixture permission denied', code: '42501' }), { status: 403, headers: { 'content-type': 'application/json' } });
      if (onOrderPage) onOrderPage(orderPages, orders);
      rows = orders.slice();
    } else if (table === 'profiles') rows = [{ id: userId, role: 'customer', name: 'Fixture Customer' }];
    else if (table === 'trips') rows = [{ id: tripId, trip_number: 'FIXTURE-TRIP', status: 'scheduled' }];
    else if (table === 'company_information') rows = [{ default_capacity: 3000, default_price_per_kg: 70 }];
    else if (table === 'get_trips_load') rows = [{ trip_id: tripId, current_weight: 2005 }];
    else if (table === 'get_trip_start_date_gates') rows = [{ trip_id: tripId, gate_state: 'today' }];
    else if (table === 'activity_logs') rows = [{ id: uuid(1), action: 'Bohol, Manila', record_ref: 'R', admin_name: 'Admin', details: 'Fixture', created_at: '2026-09-01T00:00:00Z' }];
    else if (table.startsWith('get_payment_')) {
      if (table === failRpc && Number(url.searchParams.get('offset') || 0) > 0) return new Response(JSON.stringify({ message: 'fixture ledger page failed', code: '42501' }), { status: 403, headers: { 'content-type': 'application/json' } });
      const ids = JSON.parse(options.body).p_order_ids;
      rows = (table === 'get_payment_transaction_history' ? payments : table === 'get_payment_refund_history' ? refunds : attempts).filter(row => ids.includes(row.order_id));
    } else throw new Error(`unexpected fixture request ${table}`);

    for (const [field, value] of url.searchParams) {
      if (value.startsWith('eq.')) rows = rows.filter(row => String(row[field]) === value.slice(3));
      if (value.startsWith('in.')) rows = rows.filter(row => splitExpressions(value.slice(4, -1)).includes(String(row[field])));
    }
    const filter = url.searchParams.get('or');
    if (filter) rows = rows.filter(row => matches(row, `or${filter}`));
    const order = url.searchParams.get('order');
    if (order) rows.sort((left, right) => {
      for (const item of order.split(',')) {
        const [field, direction, nulls] = item.split('.');
        if (left[field] !== right[field] && (left[field] == null || right[field] == null)) {
          const nullsFirst = nulls === 'nullsfirst' || (nulls === undefined && direction === 'desc');
          return (left[field] == null ? -1 : 1) * (nullsFirst ? 1 : -1);
        }
        if (left[field] !== right[field]) return (left[field] < right[field] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      }
      return 0;
    });
    const total = rows.length;
    const offset = Number(url.searchParams.get('offset') || 0);
    rows = rows.slice(offset, offset + Math.min(Number(url.searchParams.get('limit') || cap), cap));
    const headers = new Headers(options.headers);
    const body = headers.get('accept')?.includes('vnd.pgrst.object') ? rows[0] ?? null : rows;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `${offset}-${offset + rows.length - 1}/${total}` } });
  };
  globalThis.__historyTestClient = createClient('https://fixture.invalid', 'fixture-anon-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
  return requests;
};

let checks = 0;
const check = async (name, run) => { await run(); checks += 1; console.log(`PASS ${name}`); };

await check('complete order history above 1,000 with a lower server cap, stable timestamp ties and customer scope', async () => {
  const rows = Array.from({ length: 2005 }, (_, index) => makeOrder(index + 1));
  const calls = fixture({ orders: [...rows, { ...makeOrder(9999), user_id: otherUserId }], cap: 127 });
  const actual = await api.getOrders(userId);
  assert.equal(actual.length, rows.length);
  assert.equal(new Set(actual.map(row => row.id)).size, rows.length);
  assert.ok(actual.every(row => row.user_id === userId));
  assert.ok(calls.length > 2);
  assert.ok(calls.every(call => call.params.get('user_id') === `eq.${userId}`));
});
await check('explicit admin page and explicit limit retain their return shapes', async () => {
  const rows = Array.from({ length: 80 }, (_, index) => makeOrder(index + 1));
  fixture({ orders: rows });
  const page = await api.getOrders(null, true, { page: 2, perPage: 15, statusFilter: ['Pending'] });
  assert.equal(page.data.length, 15);
  assert.equal(page.count, rows.filter(row => row.status === 'Pending').length);
  const recent = await api.getOrders(userId, false, { limit: 50 });
  assert.equal(recent.length, 50);
  assert.equal(Array.isArray(recent), true);
});
await check('comma search, multi-part names and cursor filters compose correctly', async () => {
  fixture({ orders: Array.from({ length: 1005 }, (_, index) => makeOrder(index + 1)), cap: 83 });
  assert.equal((await api.getOrders(userId, false, { search: 'Juan, Dela Cruz' })).length, 1005);
});
await check('quoted search grammar cannot become an injected filter', async () => {
  fixture({ orders: [makeOrder(1)] });
  for (const search of ['x"),status.eq.Pending,or(', '"', 'comma, value', '(test)', 'back\\slash']) {
    assert.equal((await api.getOrders(userId, false, { page: 1, perPage: 15, search })).data.length, 0);
  }
});
await check('activity log comma search uses the same quoted grammar', async () => {
  fixture();
  const result = await api.getActivityLogs({ search: 'Bohol, Manila' });
  assert.equal(result.logs.length, 1);
});
await check('newer insertion and already-read deletion do not shift later pages', async () => {
  const orders = Array.from({ length: 1005 }, (_, index) => makeOrder(index + 1));
  fixture({ orders, onOrderPage(page, current) {
    if (page === 2) {
      current.pop();
      current.push({ ...makeOrder(9999), created_at: '2026-10-01T00:00:00Z' });
    }
  } });
  const rows = await api.getOrders(userId);
  assert.equal(rows.length, 1005);
  assert.equal(new Set(rows.map(row => row.id)).size, 1005);
  assert.ok(rows.every(row => row.id !== uuid(9999)));
});
await check('customer and trip detail query failures reject instead of zero summaries', async () => {
  for (const load of [() => api.getCustomerById(userId), () => api.getTripById(tripId)]) {
    fixture({ failOrderPage: 1 });
    await assert.rejects(load, { message: 'fixture permission denied' });
    fixture({ orders: Array.from({ length: 1005 }, (_, index) => makeOrder(index + 1)), failOrderPage: 2 });
    await assert.rejects(load, { message: 'fixture permission denied' });
  }
});
await check('empty details are legitimate; large detail summaries cover every order', async () => {
  fixture();
  assert.equal((await api.getCustomerById(userId)).summary.totalOrders, 0);
  assert.equal((await api.getTripById(tripId)).orders.length, 0);
  const rows = Array.from({ length: 2005 }, (_, index) => makeOrder(index + 1));
  fixture({ orders: rows });
  const customer = await api.getCustomerById(userId);
  assert.equal(customer.summary.totalOrders, 2005);
  assert.equal(customer.summary.completedOrders, rows.filter(row => row.status === 'Delivered').length);
  assert.equal(customer.summary.totalSpent, rows.filter(row => row.status !== 'Cancelled').reduce((sum, row) => sum + Number(row.amount_paid), 0));
  const trip = await api.getTripById(tripId);
  assert.equal(trip.orders.length, 2005);
  assert.equal(trip.current_weight, 2005);
  assert.equal(trip.start_gate.gate_state, 'today');
  assert.ok(trip.orders[0].created_at <= trip.orders.at(-1).created_at);
});
await check('order history rejects errors on subsequent pages', async () => {
  fixture({ orders: Array.from({ length: 1005 }, (_, index) => makeOrder(index + 1)), failOrderPage: 2 });
  await assert.rejects(() => api.getOrders(userId), { message: 'fixture permission denied' });
});
await check('nullable legacy dates remain complete in descending and ascending histories', async () => {
  const rows = Array.from({ length: 1205 }, (_, index) => ({ ...makeOrder(index + 1), created_at: index < 605 ? null : makeOrder(index + 1).created_at }));
  fixture({ orders: rows, cap: 127 });
  const customer = await api.getCustomerById(userId);
  assert.equal(customer.orders.length, 1205);
  assert.equal(customer.summary.totalOrders, 1205);
  assert.equal(customer.orders[0].created_at, null);
  const trip = await api.getTripById(tripId);
  assert.equal(trip.orders.length, 1205);
  assert.equal(trip.orders.at(-1).created_at, null);
});
await check('payment/refund ledgers cover over 1,000 rows and over 200 order IDs', async () => {
  const ids = Array.from({ length: 205 }, (_, index) => uuid(index + 1));
  const payments = Array.from({ length: 1301 }, (_, index) => ({ id: uuid(index + 1, '40000000'), order_id: ids[0], amount: 100, payment_date: '2026-09-30T16:30:00Z', created_at: '2026-09-30T16:30:00Z' }));
  payments.push({ id: uuid(9999, '40000000'), order_id: ids.at(-1), amount: 17, created_at: '2026-09-01T00:00:00Z' });
  const refunds = Array.from({ length: 1201 }, (_, index) => ({ id: uuid(index + 1, '50000000'), order_id: ids[0], payment_transaction_id: payments[index].id, amount: 1, status: 'succeeded', created_at: '2026-10-01T00:00:00Z' }));
  const attempts = Array.from({ length: 1301 }, (_, index) => ({ id: uuid(index + 1, '60000000'), order_id: ids[0], amount: 100, status: 'failed', created_at: '2026-09-01T00:00:00Z' }));
  fixture({ payments, refunds, attempts, cap: 127 });
  const grouped = await api.getPaymentTransactionsBatch([...ids, ids[0]]);
  assert.equal(Object.keys(grouped).length, 205);
  assert.equal(grouped[ids[0]].length, 3803);
  assert.equal(grouped[ids[0]].filter(row => row.is_payment_attempt).length, 1301);
  assert.equal(grouped[ids.at(-1)].length, 1);
  assert.equal(grouped[ids[0]].reduce((sum, row) => sum + row.financial_amount, 0), 130100 - 1201);
  assert.equal(grouped[ids[0]].filter(row => !row.is_refund && !row.is_payment_attempt).reduce((sum, row) => sum + row.refunded_amount, 0), 1201);
});
await check('a later payment, refund or attempt query failure rejects the complete history', async () => {
  const rows = Array.from({ length: 305 }, (_, index) => ({ id: uuid(index + 1), order_id: userId, amount: 10, created_at: '2026-09-01T00:00:00Z' }));
  for (const failRpc of ['get_payment_transaction_history', 'get_payment_refund_history', 'get_payment_attempt_history']) {
    fixture({ payments: rows, refunds: rows, attempts: rows, cap: 127, failRpc });
    await assert.rejects(() => api.getPaymentTransactionsBatch([userId]), { message: 'fixture ledger page failed' });
  }
});
await check('financial month keys and displayed dates are Manila-based', async () => {
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Manila', 'Pacific/Kiritimati']) {
    process.env.TZ = zone;
    assert.equal(dates.phMonthKey('2026-09-30T16:30:00Z'), '2026-10');
    assert.equal(dates.phMonthKey('2026-09-30T15:59:59Z'), '2026-09');
    assert.equal(dates.phMonthKey('2026-12-31T16:00:00Z'), '2027-01');
    assert.equal(dates.phMonthKey(new Date('2026-09-30T16:30:00Z')), '2026-10');
    assert.equal(dates.phMonthKey('2026-10-01T00:30'), '2026-10');
    assert.match(dates.formatPhDate('2026-09-30T16:30:00Z'), /Oct 1, 2026/);
  }
  assert.equal(dates.phMonthKey('invalid'), '');
  assert.equal(dates.phMonthKey(new Date('invalid')), '');
  assert.equal(dates.phMonthKey(null), '');
});
await check('preference storage works normally and safely handles denial/full storage/getter denial', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    const values = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
    storage.setLocalStorageItem('remember_me', 'true');
    assert.equal(storage.getLocalStorageItem('remember_me'), 'true');
    storage.removeLocalStorageItem('remember_me');
    assert.equal(storage.getLocalStorageItem('remember_me'), null);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
    assert.equal(storage.getLocalStorageItem('remember_me'), null);
    assert.doesNotThrow(() => storage.setLocalStorageItem('remember_me', 'true'));
    assert.doesNotThrow(() => storage.removeLocalStorageItem('remember_me'));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
console.log(`History reliability: ${checks} checks passed.`);
