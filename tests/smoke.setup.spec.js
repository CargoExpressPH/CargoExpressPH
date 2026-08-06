import { test, expect } from '@playwright/test';

/**
 * Infrastructure smoke check — no credentials required.
 *
 * Proves the dev server boots, Playwright can drive it, and the selectors the
 * journey relies on actually exist, so a failure in the real run points at the
 * application rather than at the harness. Run it on its own with:
 *   npx playwright test tests/smoke.setup.spec.js
 */
test.describe('harness smoke check', () => {

  test('dev server serves the app and the login form renders', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  test('bad credentials are rejected without a crash', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#login-email').fill('definitely-not-a-user@cargoexpressph-e2e.test');
    await page.locator('#login-password').fill('WrongPassword!123');
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Should surface an error and stay put — not navigate, not white-screen.
    await expect(page.locator('.form-error, .toast, .auth-error, [role="alert"]').first())
      .toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('the registration wizard renders its first step', async ({ page }) => {
    await page.goto('/register');
    for (const id of ['reg-name', 'reg-email', 'reg-phone', 'reg-password', 'reg-confirm-password']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });

  test('the public tracking page is reachable anonymously', async ({ page }) => {
    await page.goto('/track');
    await expect(page.locator('.trk-page')).toBeVisible();
  });
});
