import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.test', override: true });

/**
 * Playwright configuration for the CargoExpress PH end-to-end suite.
 *
 * Two choices here are load-bearing and should not be "tidied up":
 *
 * 1. `channel: 'chrome'` — Playwright's own Chromium build does not ship for
 *    macOS 12, which is what this project is developed on. Driving the
 *    system-installed Google Chrome is the supported way around that and needs
 *    no browser download. On a newer macOS you may drop the channel and use the
 *    bundled Chromium instead; nothing else in the suite depends on it.
 *
 * 2. `workers: 1` and `retries: 0` — the suite drives ONE shared Supabase
 *    project through a stateful journey: it creates a trip, registers a
 *    customer, books against that trip, then weighs and part-pays that booking.
 *    Running it in parallel would have the phases racing each other through the
 *    same rows. Retrying is worse than failing: none of these steps is
 *    idempotent, so a retried "create trip" leaves a second trip behind and a
 *    retried payment records a second payment. A red test you can read beats a
 *    green one built on duplicated data.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,

  // The journey covers ~40 UI steps against a live remote database; the
  // default 30 s per test is not enough for the booking wizard alone.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    // Desktop width on purpose: below 1024px the admin sidebar becomes a
    // drawer and the customer layout swaps in a bottom tab bar, so a narrow
    // viewport would be testing a different set of components.
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Video is OFF deliberately. Playwright's recorder shells out to a bundled
    // ffmpeg that, like its Chromium, has no macOS 12 build — leaving it on
    // makes every test fail at newPage() with "Executable doesn't exist",
    // masking the real result. Traces already carry a screenshot filmstrip plus
    // the DOM and network log, so nothing diagnostic is lost. Turn this back on
    // when the project moves to macOS 13+ or runs in CI on Linux.
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },

  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],

  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
