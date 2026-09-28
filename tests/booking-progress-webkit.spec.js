import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('booking layout keeps navigation anchored and progress below the header while a focused form scrolls', async ({ page }) => {
  const html = readFileSync('dist/index.html', 'utf8');
  const cssPath = html.match(/href="([^"]+\.css)"/)?.[1];
  expect(cssPath).toBeTruthy();
  await page.goto('/');
  await page.setContent(`<!doctype html><html class="booking-route-active"><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="http://localhost:5173${cssPath}"></head><body>
    <div class="customer-layout-v2 booking-scroll-shell"><header class="customer-navbar"><div class="customer-navbar-inner">CargoExpress PH</div></header>
    <div class="booking-progress-dock"><div class="step-progress" role="list" aria-label="Booking progress">1 &nbsp; 2 &nbsp; 3 &nbsp; 4 &nbsp; 5</div></div>
    <main class="w-full customer-main customer-main--booking"><div class="page-transition booking-page"><div class="customer-top-actions">Back</div><h2>Book Shipment</h2>
    <div class="step-progress" role="list" aria-label="Booking progress">1 &nbsp; 2 &nbsp; 3 &nbsp; 4 &nbsp; 5</div>
    <section style="height:1100px"><input id="field" class="form-input" style="margin-top:500px" aria-label="Sender address"></section>
    </div></main></div><nav class="customer-bottom-nav" aria-label="Customer navigation"><div class="customer-bottom-nav-inner">Home &nbsp; Book &nbsp; Trips</div></nav></body></html>`);
  await page.locator('.booking-page > .step-progress').evaluate(() => document.fonts.ready);
  await expect(page.locator('.booking-page > .step-progress')).toHaveCSS('position', 'sticky');
  const focusOffset = await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).scrollPaddingTop));
  expect(focusOffset).toBeGreaterThan(100);
  await expect(page.locator('html'), 'Book does not lock the root before typing').not.toHaveCSS('overflow-y', 'hidden');
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [768, 1024]]) {
    await page.setViewportSize({ width, height });
    // Older iOS can report a visual viewport shorter than the layout viewport
    // even before an input is focused. The Book tab must stay at the same
    // screen edge as the other customer tabs in that state.
    await page.evaluate(({ height }) => {
      document.body.classList.remove('keyboard-active');
      document.documentElement.style.setProperty('--booking-visible-top', '0px');
      document.documentElement.style.setProperty('--booking-visible-height', `${height - 70}px`);
    }, { height });
    const bottomNav = page.locator('.customer-bottom-nav');
    await expect(bottomNav, `${width}px bottom nav remains visible`).toBeVisible();
    await expect(bottomNav, `${width}px bottom nav uses the same anchor on Book`).toHaveCSS('position', 'fixed');
    const bottomEdge = await bottomNav.evaluate(el => el.getBoundingClientRect().bottom);
    const bookPillTop = await page.locator('.customer-bottom-nav-inner').evaluate(el => el.getBoundingClientRect().top);
    expect(bottomEdge, `${width}px Book tab bar stays at screen bottom`).toBeCloseTo(height, 0);
    // The real navigation stays mounted while the route changes. Toggle the
    // shell state in place and verify the bar does not move with it.
    const ordinaryRoute = await page.evaluate(() => {
      document.documentElement.classList.remove('booking-route-active');
      document.querySelector('.customer-layout-v2').classList.remove('booking-scroll-shell');
      return {
        bottom: document.querySelector('.customer-bottom-nav').getBoundingClientRect().bottom,
        pillTop: document.querySelector('.customer-bottom-nav-inner').getBoundingClientRect().top,
      };
    });
    expect(ordinaryRoute.bottom, `${width}px ordinary tab bar bottom`).toBeCloseTo(bottomEdge, 0);
    expect(ordinaryRoute.pillTop, `${width}px pill stays in place across routes`).toBeCloseTo(bookPillTop, 0);
    await page.evaluate(() => {
      document.documentElement.classList.add('booking-route-active');
      document.querySelector('.customer-layout-v2').classList.add('booking-scroll-shell');
    });
    for (const focused of [false, true]) {
      await page.evaluate(({ height, focused }) => {
        document.activeElement?.blur();
        window.scrollTo(0, 0);
        document.body.classList.toggle('keyboard-active', focused);
        document.documentElement.classList.toggle('booking-field-focused', focused);
        document.documentElement.style.setProperty('--booking-visible-top', focused ? '32px' : '0px');
        document.documentElement.style.setProperty('--booking-visible-height', `${focused ? Math.floor(height * 0.58) : height}px`);
        document.querySelector('.customer-main--booking').scrollTop = 0;
      }, { height, focused });
      if (focused) {
        await expect(page.locator('html'), `${width}px root locks only during input focus`).toHaveCSS('overflow-y', 'hidden');
        await expect(page.locator('.booking-scroll-shell'), `${width}px focused form uses viewport shell`).toHaveCSS('position', 'fixed');
        await expect(page.locator('.booking-progress-dock'), `${width}px progress dock is visible during keyboard focus`).toBeVisible();
        await expect(page.locator('.booking-page > .step-progress')).toBeHidden();
      } else {
        await expect(page.locator('html'), `${width}px root stays unlocked before input focus`).not.toHaveCSS('overflow-y', 'hidden');
        await expect(page.locator('.booking-scroll-shell'), `${width}px Book shares the ordinary tab layout at rest`).not.toHaveCSS('position', 'fixed');
        await expect(page.locator('.booking-progress-dock')).toBeHidden();
        await expect(page.locator('.booking-page > .step-progress')).toBeVisible();
      }
      if (focused) await page.locator('#field').focus();
      await page.evaluate(({ focused }) => {
        (focused ? document.querySelector('.customer-main--booking') : window).scrollTo({ top: 500, behavior: 'instant' });
      }, { focused });
      const result = await page.evaluate(({ focused }) => {
        const progress = document.querySelector(focused ? '.booking-progress-dock .step-progress' : '.booking-page > .step-progress');
        return {
          transform: getComputedStyle(document.querySelector('.customer-main')).transform,
          position: getComputedStyle(progress).position,
          barTop: progress.getBoundingClientRect().top,
          navTop: document.querySelector('.customer-navbar').getBoundingClientRect().top,
          navBottom: document.querySelector('.customer-navbar').getBoundingClientRect().bottom,
          barBottom: progress.getBoundingClientRect().bottom,
          fieldTop: document.querySelector('#field').getBoundingClientRect().top,
          fieldBottom: document.querySelector('#field').getBoundingClientRect().bottom,
          mainBottom: document.querySelector('.customer-main--booking').getBoundingClientRect().bottom,
          scrollY: document.querySelector('.customer-main--booking').scrollTop,
          documentScrollY: window.scrollY,
        };
      }, { focused });
      expect(result.transform, `${width}px main transform`).toBe('none');
      expect(result.position, `${width}px progress position`).toBe(focused ? 'static' : 'sticky');
      expect(focused ? result.scrollY : result.documentScrollY, `${width}px active scroll amount`).toBeGreaterThan(300);
      if (focused) expect(result.documentScrollY, `${width}px document remains still during focus`).toBe(0);
      expect(result.navTop, `${width}px header tracks visible viewport`).toBe(focused ? 32 : 0);
      expect(result.barTop, `${width}px progress top`).toBeGreaterThanOrEqual(result.navBottom - 1);
      expect(result.barTop, `${width}px progress top`).toBeLessThanOrEqual(result.navBottom + 12);
      if (focused) {
        expect(result.fieldTop, `${width}px focused field below progress`).toBeGreaterThan(result.barBottom);
        expect(result.fieldBottom, `${width}px focused field above keyboard`).toBeLessThan(result.mainBottom);
      }
    }
  }
});
