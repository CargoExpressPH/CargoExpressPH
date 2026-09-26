import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_PAGES, SITE_ORIGIN, SOCIAL_IMAGE } from '../src/seo/publicPages.js';
import { FAQ_ITEMS } from '../src/constants/faqContent.js';

const config = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8'));
const sitemap = readFileSync(resolve('dist/sitemap.xml'), 'utf8');
const readJsonLd = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Vercel matches `source` as a path-to-regexp pattern. The rewrites here only
// use literal paths and regex groups, which read the same as a plain RegExp.
assert.ok(config.rewrites.every(({ source }) => !source.includes(':')),
  'Named params in a rewrite source need a real path-to-regexp matcher in this test');
const rewriteFor = (path) => config.rewrites.find(({ source }) => new RegExp(`^${source}$`).test(path));

for (const [path, page] of Object.entries(PUBLIC_PAGES)) {
  const output = path === '/' ? 'dist/index.html' : `dist/_seo/${path.slice(1)}.html`;
  assert.ok(existsSync(output), `Missing public page: ${output}`);
  const html = readFileSync(output, 'utf8');
  const url = `${SITE_ORIGIN}${path === '/' ? '/' : path}`;
  assert.ok(page.title.length <= 60, `Title over 60 characters, search results will cut it: ${path}`);
  assert.ok(page.description.length <= 160, `Description over 160 characters, search results will cut it: ${path}`);
  assert.ok(html.includes(`<link rel="canonical" href="${url}" />`), `Wrong canonical: ${path}`);
  assert.ok(html.includes(`<meta property="og:url" content="${url}" />`), `Wrong social URL: ${path}`);
  assert.ok(html.includes(`<meta property="og:image" content="${SOCIAL_IMAGE.url}" />`), `Wrong social image: ${path}`);
  assert.ok(html.includes(`<meta property="og:image:width" content="${SOCIAL_IMAGE.width}" />`)
    && html.includes(`<meta property="og:image:height" content="${SOCIAL_IMAGE.height}" />`), `Social image size missing: ${path}`);
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image" />'), `Not a large-image card: ${path}`);
  assert.ok(html.includes(`<h1>${page.heading}</h1>`), `No crawlable content: ${path}`);
  assert.ok(html.includes('<meta name="robots" content="index, follow" />'), `Not indexable: ${path}`);
  if (path === '/faq' || path === '/about') {
    // Verify the delivered body contains complete answers even without JS,
    // rather than only metadata or a heading that waits for React to load.
    const body = html.match(/<main class="seo-fallback">([\s\S]*?)<\/main>/)?.[1] || '';
    for (const { title, answer } of FAQ_ITEMS) {
      assert.ok(body.includes(`<h3>${escapeHtml(title)}</h3>`), `Missing FAQ question on ${path}: ${title}`);
      assert.ok(body.includes(`<p>${escapeHtml(answer)}</p>`), `Missing FAQ answer on ${path}: ${title}`);
    }
  }
  assert.ok(sitemap.includes(`<loc>${url}</loc>`), `Missing sitemap entry: ${path}`);
  const types = readJsonLd(html)['@graph'].map((node) => node['@type']);
  assert.deepEqual(types, path === '/' ? ['Organization', 'WebSite'] : ['WebPage'], `Wrong structured data: ${path}`);
  if (path !== '/') {
    assert.equal(rewriteFor(path)?.destination, `/_seo/${path.slice(1)}.html`, `Missing rewrite: ${path}`);
  }
}

const imageFile = resolve('dist', new URL(SOCIAL_IMAGE.url).pathname.slice(1));
assert.ok(existsSync(imageFile), `Social image not in the build: ${imageFile}`);

for (const route of ['/admin', '/customer', '/login', '/register', '/payment/return']) {
  assert.ok(!sitemap.includes(`<loc>${SITE_ORIGIN}${route}`), `Private URL in sitemap: ${route}`);
}

// Unknown URLs must reach Vercel's 404 (served from dist/404.html with a 404
// status) rather than a catch-all rewrite that answers 200 with the homepage.
assert.equal(config.trailingSlash, false, 'Without trailingSlash: false, /about/ serves a duplicate of the homepage');
assert.ok(!config.rewrites.some(({ source }) => source === '/(.*)'), 'Catch-all rewrite turns every 404 into a 200');
assert.equal(rewriteFor('/this-page-does-not-exist'), undefined, 'Unknown URLs must not be rewritten');
const notFound = readFileSync(resolve('dist/404.html'), 'utf8');
assert.ok(notFound.includes('<meta name="robots" content="noindex, nofollow" />'), '404 page must be noindex');
assert.ok(!notFound.includes('rel="canonical"'), '404 page must not claim a canonical URL');
assert.ok(notFound.includes('<div id="root">'), '404 page must still boot the app');

// Every route the app serves must be reachable, or deep links and page
// refreshes on it would land on the 404 page.
const appRoutes = [...readFileSync(resolve('src/App.jsx'), 'utf8').matchAll(/path: '(\/[^']*)'/g)].map((m) => m[1]);
for (const route of [...appRoutes, '/customer/orders/example-id', '/admin/trips/example-id']) {
  if (route === '/') continue; // dist/index.html is served from the filesystem
  assert.ok(rewriteFor(route), `Route in App.jsx has no rewrite in vercel.json: ${route}`);
}

console.log(`Verified ${Object.keys(PUBLIC_PAGES).length} public page shells, the 404 page, and ${appRoutes.length} app routes.`);
