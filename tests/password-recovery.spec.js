import { test, expect } from '@playwright/test';

// Exercise the production app without spending a real customer's one-time
// recovery token or changing an account password in the hosted project.
test.use({ serviceWorkers: 'block' });

const recoveryUrl = '/reset-password?token_hash=one-time-test-token&type=recovery';
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'recovery-test@example.com',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
};

const enterNewPassword = async (page) => {
  await page.locator('#reset-password').fill('SecurePassword123');
  await page.locator('#reset-confirm-password').fill('SecurePassword123');
  await page.getByRole('button', { name: 'Update Password' }).click();
};

test('a token-hash link survives refresh and is verified only on submit', async ({ page }) => {
  let verifications = 0;
  let updates = 0;
  await page.route('**/auth/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('/verify') && route.request().method() === 'POST') {
      verifications += 1;
      expect(JSON.parse(route.request().postData()).token_hash).toBe('one-time-test-token');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        access_token: 'test-recovery-access-token',
        refresh_token: 'test-recovery-refresh-token',
        token_type: 'bearer',
        expires_in: 3600,
        user,
      }) });
    }
    if (pathname.endsWith('/user') && route.request().method() === 'PUT') {
      updates += 1;
      expect(JSON.parse(route.request().postData()).password).toBe('SecurePassword123');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user }) });
    }
    if (pathname.endsWith('/logout')) {
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto(recoveryUrl);
  await expect(page.getByRole('heading', { name: 'Set New Password' })).toBeVisible();
  expect(verifications).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set New Password' })).toBeVisible();
  expect(verifications).toBe(0);

  await enterNewPassword(page);
  await expect(page.getByRole('heading', { name: 'Password Updated!' })).toBeVisible();
  expect(verifications).toBe(1);
  expect(updates).toBe(1);
  await expect(page).toHaveURL(/\/reset-password$/);
});

test('an expired token never calls the password update endpoint', async ({ page }) => {
  let updates = 0;
  await page.route('**/auth/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('/verify')) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
        code: 'otp_expired',
        msg: 'Token has expired or is invalid',
      }) });
    }
    if (pathname.endsWith('/user') && route.request().method() === 'PUT') updates += 1;
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto(recoveryUrl);
  await enterNewPassword(page);
  await expect(page.getByRole('heading', { name: 'Link Expired or Invalid' })).toBeVisible();
  expect(updates).toBe(0);
});

test('a legacy recovery session survives SDK removal of the URL fragment', async ({ page }) => {
  await page.route('**/auth/v1/user', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ user }),
  }));

  await page.goto('/reset-password#access_token=legacy-recovery-access&refresh_token=legacy-recovery-refresh&expires_in=3600&token_type=bearer&type=recovery');
  await expect(page.getByRole('heading', { name: 'Set New Password' })).toBeVisible();
});

test.describe('installed PWA', () => {
  test.use({ serviceWorkers: 'allow' });

  test('keeps a recovery link available offline without caching its token URL', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
    await page.goto(recoveryUrl);
    await expect(page.getByRole('heading', { name: 'Set New Password' })).toBeVisible();

    const cachedUrls = await page.evaluate(async () => {
      const urls = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        urls.push(...(await cache.keys()).map(request => request.url));
      }
      return urls;
    });
    expect(cachedUrls.some(url => url.includes('token_hash='))).toBe(false);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Set New Password' })).toBeVisible();
    await expect(page).toHaveURL(/token_hash=one-time-test-token/);
  });
});
