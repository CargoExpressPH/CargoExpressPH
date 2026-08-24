import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { mkdirSync } from 'fs';
import path from 'path';

dotenv.config({ path: '.env' });

const BASE = 'http://localhost:5173';
const OUT = 'e2e-audit-screenshots';
const ADMIN = { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD };

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
await sb.auth.signInWithPassword({ email: ADMIN.email, password: ADMIN.password });

const { data: trip } = await sb.from('trips').select('id, trip_number').eq('trip_number', 'TRIP-20260816-517').single();
const { data: order } = await sb.from('orders').select('id, tracking_number, user_id').eq('tracking_number', 'CE-20260816-1039').single();
const { data: custProfile } = await sb.from('profiles').select('id, email').eq('id', order.user_id).single();
const CUSTOMER = { email: custProfile.email, password: 'E2eCustomer!2026' };

const adminRoutes = [
  ['dashboard', '/admin'],
  ['orders', '/admin/orders'],
  ['order-detail', `/admin/orders/${order.id}`],
  ['trips', '/admin/trips'],
  ['trip-create', '/admin/trips/create'],
  ['trip-detail', `/admin/trips/${trip.id}`],
  ['customers', '/admin/customers'],
  ['customer-detail', `/admin/customers/${custProfile.id}`],
  ['sales', '/admin/sales'],
  ['reports', '/admin/reports'],
  ['announcements', '/admin/announcements'],
  ['inbox', '/admin/inbox'],
  ['contact-inquiries', '/admin/contact-inquiries'],
  ['feedback', '/admin/feedback'],
  ['activity-logs', '/admin/activity-logs'],
  ['company-info', '/admin/company-info'],
  ['profile', '/admin/profile'],
  ['change-password', '/admin/change-password'],
  ['change-email', '/admin/change-email'],
];

const customerRoutes = [
  ['home', '/customer'],
  ['orders', '/customer/orders'],
  ['order-detail', `/customer/orders/${order.id}`],
  ['book', '/customer/book'],
  ['track', '/customer/track'],
  ['trips', '/customer/trips'],
  ['notifications', '/customer/notifications'],
  ['profile', '/customer/profile'],
  ['personal-info', '/customer/personal-info'],
  ['change-password', '/customer/change-password'],
  ['change-email', '/customer/change-email'],
  ['support', '/customer/support'],
  ['payments', '/customer/payments'],
  ['help-guidelines', '/customer/help-guidelines'],
  ['about-version', '/customer/about-version'],
];

const publicRoutes = [
  ['track', '/track'],
  ['about', '/about'],
  ['login', '/login'],
  ['register', '/register'],
  ['forgot-password', '/forgot-password'],
  ['not-found', '/this-route-does-not-exist'],
];

const mobileRoutes = [
  ['cust-home', '/customer'],
  ['cust-book', '/customer/book'],
  ['admin-dashboard', '/admin'],
  ['admin-orders', '/admin/orders'],
  ['pub-track', '/track'],
  ['pub-about', '/about'],
];

const report = [];
const errors = {};

async function auditPage(page, slug, route, theme, viewport, tag) {
  const consoleErrors = [];
  const pageErrors = [];
  const onConsole = (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); };
  const onPageError = (err) => pageErrors.push(String(err).slice(0, 200));
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let bodyText = '';
    for (let i = 0; i < 14; i++) {
      await page.waitForTimeout(1000);
      bodyText = await page.evaluate(() => {
        const main = document.querySelector('main') || document.body;
        return (main.innerText || '').trim();
      });
      const loading = await page.locator('.page-loader, .skeleton, [class*="skeleton"], [class*="loading"]').count().catch(() => 0);
      if (bodyText.length > 60 && loading === 0) break;
    }
    const finalUrl = page.url();
    const redirectedToLogin = finalUrl.includes('/login') && !route.includes('/login') && !route.includes('/register') && !route.includes('/forgot-password');
    const heading = (await page.locator('h1, h2').first().innerText().catch(() => ''))?.trim().slice(0, 80);
    const file = `${OUT}/${tag}/${slug}-${theme}.png`;
    await page.screenshot({ path: file, fullPage: true });
    report.push({ tag, slug, theme, route, ok: bodyText.length > 60 && !redirectedToLogin, chars: bodyText.length, heading, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, finalUrl: finalUrl.replace(BASE, '') });
    if (consoleErrors.length) errors[`${tag}/${slug}-${theme}`] = consoleErrors;
    if (pageErrors.length) errors[`${tag}/${slug}-${theme}-pageerror`] = pageErrors;
  } catch (e) {
    report.push({ tag, slug, theme, route, ok: false, error: e.message.split('\n')[0].slice(0, 150) });
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

async function runRole(name, routes, creds, mobile = false) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    });
    await context.addInitScript((t) => localStorage.setItem('cargoexpress_theme', t), theme);
    const page = await context.newPage();
    if (creds) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await page.getByLabel(/email/i).first().fill(creds.email);
        await page.getByLabel(/password/i).first().fill(creds.password);
        await page.locator('button[type="submit"]').first().click();
        await page.waitForTimeout(8000);
        const landed = await page.waitForTimeout(0).then(async () => !page.url().includes('/login'));
        if (landed) break;
        console.log(`  login retry ${attempt} (${creds.email})`);
      }
    }
    const tag = mobile ? 'mobile' : name;
    for (const [slug, route] of routes) {
      await auditPage(page, slug, route, theme, mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, tag);
    }
    await context.close();
  }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

await runRole('admin', adminRoutes, ADMIN);
await runRole('customer', customerRoutes, CUSTOMER);
await runRole('public', publicRoutes, null);
await runRole('mobile', mobileRoutes, ADMIN, true);

await browser.close();

let bad = report.filter(r => !r.ok || r.consoleErrors > 0 || r.pageErrors > 0);
console.log(`\n=== AUDIT: ${report.length} screenshots, ${bad.length} with problems ===`);
for (const r of report.filter(x => !x.ok)) console.log(`FAIL  ${r.tag}/${r.slug}-${r.theme} ${r.route} ${r.error || `final=${r.finalUrl || ''}`} chars=${r.chars}`);
for (const [k, v] of Object.entries(errors)) { console.log(`CONSOLE ${k}`); v.forEach(e => console.log(`   ${e}`)); }
console.log('\nOK pages (rendered):');
for (const r of report.filter(x => x.ok)) console.log(`  ok ${r.tag}/${r.slug}-${r.theme} chars=${r.chars} h="${r.heading}"`);