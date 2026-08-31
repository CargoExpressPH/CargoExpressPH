import { test, expect } from '@playwright/test';
import { CUSTOMER } from './helpers/config.js';
import { login, suppressOnboarding, dismissOverlays } from './helpers/actions.js';
import { adminClient, findLatestE2ECustomer, findProfileByEmail } from './helpers/db.js';

const VIEWPORTS = [
  { name: 'Small 320', width: 320, height: 568 },
  { name: 'iPhone 375', width: 375, height: 667 },
  { name: 'Phone 390', width: 390, height: 844 },
  { name: 'Tablet 768', width: 768, height: 1024 },
  { name: 'Desktop 1280', width: 1280, height: 800 },
  { name: 'Desktop 1440', width: 1440, height: 900 },
];

const STATIC_ROUTES = [
  '/customer',
  '/customer/orders',
  '/customer/book',
  '/customer/track',
  '/customer/trips',
  '/customer/notifications',
  '/customer/profile',
  '/customer/personal-info',
  '/customer/change-password',
  '/customer/change-email',
  '/customer/support',
  '/customer/payments',
  '/customer/help-guidelines',
  '/customer/about-version',
  '/customer/payment-methods',
];

const fixture = { email: null, orderId: null };

test.describe('authenticated customer responsive — every screen', () => {
  test.beforeAll(async () => {
    const profile = process.env.E2E_CUSTOMER_EMAIL
      ? await findProfileByEmail(process.env.E2E_CUSTOMER_EMAIL)
      : await findLatestE2ECustomer();
    if (!profile) throw new Error('Authenticated customer fixture is missing');
    fixture.email = profile.email;

    const db = await adminClient();
    const { data, error } = await db
      .from('orders')
      .select('id')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`Customer order fixture lookup failed: ${error.message}`);
    fixture.orderId = data?.[0]?.id || null;
  });

  for (const viewport of VIEWPORTS) {
    test(viewport.name + ' — all customer routes fit and remain reachable', async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await suppressOnboarding(page);
      await login(
        page,
        fixture.email,
        process.env.E2E_CUSTOMER_PASSWORD || CUSTOMER.password,
        { expectPath: '/customer' },
      );
      await dismissOverlays(page);

      const routes = fixture.orderId
        ? [...STATIC_ROUTES, '/customer/orders/' + fixture.orderId]
        : STATIC_ROUTES;

      for (const route of routes) {
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/customer/);
        await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
        await page.locator('.page-loader').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(250);

        const layout = await page.evaluate(() => {
          const root = document.documentElement;
          const body = document.body;
          const width = Math.max(root.scrollWidth, body.scrollWidth);
          const viewportWidth = window.innerWidth;
          const clipped = [];
          const wide = [];
          const isScrollable = (el) => {
            let parent = el.parentElement;
            while (parent && parent !== document.body) {
              const style = getComputedStyle(parent);
              if (/auto|scroll/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 2) return true;
              parent = parent.parentElement;
            }
            return false;
          };
          for (const el of document.querySelectorAll('button, a, input, textarea, [role=button]')) {
            if (!(el instanceof HTMLElement)) continue;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight || isScrollable(el)) continue;
            if (rect.left < -5 || rect.right > viewportWidth + 5) {
              clipped.push({
                text: (el.getAttribute('aria-label') || el.textContent || el.id).trim().slice(0, 50),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
              });
            }
            if (clipped.length === 3) break;
          }
          for (const el of document.querySelectorAll('body *')) {
            if (!(el instanceof HTMLElement)) continue;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
            if (rect.left < -2 || rect.right > viewportWidth + 2 || el.scrollWidth > viewportWidth + 2) {
              wide.push({
                tag: el.tagName.toLowerCase(),
                cls: String(el.className || '').slice(0, 80),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                width: Math.round(rect.width),
                scrollWidth: el.scrollWidth,
              });
            }
            if (wide.length === 5) break;
          }
          return { overflow: width - viewportWidth, clipped, wide };
        });

        expect.soft(
          layout.overflow,
          route + ' overflows at ' + viewport.width + 'px: ' + JSON.stringify(layout.wide),
        ).toBeLessThanOrEqual(2);
        expect.soft(layout.clipped, route + ' has clipped controls at ' + viewport.width + 'px').toEqual([]);
      }
    });
  }

  test('customer navigation, search, validation, and legacy redirect controls work', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await suppressOnboarding(page);
    await login(
      page,
      fixture.email,
      process.env.E2E_CUSTOMER_PASSWORD || CUSTOMER.password,
      { expectPath: '/customer' },
    );
    await dismissOverlays(page);

    const destinations = [
      ['Home', '/customer'],
      ['Bookings', '/customer/orders'],
      ['Place order / Book shipment', '/customer/book'],
      ['Trips', '/customer/trips'],
      ['Profile', '/customer/profile'],
    ];
    for (const [name, path] of destinations) {
      await page.getByRole('link', { name: new RegExp('^' + name + '$', 'i') }).last().click();
      await expect(page).toHaveURL(new RegExp(path.replaceAll('/', '\\/') + '$'));
    }

    await page.goto('/customer/orders');
    const search = page.locator('input[type=search], input[placeholder*=search i]').first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill('definitely-no-such-tracking-number');
      await expect(search).toHaveValue('definitely-no-such-tracking-number');
      await search.clear();
    }

    await page.goto('/customer/book');
    const continueButton = page.getByRole('button', { name: /^continue$/i }).first();
    if (await continueButton.isVisible().catch(() => false)) {
      await continueButton.click();
      await expect(page.locator('[aria-invalid=true], .field-invalid, .form-error').first()).toBeVisible();
    }

    await page.goto('/customer/payment-methods');
    await expect(page).toHaveURL(/\/customer\/payments$/);
  });
});
