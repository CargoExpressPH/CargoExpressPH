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
  // Timeouts are elevated above the macOS-tuned defaults because a fresh test
  // context can take 20-60 s just to boot the app shell on a cold Windows box.
  timeout: 240_000,
  expect: { timeout: 25_000 },

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
    actionTimeout: 45_000,
    navigationTimeout: 120_000,
  },

  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],

  webServer: {
    // E2E runs against the PRODUCTION build, not the dev server. Vite's dev
    // optimizer re-bundles dependencies on the first run that imports a
    // page's icons/utilities (the "cold warm-up"), and a request killed by
    // that restart leaves a lazy chunk's import pending forever — React
    // Suspense then keeps the previous screen on top and the suite reads a
    // false "nothing happened". Production bundles have no optimizer, so this
    // class of race cannot occur there, and testing the built app is the
    // realistic target anyway. Build takes ~20 s on a cold Windows box; the
    // timeout below covers build + preview startup.
    command: 'npm run build && npm run preview -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
