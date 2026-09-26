import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { PUBLIC_PAGES, SITE_ORIGIN, structuredDataFor } from '../src/seo/publicPages.js';
import { FAQ_ITEMS } from '../src/constants/faqContent.js';

// Business contact details come from Admin > Company Information at build
// time (read-only, public anon key, the same data the About page shows), so
// they never need copying into code. If the database cannot be reached the
// pages are still generated, just without those fields.
async function loadBusinessInfo() {
  const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env };
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn('[seo] Supabase env not set; business contact details omitted.');
    return null;
  }
  try {
    const response = await fetch(
      `${url}/rest/v1/company_information?select=name,email,facebook,smart_phone,globe_phone,manila_address,bohol_address&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    console.warn(`[seo] Company information unavailable (${error.message}); business contact details omitted.`);
    return null;
  }
}

const business = await loadBusinessInfo();

const dist = resolve('dist');
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function replaceRequired(source, pattern, replacement) {
  if (!pattern.test(source)) throw new Error(`SEO HTML template changed: ${pattern}`);
  return source.replace(pattern, replacement);
}

function renderFallback(page, path) {
  // Real, publicly visible navigation and a summary of the corresponding
  // screen. React replaces this when the app loads; it stays usable without JS.
  const links = [
    ['/', 'Home'], ['/about', 'About'], ['/schedules', 'Trip Schedules'],
    ['/track', 'Track Shipment'], ['/faq', 'Help'],
    ['/terms', 'Terms'], ['/privacy', 'Privacy'], ['/login', 'Sign In'],
  ];
  const faqs = path === '/faq' || path === '/about'
    ? `<section id="faq" aria-labelledby="faq-heading"><h2 id="faq-heading">Frequently Asked Questions</h2>`
      + FAQ_ITEMS.map(({ title, answer }) => `<article><h3>${escapeHtml(title)}</h3><p>${escapeHtml(answer)}</p></article>`).join('')
      + '</section>'
    : '';
  return `<main class="seo-fallback"><a href="/">CargoExpress PH</a>`
    + `<h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.summary)}</p>`
    + `<nav aria-label="Site pages">${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav>${faqs}</main>`;
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
  // < keeps a "<" in any string from closing the script element early.
  const schema = JSON.stringify(structuredDataFor(path, page, business)).replace(/</g, '\\u003c');
  output = replaceRequired(output, /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${schema}</script>`);
  output = replaceRequired(output, /<div id="root"><\/div>/, `<div id="root">${renderFallback(page, path)}</div>`);
  return output;
}

function renderNotFound() {
  // Vercel serves this with a real 404 status for any URL no rewrite claims,
  // instead of the homepage with a 200 (a "soft 404" search engines would
  // index as a duplicate homepage). It still boots the app, so React Router
  // renders NotFoundPage — or the right page, if a route is ever added to
  // App.jsx without a matching rewrite in vercel.json.
  let output = html;
  output = replaceRequired(output, /<title>[^<]*<\/title>/, '<title>Page Not Found — CargoExpress PH</title>');
  output = replaceRequired(output, /<meta name="description" content="[^"]*"\s*\/>/,
    '<meta name="description" content="The page you were looking for could not be found on CargoExpress PH." />');
  output = replaceRequired(output, /<meta name="robots" content="[^"]*"\s*\/>/, '<meta name="robots" content="noindex, nofollow" />');
  output = replaceRequired(output, /\s*<link rel="canonical" href="[^"]*"\s*\/>/, '');
  output = replaceRequired(output, /\s*<meta property="og:url" content="[^"]*"\s*\/>/, '');
  output = replaceRequired(output, /\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
  output = replaceRequired(output, /<div id="root"><\/div>/, `<div id="root">${renderFallback({
    heading: 'Page not found',
    summary: 'The page you were looking for does not exist or has moved.',
  })}</div>`);
  return output;
}

mkdirSync(resolve(dist, '_seo'), { recursive: true });
for (const [path, page] of Object.entries(PUBLIC_PAGES)) {
  const destination = path === '/' ? 'index.html' : `_seo/${path.slice(1)}.html`;
  writeFileSync(resolve(dist, destination), renderPage(path, page));
  console.log(`[seo] Generated ${destination} for ${path}`);
}
writeFileSync(resolve(dist, '404.html'), renderNotFound());
console.log('[seo] Generated 404.html');
