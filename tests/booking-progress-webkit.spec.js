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
    <div class="customer-layout-v2 booking-scroll-shell"><header class="customer-navbar"><div class="customer-navbar-inner">CargoExpress PH</div></header>
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
      await page.evaluate(({ height, focused }) => {
        document.activeElement?.blur();
        document.documentElement.style.setProperty('--booking-visible-top', focused ? '32px' : '0px');
        document.documentElement.style.setProperty('--booking-visible-height', `${focused ? Math.floor(height * 0.58) : height}px`);
        document.querySelector('.customer-main--booking').scrollTop = 0;
      }, { height, focused });
      if (focused) await page.locator('#field').focus();
      await page.evaluate(() => document.querySelector('.customer-main--booking').scrollTo({ top: 500, behavior: 'instant' }));
      const result = await page.evaluate(() => ({
        transform: getComputedStyle(document.querySelector('.customer-main')).transform,
        position: getComputedStyle(document.querySelector('.step-progress')).position,
        barTop: document.querySelector('.step-progress').getBoundingClientRect().top,
        navTop: document.querySelector('.customer-navbar').getBoundingClientRect().top,
        navBottom: document.querySelector('.customer-navbar').getBoundingClientRect().bottom,
        barBottom: document.querySelector('.step-progress').getBoundingClientRect().bottom,
        fieldTop: document.querySelector('#field').getBoundingClientRect().top,
        fieldBottom: document.querySelector('#field').getBoundingClientRect().bottom,
        mainBottom: document.querySelector('.customer-main--booking').getBoundingClientRect().bottom,
        scrollY: document.querySelector('.customer-main--booking').scrollTop,
        documentScrollY: window.scrollY,
      }));
      expect(result.transform, `${width}px main transform`).toBe('none');
      expect(result.position, `${width}px progress position`).toBe('sticky');
      expect(result.scrollY, `${width}px scroll amount`).toBeGreaterThan(300);
      expect(result.documentScrollY, `${width}px document remains still`).toBe(0);
      expect(result.navTop, `${width}px header tracks visible viewport`).toBe(focused ? 32 : 0);
      expect(result.barTop, `${width}px progress top`).toBeGreaterThanOrEqual(result.navBottom - 1);
      expect(result.barTop, `${width}px progress top`).toBeLessThanOrEqual(result.navBottom + 32);
      if (focused) {
        expect(result.fieldTop, `${width}px focused field below progress`).toBeGreaterThan(result.barBottom);
        expect(result.fieldBottom, `${width}px focused field above keyboard`).toBeLessThan(result.mainBottom);
      }
    }
  }
});
