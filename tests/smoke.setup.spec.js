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

  test('the public legal documents are published with version information', async ({ page }) => {
    await page.goto('/terms');
    await expect(page.getByRole('heading', { name: 'Terms of Service', level: 1 })).toBeVisible();
    await expect(page.getByText('Effective date: 22 August 2026')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy Policy' }).first()).toBeVisible();

    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeVisible();
    await expect(page.getByText('Effective date: 22 August 2026')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms of Service' }).first()).toBeVisible();
  });

  test('registration presents explicit legal acceptance before account creation', async ({ page }) => {
    await page.goto('/register');
    await page.locator('#reg-name').fill('Test Customer');
    await page.locator('#reg-facebook').fill('Test Customer');
    await page.locator('#reg-email').fill('legal-consent-check@cargoexpressph-e2e.test');
    await page.locator('#reg-phone').fill('09171234567');
    await page.locator('#reg-password').fill('Password123');
    await page.locator('#reg-confirm-password').fill('Password123');
    await page.getByRole('button', { name: /Continue to Address/ }).click();

    await expect(page.locator('#reg-legal-consent')).toBeVisible();
    await expect(page.locator('#reg-legal-consent')).not.toBeChecked();
    await expect(page.locator('#reg-legal-consent')).toHaveAttribute('required', '');
    await expect(page.getByRole('link', { name: 'Terms of Service' }).last()).toHaveAttribute('href', '/terms?returnTo=register');
    await expect(page.getByRole('link', { name: 'Privacy Policy' }).last()).toHaveAttribute('href', '/privacy?returnTo=register');

    await page.getByRole('link', { name: 'Terms of Service' }).last().click();
    await expect(page.getByRole('link', { name: 'Back' })).toBeVisible();
    await expect(page.getByText('Version 2026-08-22')).not.toBeVisible();
    await page.getByRole('link', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/register\?step=2/);
    await expect(page.locator('#reg-legal-consent')).toBeVisible();
    await expect(page.locator('#reg-province')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('#reg-name')).toHaveValue('Test Customer');
  });

  test('the public tracking page is reachable anonymously', async ({ page }) => {
    await page.goto('/track');
    await expect(page.locator('.trk-page')).toBeVisible();
  });

  test('public tracking does not show a gesture-blocking iOS install prompt', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/track');
    await page.waitForTimeout(3_300);

    await expect(page.locator('.trk-page')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Install Cargo Express PH' })).toHaveCount(0);
  });
});
