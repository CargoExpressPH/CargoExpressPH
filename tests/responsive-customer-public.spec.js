import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { name: '320', w: 320, h: 568 },
  { name: '375', w: 375, h: 667 },
  { name: '390', w: 390, h: 844 },
  { name: '768', w: 768, h: 1024 },
  { name: '1280', w: 1280, h: 800 },
  { name: '1440', w: 1440, h: 900 },
];

const PUBLIC_ROUTES = [
  { path: '/track', sel: '.trk-page' },
  { path: '/about', sel: '.public-about-page' },
  { path: '/login', sel: '.auth-page, .login-split-page' },
  { path: '/register', sel: '.auth-page' },
];

const checkNoOverflow = async (page, vp) => {
  const o = await page.evaluate(() => {
    const d = document.documentElement, b = document.body;
    return { sw: Math.max(d.scrollWidth, b.scrollWidth), cw: window.innerWidth, diff: Math.max(d.scrollWidth, b.scrollWidth) - window.innerWidth };
  });
  expect(o.diff, `overflow ${o.diff}px at ${vp.name} ${o.sw}>${o.cw}`).toBeLessThanOrEqual(2);
};

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.w}x${vp.h})`, () => {
    for (const r of PUBLIC_ROUTES) {
      test(`${r.path} no overflow`, async ({ page }) => {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.goto(r.path, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(r.sel, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(600);
        await checkNoOverflow(page, vp);
        // search/button not clipped
        const clipped = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('button, a.btn'));
          const vw = window.innerWidth;
          return els.filter(el => {
            const s = window.getComputedStyle(el);
            if (s.display==='none'||s.visibility==='hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width>0 && (r.left<-5 || r.right>vw+5) && r.top>=0 && r.top<window.innerHeight;
          }).length;
        });
        expect(clipped, `clipped buttons at ${vp.name} ${r.path}`).toBe(0);
      });
    }
  });
}
