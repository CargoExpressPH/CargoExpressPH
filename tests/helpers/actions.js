import { expect } from '@playwright/test';

/**
 * Shared page actions. Every selector here was read off the actual component
 * source, not guessed — when a control has a stable id the helper uses it, and
 * where the app renders a custom widget the helper drives that widget's real
 * DOM contract.
 */

/**
 * `CustomSelect` is not a <select>. It renders a <button id={id}> trigger that
 * opens a role="listbox" of role="option" buttons, so `selectOption()` cannot
 * touch it. This drives it the way a user does: click the trigger, click the
 * option, then assert the trigger's label actually changed — the click is
 * pointless if the menu closed without committing.
 */
export const selectCustom = async (page, triggerId, optionLabel) => {
  const trigger = page.locator(`#${triggerId}`);
  await expect(trigger).toBeEnabled();

  // The open click is retried on purpose. This is a hand-rolled widget whose
  // menu is conditionally rendered from React state, so a click that lands
  // while the component is still settling — right after a wizard step swaps in,
  // for example — toggles nothing and leaves no menu to select from. A native
  // <select> would not need this; an aria-expanded button does.
  const listbox = page.getByRole('listbox');
  let opened = false;

  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    await trigger.click();
    opened = await listbox.first().isVisible({ timeout: 3_000 }).catch(() => false);
    if (!opened) await page.waitForTimeout(500);
  }

  if (!opened) {
    throw new Error(`CustomSelect #${triggerId} never opened its listbox after 3 attempts`);
  }

  const option = page.getByRole('option', { name: optionLabel, exact: true });
  await expect(option, `option "${optionLabel}" in #${triggerId}`).toBeVisible();
  await option.click();

  // The click is pointless if the menu closed without committing a value.
  await expect(trigger).toContainText(optionLabel);
};

/**
 * Fills an input by id and verifies the value landed — controlled inputs can
 * silently reject or rewrite what you type.
 *
 * The comparison is case-insensitive on purpose. Several forms run input
 * through `toTitleCase` as you type ("near the plaza" → "Near The Plaza"), and
 * phone fields strip non-digits. Those are the app working as designed, so an
 * exact-match assertion here would fail on correct behaviour. What matters is
 * that the characters arrived, not their casing.
 */
export const fillById = async (page, id, value) => {
  const field = page.locator(`#${id}`);
  await expect(field).toBeVisible();
  await field.fill(String(value));
  await expect(field).toHaveValue(
    new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  );
};

/**
 * Signs in through the real login form.
 *
 * Waits for the post-login redirect rather than a fixed timeout: AuthContext
 * fetches the profile before the route guard will let the layout render, so
 * "the URL changed" is the only honest signal that login finished.
 */
export const login = async (page, email, password, { expectPath }) => {
  await page.goto('/login');
  await fillById(page, 'login-email', email);
  await fillById(page, 'login-password', password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await page.waitForURL(new RegExp(`${expectPath.replace('/', '\\/')}`), { timeout: 45_000 });
};

/**
 * Signs out via the UI so the next phase starts from a clean session.
 * Falls back to clearing storage if the menu shape differs, because a failure
 * to log out must not be reported as a failure of the flow under test.
 */
export const logout = async (page) => {
  try {
    const trigger = page.locator('.sidebar-profile-btn, .customer-navbar-avatar, [aria-label*="profile" i]').first();
    if (await trigger.isVisible({ timeout: 3000 })) {
      await trigger.click();
      const item = page.getByRole('button', { name: /log ?out|sign out/i }).first();
      if (await item.isVisible({ timeout: 3000 })) {
        await item.click();
        const confirm = page.getByRole('button', { name: /^(log ?out|sign out|confirm|yes)$/i }).last();
        if (await confirm.isVisible({ timeout: 3000 })) await confirm.click();
        await page.waitForURL(/\/login/, { timeout: 15_000 });
        return;
      }
    }
  } catch {
    // Fall through to the storage reset below.
  }

  await page.context().clearCookies();
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter(k => k.startsWith('sb-'))
      .forEach(k => localStorage.removeItem(k));
    sessionStorage.clear();
  });
  await page.goto('/login');
  await page.waitForURL(/\/login/);
};

/**
 * Waits for a toast. The app surfaces both success and failure through the
 * same toast channel, so a test that only waits for "some toast" can pass on
 * an error. Always pass the text you expect.
 */
export const expectToast = async (page, pattern) => {
  await expect(page.locator('.toast').filter({ hasText: pattern }).first())
    .toBeVisible({ timeout: 30_000 });
};

/**
 * Reads a numeric stat tile only once it has stopped moving.
 *
 * The dashboards render figures through `AnimatedCounter`, which eases from 0
 * to the real value over ~1.2s. Reading textContent the moment the tile is
 * visible therefore samples a meaningless intermediate number — and would make
 * every aggregate assertion flaky rather than wrong. This polls until two
 * consecutive reads agree, which is the earliest point the value is real.
 */
export const readSettledNumber = async (locator, { parse, timeout = 20_000 } = {}) => {
  const started = Date.now();
  let previous = null;
  let stableFor = 0;

  while (Date.now() - started < timeout) {
    const text = await locator.textContent();
    const value = parse(text);

    if (previous !== null && value === previous && !Number.isNaN(value)) {
      stableFor += 1;
      if (stableFor >= 2) return value;
    } else {
      stableFor = 0;
    }
    previous = value;
    await locator.page().waitForTimeout(250);
  }

  throw new Error(`Value never settled within ${timeout}ms (last read: ${previous})`);
};

/**
 * Waits for a navigation that a submit is supposed to cause, but races it
 * against the app's error toast.
 *
 * Without this, a failed save reports as "Timeout waiting for navigation" —
 * which says the button did nothing and tells you nothing about why. The app
 * surfaces save failures as a toast that auto-dismisses in a few seconds, so
 * by the time a 45s navigation timeout fires, the actual explanation has been
 * gone for 40 of them. Racing the two turns a mystery into a message.
 */
export const expectNavigationOrError = async (page, urlPattern, timeout = 45_000) => {
  const errorToast = page.locator('.toast').filter({ hasText: /fail|error|unable|cannot|invalid/i }).first();

  const outcome = await Promise.race([
    page.waitForURL(urlPattern, { timeout }).then(() => ({ ok: true })),
    errorToast.waitFor({ state: 'visible', timeout })
      .then(async () => ({ ok: false, message: (await errorToast.textContent())?.trim() })),
  ]).catch((err) => ({ ok: false, message: `neither navigation nor an error toast appeared — ${err.message}` }));

  if (!outcome.ok) {
    throw new Error(`Submit did not navigate to ${urlPattern}. App reported: ${outcome.message}`);
  }
};

/**
 * Attaches diagnostics to a page: failed HTTP responses and console errors.
 * Returns a function that renders whatever it collected, so a failing test can
 * say what the network actually did rather than only what the DOM looked like.
 */
export const collectDiagnostics = (page) => {
  const problems = [];

  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()} ${res.request().method()} ${res.url().slice(0, 180)}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text().slice(0, 200)}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message.slice(0, 200)}`));

  return () => (problems.length ? `\n  Diagnostics:\n    ${problems.join('\n    ')}` : '\n  Diagnostics: none captured');
};

/**
 * Marks the customer welcome tour as already seen, for this browser context.
 *
 * `OnboardingModal` shows once per device, gated on a localStorage key. But
 * Playwright gives every test a FRESH context, so without this the tour opens
 * on top of every customer-side test and intercepts the first click — a test
 * environment artifact, not something the flows under test are about.
 *
 * The sign-up test deliberately does NOT call this: a real new user does meet
 * the tour, and getting past it is part of the flow, so that test dismisses it
 * through the actual Skip button instead.
 */
export const suppressOnboarding = async (page) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('cargoexpress_onboarding_done', 'true'); } catch { /* private mode */ }
  });
};

/** Dismisses onboarding / install banners that would sit over the UI. */
export const dismissOverlays = async (page) => {
  const dismissers = [
    page.getByRole('button', { name: /^(got it|skip|maybe later|not now|dismiss|close)$/i }),
    page.locator('.install-banner-close, .onboarding-skip, [aria-label*="dismiss" i]'),
  ];
  for (const locator of dismissers) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const el = locator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click().catch(() => {});
      }
    }
  }
};
