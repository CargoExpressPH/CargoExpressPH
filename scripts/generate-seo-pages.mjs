import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_PAGES, SITE_ORIGIN } from '../src/seo/publicPages.js';

const dist = resolve('dist');
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function replaceRequired(source, pattern, replacement) {
  if (!pattern.test(source)) throw new Error(`SEO HTML template changed: ${pattern}`);
  return source.replace(pattern, replacement);
}

function renderFallback(page) {
  // Real, publicly visible navigation and a summary of the corresponding
  // screen. React replaces this when the app loads; it stays usable without JS.
  const links = [
    ['/', 'Home'], ['/about', 'About'], ['/schedules', 'Trip Schedules'],
    ['/track', 'Track Shipment'], ['/faq', 'Help'],
    ['/terms', 'Terms'], ['/privacy', 'Privacy'], ['/login', 'Sign In'],
  ];
  return `<main class="seo-fallback"><a href="/">CargoExpress PH</a>`
    + `<h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.summary)}</p>`
    + `<nav aria-label="Site pages">${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav></main>`;
}

function renderPage(path, page) {
  const url = `${SITE_ORIGIN}${path === '/' ? '/' : path}`;
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  let output = html;
  output = replaceRequired(output, /<title>[^<]*<\/title>/, `<title>${title}</title>`);
  output = replaceRequired(output, /<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${description}" />`);
  output = replaceRequired(output, /<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="${url}" />`);
  for (const [kind, name, value] of [
    ['property', 'og:title', title], ['property', 'og:description', description],
    ['property', 'og:url', url], ['name', 'twitter:title', title],
    ['name', 'twitter:description', description],
  ]) {
    output = replaceRequired(output, new RegExp(`<meta ${kind}="${name}" content="[^"]*"\\s*\\/>`), `<meta ${kind}="${name}" content="${value}" />`);
  }
  const schema = path === '/'
    ? { '@context': 'https://schema.org', '@type': 'WebSite', name: 'CargoExpress PH', alternateName: 'Cargo Express PH', url, description: page.description, inLanguage: 'en-PH' }
    : { '@context': 'https://schema.org', '@type': 'WebPage', name: page.title, url, description: page.description, inLanguage: 'en-PH' };
  output = replaceRequired(output, /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${JSON.stringify(schema)}</script>`);
  output = replaceRequired(output, /<div id="root"><\/div>/, `<div id="root">${renderFallback(page)}</div>`);
  return output;
}

mkdirSync(resolve(dist, '_seo'), { recursive: true });
for (const [path, page] of Object.entries(PUBLIC_PAGES)) {
  const destination = path === '/' ? 'index.html' : `_seo/${path.slice(1)}.html`;
  writeFileSync(resolve(dist, destination), renderPage(path, page));
  console.log(`[seo] Generated ${destination} for ${path}`);
}
