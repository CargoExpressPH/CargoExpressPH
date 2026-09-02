import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageMetadata = JSON.parse(readFileSync('package.json', 'utf8'));
const viteConfig = readFileSync('vite.config.js', 'utf8');
const versionModule = readFileSync('src/lib/appVersion.js', 'utf8');
const aboutPage = readFileSync('src/pages/customer/AboutVersionPage.jsx', 'utf8');
const profilePage = readFileSync('src/pages/customer/ProfilePage.jsx', 'utf8');

assert.match(
  packageMetadata.version,
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  'package.json must contain a valid semantic app version.',
);
assert.match(viteConfig, /readFileSync\(resolve\('package\.json'\)/);
assert.match(viteConfig, /VERCEL_GIT_COMMIT_SHA/);
assert.match(viteConfig, /VITE_APP_VERSION/);
assert.match(viteConfig, /VITE_APP_BUILD_ID/);
assert.match(versionModule, /import\.meta\.env\.VITE_APP_VERSION/);
assert.match(versionModule, /import\.meta\.env\.VITE_APP_BUILD_ID/);
assert.match(aboutPage, /APP_BUILD_ID, APP_VERSION/);
assert.match(aboutPage, /Build \$\{APP_BUILD_ID\}/);
assert.match(profilePage, /CargoExpress PH v\{APP_VERSION\}/);
assert.doesNotMatch(aboutPage, new RegExp(`['\"]${packageMetadata.version}['\"]`));
assert.doesNotMatch(profilePage, new RegExp(`v${packageMetadata.version}`));

console.log(`App version contract passed (package version ${packageMetadata.version}).`);
