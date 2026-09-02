import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const requiredFiles = [
  'dist/sw.js',
  'src/components/ui/RouteErrorBoundary.jsx',
];

for (const file of requiredFiles) {
  if (!existsSync(file)) throw new Error(`PWA offline check requires ${file}`);
}

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});

const sw = readFileSync('dist/sw.js', 'utf8');
const app = readFileSync('src/App.jsx', 'utf8');
const main = readFileSync('src/main.jsx', 'utf8');
const lazy = readFileSync('src/lib/lazyWithRetry.js', 'utf8');

const buildAssets = walk('dist/assets')
  .filter((file) => /\.(?:js|css)$/.test(file))
  .map((file) => `/${relative('dist', file).replaceAll('\\', '/')}`);
const missingAssets = buildAssets.filter((asset) => !sw.includes(asset));

if (buildAssets.length === 0) throw new Error('Build emitted no JS/CSS assets.');
if (missingAssets.length > 0) {
  throw new Error(`Service worker did not precache: ${missingAssets.join(', ')}`);
}
if (
  sw.includes("const CACHE_VERSION = '__BUILD_VERSION__'")
  || sw.includes("JSON.parse('__PRECACHE_ASSETS__')")
) {
  throw new Error('Service worker build placeholders were not replaced.');
}
if (!sw.includes('await Promise.all(PRECACHE_ASSETS.map(cacheUrl))')) {
  throw new Error('Build assets are not installed atomically.');
}
if (!sw.includes('Refusing to install a production worker without build assets.')) {
  throw new Error('Service worker can activate without a complete build manifest.');
}
if (!app.includes('errorElement: <RouteErrorBoundary />')) {
  throw new Error('React Router is missing its route-level error boundary.');
}
if (!main.includes('navigator.onLine === false')) {
  throw new Error('Vite preload recovery does not protect offline users.');
}
if (!lazy.includes("code = 'OFFLINE_CHUNK_UNAVAILABLE'")) {
  throw new Error('Lazy imports do not expose a recognizable offline error.');
}

console.log(`PWA offline checks passed (${buildAssets.length} JS/CSS assets precached).`);
