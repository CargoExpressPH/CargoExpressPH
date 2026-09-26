import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import BootSplash from '../components/ui/BootSplash';
import {
  ClosingCta, ExploreLinks, HowItWorks, LandingContent, LandingHero, NOT_FOUND_HERO, RouteLabel, SCHEDULES_PATH,
  ServiceFeatures,
} from '../pages/public/LandingSections';
import { FAQ_ITEMS } from '../constants/faqContent';

/**
 * The HTML scripts/generate-seo-pages.mjs writes into #root of each public
 * page, rendered at build time from the same components as the live app:
 *
 *   .seo-boot      BootSplash, shown while the app starts (index.html adds
 *                  `app-booting` to <html>; React replaces all of #root when
 *                  it mounts)
 *   .seo-fallback  the readable page, for crawlers, visitors without
 *                  JavaScript, and anyone whose bundle fails to load (the
 *                  splash gives way to it after 8 seconds)
 *
 * The home page body is LandingContent itself, so what a search engine reads
 * at "/" is what a visitor sees there. Build-only: nothing in the app imports
 * this file. Styles: seo-page.css plus the landing and splash stylesheets,
 * all inlined by the build.
 */

const NAV = [
  ['/', 'Home'], ['/about', 'About'], ['/schedules', 'Trip Schedules'],
  ['/track', 'Track Shipment'], ['/faq', 'Help'],
];

const LEGAL = [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']];

const schedules = { to: SCHEDULES_PATH, label: 'View trip schedules' };
const register = { to: '/register', label: 'Create an account' };
const track = { to: '/track', label: 'Track a shipment' };
const contact = { to: '/about#contact', label: 'Contact us' };
const home = { to: '/', label: 'Back to home' };

// What each page's hero offers besides its heading and summary. The body of
// each page follows in PAGE_BODY.
const PAGE_HERO = {
  '/about': { eyebrow: 'About us', actions: [{ ...schedules, primary: true }, contact] },
  '/track': { eyebrow: 'Shipment tracking', track: true, actions: [schedules] },
  '/schedules': { eyebrow: 'Trip schedules', actions: [{ ...register, primary: true }, track] },
  '/faq': { eyebrow: 'Help center', actions: [{ ...track, primary: true }, contact] },
  '/terms': { eyebrow: 'Legal', actions: [{ to: '/privacy', label: 'Privacy Policy', primary: true }, home] },
  '/privacy': { eyebrow: 'Legal', actions: [{ to: '/terms', label: 'Terms of Service', primary: true }, home] },
};

const PAGE_BODY = {
  '/about': [HowItWorks, ServiceFeatures, FaqSection],
  '/schedules': [HowItWorks],
  '/faq': [FaqSection],
};

function FaqSection() {
  return (
    <section id="faq" className="lp-section seo-faq" aria-labelledby="faq-heading">
      <div className="lp-section-head">
        <p className="lp-kicker">FAQ</p>
        <h2 id="faq-heading">Frequently Asked Questions</h2>
      </div>
      <div className="seo-faq-list">
        {FAQ_ITEMS.map(({ id, title, answer, category }, index) => (
          <details key={id} className="seo-faq-item" open={index === 0}>
            <summary>
              <span className="seo-faq-category">{category}</span>
              <h3>{title}</h3>
              <span className="seo-faq-toggle" aria-hidden="true" />
            </summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

const Wordmark = () => (
  <span className="seo-wordmark">CARGOEXPRESS <span>PH</span></span>
);

const SeoHeader = ({ path }) => (
  <header className="seo-top">
    <a href="/" className="seo-brand" aria-label="CargoExpress PH home">
      <img src="/images/logo-nav.png" alt="" width="34" height="34" />
      <Wordmark />
    </a>
    <nav className="seo-nav" aria-label="Site pages">
      {NAV.map(([href, label]) => (
        <a key={href} href={href} aria-current={href === path ? 'page' : undefined}>{label}</a>
      ))}
    </nav>
    <a href="/login" className="seo-signin">Sign In</a>
  </header>
);

// Contact details come from Admin > Company Information at build time, the
// same row the structured data uses; each line is left out when empty.
const SeoFooter = ({ business }) => {
  const text = (value) => String(value ?? '').trim();
  const phones = [business?.smart_phone, business?.globe_phone].map(text).filter(Boolean);
  const hubs = [['Manila hub', business?.manila_address], ['Bohol hub', business?.bohol_address]]
    .map(([label, address]) => [label, text(address)])
    .filter(([, address]) => address);
  const email = text(business?.email);

  return (
    <footer className="seo-foot">
      <div className="seo-foot-grid">
        <div className="seo-foot-brand">
          <a href="/" className="seo-brand" aria-label="CargoExpress PH home">
            <img src="/images/logo-nav.png" alt="" width="34" height="34" />
            <Wordmark />
          </a>
          <p>Door-to-door cargo between Manila and Bohol: trip schedules, pickup booking and shipment tracking.</p>
          <p className="seo-foot-route"><RouteLabel /></p>
        </div>
        <nav className="seo-foot-col" aria-label="Pages">
          <h2>Pages</h2>
          {NAV.slice(1).map(([href, label]) => <a key={href} href={href}>{label}</a>)}
        </nav>
        <nav className="seo-foot-col" aria-label="Account">
          <h2>Account</h2>
          <a href="/login">Sign In</a>
          <a href="/register">Create an account</a>
          {LEGAL.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
        </nav>
        {(hubs.length > 0 || phones.length > 0 || email) && (
          <div className="seo-foot-col">
            <h2>Contact</h2>
            <address>
              {hubs.map(([label, address]) => <span key={label}><b>{label}:</b> {address}</span>)}
              {phones.map((phone) => <a key={phone} href={`tel:${phone.replace(/[^\d+]/g, '')}`}>{phone}</a>)}
              {email && <a href={`mailto:${email}`}>{email}</a>}
            </address>
          </div>
        )}
      </div>
      <p className="seo-foot-legal">© {new Date().getFullYear()} CargoExpress PH. All rights reserved.</p>
    </footer>
  );
};

const SeoPage = ({ path, page, business }) => {
  const Body = PAGE_BODY[path] || [];
  return (
    <>
      <BootSplash className="seo-boot" />
      <main className="seo-fallback">
        <div className="lp-theme seo-page">
          <SeoHeader path={path} />
          <div className="lp seo-body">
            {path === '/' ? <LandingContent /> : (
              <>
                <LandingHero {...(path ? { heading: page.heading, summary: page.summary, ...PAGE_HERO[path] } : NOT_FOUND_HERO)} />
                {Body.map((Section, index) => <Section key={index} />)}
                <ExploreLinks exclude={path} />
                {path && <ClosingCta />}
              </>
            )}
          </div>
          <SeoFooter business={business} />
        </div>
      </main>
    </>
  );
};

/** Markup for #root of one generated page; `path` and `page` are null for the 404 page. */
export function renderSeoPage({ path, page, business }) {
  return renderToStaticMarkup(
    <StaticRouter location={path || '/404'}>
      <SeoPage path={path} page={page} business={business} />
    </StaticRouter>,
  );
}
