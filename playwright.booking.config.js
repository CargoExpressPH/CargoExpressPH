import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 375, height: 667 } },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
});
