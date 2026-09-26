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

// The pages every crawlable page links to, with the line shown on its card.
const PAGE_CARDS = [
  ['/schedules', 'Trip schedules', 'Upcoming departures between Manila and Bohol.'],
  ['/track', 'Track a shipment', 'The latest status of your cargo, no account needed.'],
  ['/faq', 'Help & guidelines', 'Preparing cargo, restricted items, pickup and delivery.'],
  ['/about', 'About us', 'Coverage areas, customer feedback and contact details.'],
];

const LOGO = '<img src="/images/logo-nav.png" width="36" height="36" alt="" />';

function renderFallback(page, path) {
  // A real, styled page: header, the screen's heading and summary, links to
  // the other public pages and a footer. React replaces it when the app
  // loads; it stays usable without JS. The styles live in index.html.
  // `.seo-boot` is the loading splash shown instead while the app starts.
  const nav = [['/', 'Home'], ...PAGE_CARDS.map(([href, label]) => [href, label])]
    .map(([href, label]) => `<a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const cards = PAGE_CARDS.filter(([href]) => href !== path)
    .map(([href, label, text]) => `<a href="${href}"><strong>${label}</strong><span>${text}</span></a>`).join('');
  const faqs = path === '/faq' || path === '/about'
    ? `<section class="seo-faq" id="faq" aria-labelledby="faq-heading"><h2 id="faq-heading">Frequently Asked Questions</h2>`
      + FAQ_ITEMS.map(({ title, answer }) => `<article><h3>${escapeHtml(title)}</h3><p>${escapeHtml(answer)}</p></article>`).join('')
      + '</section>'
    : '';
  return `<div class="seo-boot" aria-hidden="true"><img src="/images/logo-nav.png" width="64" height="64" alt="" />`
    + `<span>CARGOEXPRESS <b>PH</b></span><i></i></div>`
    + `<main class="seo-fallback">`
    + `<header class="seo-top"><a class="seo-brand" href="/">${LOGO}<span>CargoExpress PH</span></a>`
    + `<nav aria-label="Site pages">${nav}</nav>`
    + `<a class="seo-signin" href="/login">Log in</a></header>`
    + `<section class="seo-hero"><p class="seo-eyebrow">Manila ⇄ Bohol</p>`
    + `<h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.summary)}</p>`
    + `<div class="seo-actions"><a class="seo-btn" href="/track">Track a shipment</a>`
    + `<a class="seo-btn seo-btn-ghost" href="/register">Create an account</a></div></section>`
    + `<nav class="seo-cards" aria-label="Explore CargoExpress PH">${cards}</nav>${faqs}`
    + `<footer class="seo-foot"><span>© CargoExpress PH · Door-to-door cargo between Manila and Bohol</span>`
    + `<span><a href="/terms">Terms</a><a href="/privacy">Privacy</a></span></footer></main>`;
}

function renderPage(path, page) {
  const url = `${SITE_ORIGIN}${path === '/' ? '/' : path}`;
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  let output = html;
  output = replaceRequired(output, /<title>[^<]*<\/title>/, `<title>${title}</title>`);
  output = replaceRequired(output, /<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${description}" />`);
  output = replaceRequired(output, /<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="${url}" />`);
  // The home hero is the largest above-the-fold element. Start its request
  // while the app loads; only preload the size selected by this viewport.
  // Other public pages do not use this image and must not download it early.
  if (path === '/') {
    output = output.replace(`<link rel="canonical" href="${url}" />`,
      `<link rel="canonical" href="${url}" />\n    <link rel="preload" as="image" href="/images/landing-hero-sm.webp" media="(max-width: 700px)" fetchpriority="high" />\n    <link rel="preload" as="image" href="/images/landing-hero.webp" media="(min-width: 701px)" fetchpriority="high" />`);
  }
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
