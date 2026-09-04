import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const baseURL = process.env.SPLASH_TEST_URL || 'http://127.0.0.1:4173';
const outputDirectory = 'test-results/splash';
mkdirSync(outputDirectory, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  // Freeze the page before the module bundle starts to prove that the static
  // first paint is useful on its own, even on a very slow connection.
  const bootContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'no-preference',
  });
  const bootPage = await bootContext.newPage();
  await bootPage.route('**/assets/*.js', route => route.abort());
  await bootPage.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });

  const bootSplash = bootPage.locator('#app-boot-splash');
  await bootSplash.waitFor({ state: 'visible' });
  if ((await bootSplash.getAttribute('role')) !== 'status') {
    throw new Error('Static boot splash is missing role="status".');
  }
  if (!(await bootSplash.textContent())?.includes('Getting CargoExpress PH ready')) {
    throw new Error('Static boot splash does not contain a useful status message.');
  }
  await bootPage.screenshot({ path: `${outputDirectory}/boot-desktop.png` });
  await bootContext.close();

  // Normal startup must remove the overlay, render the actual route, and stay
  // free of runtime/overlay errors.
  const appContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const appPage = await appContext.newPage();
  const runtimeErrors = [];
  appPage.on('pageerror', error => runtimeErrors.push(error.message));
  appPage.on('console', message => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  await appPage.goto(`${baseURL}/login`, { waitUntil: 'networkidle' });
  await appPage.locator('#app-boot-splash').waitFor({ state: 'detached' });
  const visibleText = (await appPage.locator('body').innerText()).trim();
  if (visibleText.length < 40) throw new Error('The application rendered an empty or incomplete page.');
  if (await appPage.locator('.vite-error-overlay, vite-error-overlay').count()) {
    throw new Error('Vite error overlay is visible after startup.');
  }
  if (runtimeErrors.length) {
    throw new Error(`Browser runtime errors:\n${runtimeErrors.join('\n')}`);
  }
  await appPage.screenshot({ path: `${outputDirectory}/ready-desktop.png`, fullPage: true });
  await appContext.close();

  // Confirm the boot shell itself stays centered and free of horizontal
  // overflow at a narrow phone viewport.
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.route('**/assets/*.js', route => route.abort());
  await mobilePage.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
  await mobilePage.locator('#app-boot-splash').waitFor({ state: 'visible' });
  const hasHorizontalOverflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  if (hasHorizontalOverflow) throw new Error('Static boot splash overflows horizontally on mobile.');
  await mobilePage.screenshot({ path: `${outputDirectory}/boot-mobile.png` });
  await mobileContext.close();

  console.log('Splash browser checks passed (static boot, React handoff, desktop, and mobile).');
} finally {
  await browser.close();
}
