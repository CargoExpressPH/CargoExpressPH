import { test, expect } from '@playwright/test';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const adminId = '00000000-0000-4000-8000-000000000001';
const futureExpiry = Math.floor(Date.now() / 1000) + 60 * 60;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
  sub: adminId,
  email: 'admin@example.test',
  role: 'authenticated',
  aud: 'authenticated',
  exp: futureExpiry,
})}.test-signature`;

const user = {
  id: adminId,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'admin@example.test',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  created_at: '2026-01-01T00:00:00.000Z',
};

const session = {
  access_token: accessToken,
  refresh_token: 'mock-refresh-token',
  expires_at: futureExpiry,
  expires_in: 3600,
  token_type: 'bearer',
  user,
};

const directoryRows = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Ana Customer',
    email: 'ana@example.test',
    phone: '0917 000 0001',
    address_city: 'Cebu City',
    address_province: 'Cebu',
    created_at: '2026-08-01T00:00:00.000Z',
    total_bookings: 7,
    outstanding_balance: 1250.5,
    last_booking_at: '2026-09-10T00:00:00.000Z',
    pending_bookings: 1,
    active_bookings: 0,
    directory_status: 'with_balance',
  },
  {
    id: '00000000-0000-4000-8000-000000000012',
    name: 'A Customer With An Intentionally Very Long Name That Must Truncate Safely At Every Width',
    email: 'long.customer@example.test',
    phone: null,
    address_city: null,
    address_province: null,
    created_at: '2026-07-01T00:00:00.000Z',
    total_bookings: 0,
    outstanding_balance: 0,
    last_booking_at: null,
    pending_bookings: 0,
    active_bookings: 0,
    directory_status: 'inactive',
  },
  {
    id: '00000000-0000-4000-8000-000000000013',
    name: 'Carlo Active',
    email: 'carlo@example.test',
    phone: '0917 000 0003',
    address_city: 'Panglao',
    address_province: 'Bohol',
    created_at: '2026-06-01T00:00:00.000Z',
    total_bookings: 3,
    outstanding_balance: 0,
    last_booking_at: '2026-09-11T00:00:00.000Z',
    pending_bookings: 0,
    active_bookings: 1,
    directory_status: 'active',
  },
];

const installMocks = async (
  page,
  rows = directoryRows,
  { delayMs = 0, failDirectoryOnce = false } = {},
) => {
  test.skip(!supabaseUrl, 'VITE_SUPABASE_URL is required to derive the mocked session storage key');
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  await page.addInitScript(({ storageKey, storedSession }) => {
    window.localStorage.setItem(storageKey, JSON.stringify(storedSession));
  }, { storageKey: `sb-${projectRef}-auth-token`, storedSession: session });

  const requests = [];
  let remainingDirectoryFailures = failDirectoryOnce ? 1 : 0;

  await page.route('**/auth/v1/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/user')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
  });

  await page.route('**/rest/v1/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname.endsWith('/profiles')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-range': '0-0/1' },
        body: JSON.stringify({ id: adminId, name: 'Admin', email: 'admin@example.test', role: 'admin' }),
      });
      return;
    }

    if (pathname.endsWith('/rpc/get_admin_customer_provinces')) {
      const values = [...new Set(rows.map(row => row.address_province).filter(Boolean))].sort();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(values.map(province => ({ province }))) });
      return;
    }

    if (pathname.endsWith('/rpc/get_admin_customers')) {
      if (remainingDirectoryFailures > 0) {
        remainingDirectoryFailures -= 1;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Mock directory failure' }),
        });
        return;
      }

      const body = request.postDataJSON();
      requests.push(body);
      let result = [...rows];
      const search = String(body.p_search || '').toLowerCase();
      if (search) {
        result = result.filter(row => [row.name, row.email, row.phone, row.address_city, row.address_province]
          .some(value => String(value || '').toLowerCase().includes(search)));
      }
      if (body.p_province) result = result.filter(row => row.address_province === body.p_province);
      if (body.p_status_filter === 'with_balance') result = result.filter(row => Number(row.outstanding_balance) > 0);
      if (body.p_status_filter === 'pending') result = result.filter(row => Number(row.pending_bookings) > 0);
      if (body.p_status_filter === 'active') result = result.filter(row => Number(row.active_bookings) > 0);
      if (body.p_status_filter === 'no_bookings') result = result.filter(row => Number(row.total_bookings) === 0);

      const comparators = {
        name_asc: (a, b) => a.name.localeCompare(b.name),
        newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
        oldest: (a, b) => new Date(a.created_at) - new Date(b.created_at),
        most_bookings: (a, b) => Number(b.total_bookings) - Number(a.total_bookings),
        highest_balance: (a, b) => Number(b.outstanding_balance) - Number(a.outstanding_balance),
        recent_booking: (a, b) => new Date(b.last_booking_at || 0) - new Date(a.last_booking_at || 0),
      };
      result.sort(comparators[body.p_sort] || comparators.newest);
      const count = result.length;
      const start = (Number(body.p_page) - 1) * Number(body.p_per_page);
      result = result.slice(start, start + Number(body.p_per_page)).map(row => ({ ...row, total_count: count }));
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
      return;
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  return requests;
};

test.describe('Admin Customers responsive directory', () => {
  test('renders loading, desktop table data, fallbacks, and authoritative balances', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installMocks(page, directoryRows, { delayMs: 250 });
    await page.goto('/admin/customers');

    await expect(page.getByLabel('Loading customers')).toBeVisible();
    const table = page.getByRole('table', { name: 'Registered customer accounts' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveCount(8);
    await expect(table.getByText('Ana Customer')).toBeVisible();
    await expect(table.getByText('₱1,250.50')).toBeVisible();
    await expect(table.getByText('Fully paid').first()).toBeVisible();
    await expect(table.getByText('Not provided').first()).toBeVisible();
    await expect(table.getByText('No bookings yet')).toBeVisible();
    await expect(page.locator('.customer-directory-mobile')).toBeHidden();
  });

  test('switches to compact mobile cards without email or horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await installMocks(page);
    await page.goto('/admin/customers');

    const list = page.getByRole('list', { name: 'Registered customer accounts' });
    await expect(list).toBeVisible();
    await expect(page.getByRole('table', { name: 'Registered customer accounts' })).toBeHidden();
    await expect(list.getByText('Ana Customer')).toBeVisible();
    await expect(list.getByText('Phone not provided')).toBeVisible();
    await expect(list.getByText('Due ₱1,250.50')).toBeVisible();
    await expect(list.getByText('ana@example.test')).toHaveCount(0);
    await expect(list.getByText('long.customer@example.test')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('.customer-directory-pagination .pagination-per-page')).toBeHidden();

    await page.setViewportSize({ width: 768, height: 900 });
    await expect(list).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await list.getByRole('listitem').first().click();
    await expect(page).toHaveURL(/\/admin\/customers\/00000000-0000-4000-8000-000000000011$/);
  });

  test('combines search, status, province, sorting, and pagination server-side', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const manyRows = Array.from({ length: 16 }, (_, index) => ({
      ...directoryRows[index % directoryRows.length],
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: index === 15 ? 'Zed Final Customer' : `${directoryRows[index % directoryRows.length].name} ${index + 1}`,
    }));
    const requests = await installMocks(page, manyRows);
    await page.goto('/admin/customers');

    await expect(page.getByText('16 total')).toBeVisible();
    await page.getByLabel('Search customers by name, email, phone, city, or province').fill('Ana');
    await expect.poll(() => requests.at(-1)?.p_search).toBe('Ana');

    await page.getByLabel('Filter customers by booking state').click();
    await page.getByRole('option', { name: 'With unpaid balance' }).click();
    await expect.poll(() => requests.at(-1)?.p_status_filter).toBe('with_balance');

    await page.getByLabel('Filter customers by province').click();
    await page.getByRole('option', { name: 'Cebu' }).click();
    await expect.poll(() => requests.at(-1)?.p_province).toBe('Cebu');

    await page.getByLabel('Sort customers').click();
    await page.getByRole('option', { name: 'Highest outstanding balance' }).click();
    await expect.poll(() => requests.at(-1)?.p_sort).toBe('highest_balance');

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect.poll(() => requests.at(-1)?.p_search).toBe('');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect.poll(() => requests.at(-1)?.p_page).toBe(2);
    await expect(page.locator('.customer-directory-table tbody tr')).toHaveCount(1);
    await expect(
      page.locator('.customer-directory-pagination .pagination-info'),
    ).toContainText('Showing 16–16 of 16');
  });

  test('shows distinct empty states for no accounts and no matching results', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await installMocks(page, []);
    await page.goto('/admin/customers');
    await expect(page.getByRole('heading', { name: 'No customers registered' })).toBeVisible();

    await page.getByLabel('Search customers by name, email, phone, city, or province').fill('Nobody');
    await expect(page.getByRole('heading', { name: 'No matching customers' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('shows a network failure and recovers through Retry', async ({ page }) => {
    await installMocks(page, directoryRows.slice(0, 1), { failDirectoryOnce: true });
    await page.goto('/admin/customers');

    await expect(page.getByText('Unable to load customers')).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(
      page.getByRole('table', { name: 'Registered customer accounts' }).getByText('Ana Customer'),
    ).toBeVisible();
    await expect(page.getByText('Unable to load customers')).toHaveCount(0);
  });
});
