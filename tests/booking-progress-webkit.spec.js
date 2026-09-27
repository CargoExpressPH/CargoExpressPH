import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('booking layout keeps progress below the header while a focused form scrolls', async ({ page, browser }) => {
  test.skip(browser.browserType().name() !== 'webkit', 'Run with playwright.booking.config.js');
  const html = readFileSync('dist/index.html', 'utf8');
  const cssPath = html.match(/href="([^"]+\.css)"/)?.[1];
  expect(cssPath).toBeTruthy();
  await page.goto('/');
  await page.setContent(`<!doctype html><html class="booking-route-active"><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="http://localhost:5173${cssPath}"></head><body>
    <div class="customer-layout-v2"><header class="customer-navbar"><div class="customer-navbar-inner">CargoExpress PH</div></header>
    <main class="w-full customer-main customer-main--booking"><div class="page-transition booking-page"><h2>Book Shipment</h2>
    <div class="step-progress" role="list" aria-label="Booking progress">1 &nbsp; 2 &nbsp; 3 &nbsp; 4 &nbsp; 5</div>
    <section style="height:1100px"><input id="field" class="form-input" style="margin-top:500px" aria-label="Sender address"></section>
    </div></main></div></body></html>`);
  await page.locator('.step-progress').evaluate(() => document.fonts.ready);
  await expect(page.locator('.step-progress')).toHaveCSS('position', 'sticky');
  const focusOffset = await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).scrollPaddingTop));
  expect(focusOffset).toBeGreaterThan(100);
  for (const [width, height] of [[320, 568], [375, 667], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const focused of [false, true]) {
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      if (focused) await page.locator('#field').focus();
      await page.evaluate(() => window.scrollTo({ top: 500, behavior: 'instant' }));
      const result = await page.evaluate(() => ({
        transform: getComputedStyle(document.querySelector('.customer-main')).transform,
        position: getComputedStyle(document.querySelector('.step-progress')).position,
        barTop: document.querySelector('.step-progress').getBoundingClientRect().top,
        navBottom: document.querySelector('.customer-navbar').getBoundingClientRect().bottom,
        scrollY: window.scrollY,
      }));
      expect(result.transform, `${width}px main transform`).toBe('none');
      expect(result.position, `${width}px progress position`).toBe('sticky');
      expect(result.scrollY, `${width}px scroll amount`).toBeGreaterThan(300);
      expect(result.barTop, `${width}px progress top`).toBeGreaterThanOrEqual(result.navBottom - 1);
      expect(result.barTop, `${width}px progress top`).toBeLessThanOrEqual(result.navBottom + 20);
    }
  }
});
