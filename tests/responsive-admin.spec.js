import { test, expect, devices } from '@playwright/test';
import { login } from './helpers/actions';
import { ADMIN } from './helpers/config';

/**
 * Responsive admin E2E — every admin screen at every major device size.
 *
 * Covers: Android (360, 412), iOS (375, 390, 414), Tablet (768, 820), Desktop (1024, 1280, 1440)
 * Checks: no horizontal overflow, no clipped buttons, table→card, modals fit, sidebar drawer, topbar, grids.
 *
 * Uses real admin session (same as journey) — no mocks, so it catches real CSS+JS interaction.
 */

const VIEWPORTS = [
  { name: 'iPhone SE 375', width: 375, height: 667, isMobile: true },
  { name: 'Pixel 7 412', width: 412, height: 915, isMobile: true },
  { name: 'iPhone 14 Pro 393', width: 393, height: 852, isMobile: true },
  { name: 'iPhone 14 Pro Max 430', width: 430, height: 932, isMobile: true },
  { name: 'iPad Mini 768', width: 768, height: 1024, isMobile: false },
  { name: 'iPad Air 820', width: 820, height: 1180, isMobile: false },
  { name: 'Desktop 1024', width: 1024, height: 768, isMobile: false },
  { name: 'Desktop 1280', width: 1280, height: 800, isMobile: false },
  { name: 'Desktop 1440', width: 1440, height: 900, isMobile: false },
  // ultra-small edge
  { name: 'Small 320', width: 320, height: 568, isMobile: true },
  { name: 'Small 360', width: 360, height: 640, isMobile: true },
];

const ADMIN_ROUTES = [
  { path: '/admin', label: 'Dashboard', hasTable: true },
  { path: '/admin/orders', label: 'Bookings', hasTable: true, hasSearch: true },
  { path: '/admin/trips', label: 'Trips', hasTable: false },
  { path: '/admin/customers', label: 'Customers', hasTable: true, hasSearch: true },
  { path: '/admin/inbox', label: 'Inbox', hasTable: false },
  { path: '/admin/contact-inquiries', label: 'Inquiries', hasTable: true },
  { path: '/admin/announcements', label: 'Announcements', hasTable: false },
  { path: '/admin/activity-logs', label: 'Activity Logs', hasTable: true },
  { path: '/admin/company-info', label: 'Company Information', hasTable: false },
  { path: '/admin/feedback', label: 'Feedback', hasTable: false },
  { path: '/admin/sales', label: 'Sales', hasTable: false, hasChart: true },
  { path: '/admin/reports', label: 'Reports', hasTable: false },
  { path: '/admin/sales?tab=unsettled', label: 'Unsettled', hasTable: true },
  { path: '/admin/sales?tab=reports', label: 'Reports tab', hasTable: false },
];

const checkNoHorizontalOverflow = async (page, viewport) => {
  const overflow = await page.evaluate(() => {
    const docEl = document.documentElement;
    const body = document.body;
    const scrollW = Math.max(docEl.scrollWidth, body.scrollWidth);
    const clientW = window.innerWidth;
    const diff = scrollW - clientW;
    // allow 1px rounding
    return { scrollW, clientW, diff, hasOverflow: diff > 2 };
  });
  expect(overflow.hasOverflow, `Horizontal overflow ${overflow.diff}px at ${viewport.name} (${viewport.width}px): scrollW ${overflow.scrollW} > clientW ${overflow.clientW}`).toBe(false);
};

const checkNoClippedButtons = async (page, viewport) => {
  // Every visible button/link should be within viewport horizontally
  const clipped = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, a.btn, .btn'));
    const vw = window.innerWidth;
    const bad = [];
    for (const el of els) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const rect = el.getBoundingClientRect();
      // ignore off-screen drawer etc (left < -10)
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.left < -5 || rect.right > vw + 5) {
        bad.push({ text: (el.textContent || el.getAttribute('aria-label') || el.className).slice(0, 60), left: Math.round(rect.left), right: Math.round(rect.right), vw });
        if (bad.length >= 3) break;
      }
    }
    return bad;
  });
  expect(clipped, `Clipped buttons at ${viewport.name}: ${JSON.stringify(clipped)}`).toEqual([]);
};

const checkTapTargets = async (page, viewport) => {
  if (!viewport.isMobile) return;
  const smallTargets = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, a, [role="button"], .btn-icon'));
    const bad = [];
    for (const el of els) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // only check visible in viewport
      if (rect.top < 0 || rect.top > window.innerHeight) continue;
      if (rect.width < 24 || rect.height < 24) {
        bad.push({ cls: el.className.slice(0, 40), w: Math.round(rect.width), h: Math.round(rect.height) });
        if (bad.length >= 3) break;
      }
    }
    return bad;
  });
  // WCAG 2.2 24px minimum — we allow 24, not 44, for icon buttons with padding
  expect(smallTargets.length, `Too small tap targets at ${viewport.name}: ${JSON.stringify(smallTargets)}`).toBeLessThan(3);
};

test.describe('admin responsive — every screen at every device size', () => {
  test.skip(!process.env.E2E_ADMIN_EMAIL || !process.env.E2E_ADMIN_PASSWORD, 'E2E_ADMIN_EMAIL not set — skipping admin responsive');

  // Login once per viewport to avoid recreating context per route
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.name} (${viewport.width}x${viewport.height})`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
        // wait for layout to settle
        await page.waitForSelector('.app-layout', { timeout: 15000 });
        await page.waitForSelector('.sidebar', { timeout: 10000 });
      });

      for (const route of ADMIN_ROUTES) {
        test(`${route.label} ${route.path} — no overflow, buttons visible, content fits`, async ({ page }) => {
          await page.goto(route.path, { waitUntil: 'domcontentloaded' });
          // wait for either table, card, or page header
          await page.waitForSelector('.admin-page-header, .card, .page-transition', { timeout: 15000 });
          await page.waitForTimeout(800); // let stagger animations settle

          // 1. No horizontal overflow
          await checkNoHorizontalOverflow(page, viewport);

          // 2. No clipped buttons
          await checkNoClippedButtons(page, viewport);

          // 3. Tap targets on mobile
          await checkTapTargets(page, viewport);

          // 4. Topbar not overflowing
          const topbarOverflow = await page.evaluate(() => {
            const tb = document.querySelector('.topbar');
            if (!tb) return { has: false };
            const rect = tb.getBoundingClientRect();
            return { has: rect.width > window.innerWidth + 2, w: rect.width, vw: window.innerWidth };
          });
          expect(topbarOverflow.has, `Topbar overflow at ${viewport.name}`).toBe(false);

          // 5. Page header actions wrap (sales/reports)
          if (route.path.includes('/admin/sales') || route.path.includes('/admin/reports')) {
            const headerWrap = await page.evaluate(() => {
              const hdr = document.querySelector('.admin-page-header');
              if (!hdr) return true;
              return hdr.scrollWidth <= hdr.clientWidth + 5;
            });
            expect(headerWrap, `Header overflow at ${viewport.name} ${route.path}`).toBe(true);
          }

          // 6. Tables become cards on mobile
          if (route.hasTable && viewport.width <= 900) {
            // At <=900, thead should be hidden, rows become cards
            const headHidden = await page.evaluate(() => {
              const thead = document.querySelector('.data-table thead');
              if (!thead) return true;
              const s = window.getComputedStyle(thead);
              return s.display === 'none';
            });
            // Allow either table or empty state
            if (await page.locator('.data-table').count() > 0) {
              expect(headHidden, `Table thead should be hidden at ${viewport.width}px`).toBe(true);
            }
          }

          // 7. Search bar fits
          if (route.hasSearch) {
            const searchFits = await page.evaluate(() => {
              const input = document.querySelector('.admin-toolbar .search-box input, .search-box input');
              if (!input) return true;
              const rect = input.getBoundingClientRect();
              return rect.width <= window.innerWidth - 20 && rect.width > 50;
            });
            expect(searchFits, `Search input should fit viewport at ${viewport.name}`).toBe(true);
          }

          // 8. No element wider than viewport (catch fixed 400px modals etc when closed — they should be hidden)
          const wideEls = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.card, .admin-toolbar, .sales-reports-switcher, .report-period-tabs'));
            const vw = window.innerWidth;
            const bad = [];
            for (const el of els) {
              if (!(el instanceof HTMLElement)) continue;
              if (window.getComputedStyle(el).display === 'none') continue;
              const rect = el.getBoundingClientRect();
              if (rect.width > vw + 5 && rect.width < vw + 200) { // ignore full-width cards that are exactly vw
                // only flag if it overflows by >5 and not just full width
                if (rect.left < -5 || rect.right > vw + 5) bad.push({ cls: el.className.slice(0, 40), w: Math.round(rect.width), vw });
              }
            }
            return bad.slice(0, 2);
          });
          expect(wideEls, `Wide elements at ${viewport.name} ${route.path}: ${JSON.stringify(wideEls)}`).toEqual([]);
        });
      }

      test(`modals fit viewport at ${viewport.name}`, async ({ page }) => {
        // Open a modal that exists on this viewport: Try to open TripAssign or similar via Orders page
        await page.goto('/admin/orders', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.admin-page-header', { timeout: 15000 });
        // Try to find any clickable row to open detail, then try to open a modal
        const rowLink = page.locator('.data-table tbody tr a, .data-table tbody tr').first();
        if (await rowLink.count() > 0 && await rowLink.isVisible().catch(() => false)) {
          await rowLink.click().catch(() => {});
          await page.waitForTimeout(1000);
          // Try to open pickup modal if button exists
          const pickupBtn = page.getByRole('button', { name: /pickup|assign|reassign/i }).first();
          if (await pickupBtn.isVisible().catch(() => false)) {
            await pickupBtn.click().catch(() => {});
            await page.waitForTimeout(500);
            const modal = page.locator('.modal').first();
            if (await modal.isVisible().catch(() => false)) {
              const fits = await modal.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                return rect.width <= window.innerWidth - 16 && rect.height <= window.innerHeight - 24;
              });
              expect(fits, `Modal should fit viewport ${viewport.width}x${viewport.height}`).toBe(true);
              await page.keyboard.press('Escape').catch(() => {});
            }
          }
        }
        // Also check that no modal is overflowing when closed (should be hidden)
        await checkNoHorizontalOverflow(page, viewport);
      });

      test(`sidebar drawer works at ${viewport.name}`, async ({ page }) => {
        if (viewport.width <= 1024) {
          // Sidebar should be hidden by default, toggle should open it
          const sidebar = page.locator('.sidebar');
          await expect(sidebar).toBeVisible();
          // At mobile, sidebar is off-screen
          const isOffScreen = await sidebar.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return rect.left < -10;
          });
          // Either off-screen or open via button — both are valid initial states
          // Just ensure toggle button exists
          const toggle = page.locator('.mobile-menu-toggle');
          await expect(toggle).toBeVisible();
          await toggle.click();
          await page.waitForTimeout(400);
          const isOpen = await page.locator('.sidebar.open').count().then(c => c > 0).catch(() => false);
          // After click, should be open or backdrop visible
          const backdrop = await page.locator('.sidebar-backdrop').count().then(c => c > 0).catch(() => false);
          expect(isOpen || backdrop, `Sidebar drawer should open at ${viewport.width}px`).toBe(true);
          await page.keyboard.press('Escape').catch(() => {});
        } else {
          // Desktop: sidebar visible, toggle collapse
          const sidebar = page.locator('.sidebar');
          await expect(sidebar).toBeVisible();
          await checkNoHorizontalOverflow(page, viewport);
        }
      });
    });
  }
});
