import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_PAGES, SITE_ORIGIN } from '../src/seo/publicPages.js';

const config = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8'));
const sitemap = readFileSync(resolve('dist/sitemap.xml'), 'utf8');

for (const [path, page] of Object.entries(PUBLIC_PAGES)) {
  const output = path === '/' ? 'dist/index.html' : `dist/_seo/${path.slice(1)}.html`;
  assert.ok(existsSync(output), `Missing public page: ${output}`);
  const html = readFileSync(output, 'utf8');
  const url = `${SITE_ORIGIN}${path === '/' ? '/' : path}`;
  assert.ok(html.includes(`<link rel="canonical" href="${url}" />`), `Wrong canonical: ${path}`);
  assert.ok(html.includes(`<meta property="og:url" content="${url}" />`), `Wrong social URL: ${path}`);
  assert.ok(html.includes(`<h1>${page.heading}</h1>`), `No crawlable content: ${path}`);
  assert.ok(html.includes('<meta name="robots" content="index, follow" />'), `Not indexable: ${path}`);
  assert.ok(sitemap.includes(`<loc>${url}</loc>`), `Missing sitemap entry: ${path}`);
  if (path !== '/') {
    assert.ok(config.rewrites.some(({ source, destination }) =>
      source === path && destination === `/_seo/${path.slice(1)}.html`), `Missing rewrite: ${path}`);
  }
}

for (const route of ['/admin', '/customer', '/login', '/register', '/payment/return']) {
  assert.ok(!sitemap.includes(`<loc>${SITE_ORIGIN}${route}`), `Private URL in sitemap: ${route}`);
}
console.log(`Verified ${Object.keys(PUBLIC_PAGES).length} public page shells and their routes.`);
