import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight, ArrowRight, ArrowUpRight, Building2, CalendarDays, Camera, Check,
  CircleHelp, Headset, MapPinned, PackagePlus, Radar, Scale, Search, Truck, UserPlus, Wallet,
} from 'lucide-react';
import { PUBLIC_PAGES } from '../../seo/publicPages';

/**
 * The public home page, split into sections that render in two places:
 * LandingPage.jsx (the live app) and src/seo/SeoPage.jsx (the HTML the build
 * writes for crawlers and visitors without JavaScript). Everything here must
 * render on the server — no window, document or effects — and must work as
 * plain HTML: links are real hrefs and the tracking form is a GET form, so
 * both still go somewhere before React loads.
 *
 * Styles: ./landing.css (bundled with LandingPage and inlined into the
 * generated pages).
 */

export const SCHEDULES_PATH = '/about#trip-schedules';

// Every statement below describes how the service works today; keep it that
// way. No figures, ratings or promises the business has not made.
const HOW_IT_WORKS = [
  { icon: CalendarDays, title: 'Check the trip schedule', text: 'See when the next trip between Manila and Bohol leaves.' },
  { icon: PackagePlus, title: 'Book a pickup', text: 'Enter the sender and receiver details. Your cargo is collected from the pickup address.' },
  { icon: Scale, title: 'Weighed at pickup', text: 'The price is based on the actual weight measured at pickup, not an estimate.' },
  { icon: MapPinned, title: 'Pay and track', text: 'Pay by GCash or cash, or let the receiver pay. Follow your shipment with its tracking number.' },
];

const EXPLORE_LINKS = [
  { to: '/about', icon: Building2, title: 'About CargoExpress PH', text: 'Coverage areas, trip schedules, customer feedback and contact details.' },
  { to: '/faq', icon: CircleHelp, title: 'Help & shipping guidelines', text: 'Preparing cargo, restricted items, pickup, payment and delivery.' },
  { to: '/track', icon: Radar, title: 'Track a shipment', text: 'Check the latest status of a shipment with its tracking number.' },
  { to: '/register', icon: UserPlus, title: 'Create an account', text: 'Book pickups and follow every order in one place.' },
];

// The phrase in each heading that takes the brand gradient.
const ACCENT = /Manila(?:\s+and\s+|–)Bohol|CargoExpress PH|shipment|not found/;

const withAccent = (text) => {
  const match = text.match(ACCENT);
  if (!match) return text;
  const end = match.index + match[0].length;
  return (
    <>
      {text.slice(0, match.index)}
      <span className="lp-accent">{match[0]}</span>
      {text.slice(end)}
    </>
  );
};

export const RouteLabel = () => (
  <>Manila <ArrowLeftRight size={14} strokeWidth={2.4} aria-hidden="true" /><span className="lp-sr-only">and</span> Bohol</>
);

/**
 * Goes to /track?q=…, which TrackingPage searches on open. As plain HTML the
 * same GET form lands on the same URL.
 */
export const TrackForm = ({ id = 'lp-track' }) => {
  const navigate = useNavigate();
  const [value, setValue] = useState('');

  const submit = (event) => {
    event.preventDefault();
    const trackingNumber = value.trim().toUpperCase();
    navigate(trackingNumber ? `/track?q=${encodeURIComponent(trackingNumber)}` : '/track');
  };

  return (
    <form className="lp-track" action="/track" method="get" role="search" onSubmit={submit}>
      <label className="lp-track-label" htmlFor={`${id}-input`}>Track a shipment</label>
      <div className="lp-track-field">
        <Search size={18} className="lp-track-icon" aria-hidden="true" />
        <input
          id={`${id}-input`}
          name="q"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value.toUpperCase())}
          placeholder="Enter tracking number"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck="false"
          aria-describedby={`${id}-hint`}
        />
        <button type="submit" className="lp-track-submit">
          Track <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      <p id={`${id}-hint`} className="lp-track-hint">Tracking numbers start with CE-. No account needed.</p>
    </form>
  );
};

// The Manila–Bohol arch the route illustration is drawn on.
const ARC = 'M60 150C122 34 278 34 340 150';
// A wave line with a 40-unit period, so shifting it 40 units loops seamlessly.
const WAVE = (y) => `M-40 ${y}${' q10 -4 20 0 t20 0'.repeat(12)}`;
const STAGES = ['Booked', 'Picked up', 'In transit', 'Delivered'];

/**
 * Decorative: the two hubs, an arch between them with cargo moving both ways,
 * and the four shipment stages filling in. It shows how the service works,
 * not a real shipment, so it carries no numbers or dates. The moving dots use
 * SVG animation so they also move in the no-JavaScript page; landing.css
 * hides them and stops everything else for reduced motion.
 */
export const RouteArt = () => (
  <div className="lp-art" aria-hidden="true">
    <div className="lp-art-head">
      <span className="lp-art-chip"><Truck size={14} /> Door-to-door</span>
      <span className="lp-art-live"><i /> Trips both ways</span>
    </div>
    <svg className="lp-art-map" viewBox="0 0 400 214" focusable="false">
      <defs>
        <linearGradient id="lp-art-arc" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="0.55" stopColor="#6ee7b7" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
        <radialGradient id="lp-art-halo-out">
          <stop offset="0" stopColor="#6ee7b7" stopOpacity="0.85" />
          <stop offset="1" stopColor="#6ee7b7" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lp-art-halo-back">
          <stop offset="0" stopColor="#67e8f9" stopOpacity="0.8" />
          <stop offset="1" stopColor="#67e8f9" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lp-art-pad">
          <stop offset="0" stopColor="#10b981" stopOpacity="0.4" />
          <stop offset="1" stopColor="#10b981" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g fill="none" strokeLinecap="round">
        <path className="lp-art-waves" d={WAVE(200)} stroke="rgba(167, 243, 208, 0.13)" strokeWidth="1.25" />
        <path className="lp-art-waves lp-art-waves-back" d={WAVE(209)} stroke="rgba(103, 232, 249, 0.09)" strokeWidth="1.25" />
      </g>

      <ellipse cx="60" cy="152" rx="52" ry="13" fill="url(#lp-art-pad)" />
      <ellipse cx="340" cy="152" rx="52" ry="13" fill="url(#lp-art-pad)" />

      <path d={ARC} fill="none" stroke="rgba(255, 255, 255, 0.16)" strokeWidth="1.5" strokeDasharray="1 7" strokeLinecap="round" />
      <path className="lp-art-arc" d={ARC} pathLength="100" fill="none" stroke="url(#lp-art-arc)" strokeWidth="9" strokeLinecap="round" opacity="0.14" />
      <path className="lp-art-arc" d={ARC} pathLength="100" fill="none" stroke="url(#lp-art-arc)" strokeWidth="2.5" strokeLinecap="round" />

      <g className="lp-art-mover">
        <circle r="16" fill="url(#lp-art-halo-out)" />
        <circle r="5" fill="#ecfdf5" stroke="#10b981" strokeWidth="2" />
        <animateMotion dur="6s" repeatCount="indefinite" path={ARC} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.55 1" />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur="6s" repeatCount="indefinite" />
      </g>
      <g className="lp-art-mover">
        <circle r="14" fill="url(#lp-art-halo-back)" />
        <circle r="4.5" fill="#ecfeff" stroke="#06b6d4" strokeWidth="2" />
        <animateMotion dur="6s" begin="-3s" repeatCount="indefinite" path={ARC} keyPoints="1;0" keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.55 1" />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur="6s" begin="-3s" repeatCount="indefinite" />
      </g>

      {[['Manila', 'Luzon', 60, ''], ['Bohol', 'Central Visayas', 340, ' lp-art-pulse-late']].map(([city, region, x, late]) => (
        <g key={city} transform={`translate(${x} 150)`}>
          <circle className={`lp-art-pulse${late}`} r="9" fill="none" stroke="#34d399" strokeWidth="1.5" />
          <circle r="9" fill="#04241b" stroke="#34d399" strokeWidth="2" />
          <circle r="3.5" fill="#a7f3d0" />
          <text className="lp-art-city" y="31" textAnchor="middle">{city.toUpperCase()}</text>
          <text className="lp-art-region" y="46" textAnchor="middle">{region}</text>
        </g>
      ))}
    </svg>
    <ol className="lp-art-stages">
      {STAGES.map((stage) => <li key={stage}>{stage}</li>)}
    </ol>
  </div>
);

/**
 * The dark hero panel. `actions` are { to, label, primary } links; `track`
 * adds the tracking form above them.
 */
export const LandingHero = ({ eyebrow, heading, summary, track = false, actions = [] }) => (
  <section className="lp-hero" aria-labelledby="lp-hero-title">
    <HeroBackdrop />
    <div className="lp-hero-copy">
      <p className="lp-eyebrow"><span className="lp-eyebrow-dot" aria-hidden="true" />{eyebrow}</p>
      <h1 id="lp-hero-title" className="lp-hero-title">{withAccent(heading)}</h1>
      <p className="lp-hero-lede">{summary}</p>
      {track && <TrackForm />}
      {actions.length > 0 && (
        <div className="lp-actions">
          {actions.map(({ to, label, primary }) => (
            <Link key={to} to={to} className={`lp-btn ${primary ? 'lp-btn-primary' : 'lp-btn-glass'}`}>
              {label} <ArrowRight size={16} aria-hidden="true" />
            </Link>
          ))}
        </div>
      )}
    </div>
    <div className="lp-hero-visual">
      <RouteArt />
    </div>
  </section>
);

const HeroBackdrop = () => (
  <span className="lp-backdrop" aria-hidden="true">
    <span className="lp-aurora lp-aurora-1" />
    <span className="lp-aurora lp-aurora-2" />
    <span className="lp-aurora lp-aurora-3" />
    <span className="lp-grid" />
  </span>
);

const SectionHead = ({ id, kicker, title, children }) => (
  <div className="lp-section-head">
    <p className="lp-kicker">{kicker}</p>
    <h2 id={id}>{title}</h2>
    {children && <p>{children}</p>}
  </div>
);

export const HowItWorks = () => (
  <section className="lp-section" aria-labelledby="lp-steps-title">
    <SectionHead id="lp-steps-title" kicker="How it works" title="From your door to theirs, in four steps">
      Book online, and your cargo is collected, weighed, shipped and delivered.
    </SectionHead>
    <ol className="lp-steps" role="list">
      {HOW_IT_WORKS.map(({ icon: Icon, title, text }, index) => (
        <li key={title} className="lp-step lp-reveal">
          <span className="lp-step-icon" aria-hidden="true"><Icon size={21} /></span>
          <span className="lp-step-num">Step {String(index + 1).padStart(2, '0')}</span>
          <h3>{title}</h3>
          <p>{text}</p>
        </li>
      ))}
    </ol>
  </section>
);

export const ServiceFeatures = () => (
  <section className="lp-section" aria-labelledby="lp-features-title">
    <SectionHead id="lp-features-title" kicker="Why CargoExpress PH" title="Cargo service built around the Manila–Bohol route">
      From pickup at your address to proof of delivery at theirs.
    </SectionHead>
    <div className="lp-bento">
      <article className="lp-card lp-card-feature lp-reveal">
        <span className="lp-card-icon" aria-hidden="true"><Truck size={22} /></span>
        <h3>Door-to-door, both directions</h3>
        <p>Your cargo is collected from the pickup address and delivered to the receiver, on trips from Manila to Bohol and from Bohol to Manila.</p>
        <div className="lp-lanes" aria-hidden="true">
          <span className="lp-lane"><b>Manila</b><i /><ArrowRight size={16} /><b>Bohol</b></span>
          <span className="lp-lane lp-lane-back"><b>Bohol</b><i /><ArrowRight size={16} /><b>Manila</b></span>
        </div>
      </article>

      <article className="lp-card lp-reveal">
        <span className="lp-card-icon" aria-hidden="true"><Scale size={22} /></span>
        <h3>Priced by actual weight</h3>
        <p>Cargo is weighed at pickup, so the price is based on its measured weight, not an estimate.</p>
        <span className="lp-card-tag"><Check size={14} aria-hidden="true" /> Measured at pickup</span>
      </article>

      <article className="lp-card lp-reveal">
        <span className="lp-card-icon" aria-hidden="true"><Wallet size={22} /></span>
        <h3>Pay your way</h3>
        <p>Pay by GCash or cash, or let the receiver pay.</p>
        <span className="lp-chips"><span>GCash</span><span>Cash</span><span>Receiver pays</span></span>
      </article>

      <article className="lp-card lp-reveal">
        <span className="lp-card-icon" aria-hidden="true"><Radar size={22} /></span>
        <h3>Track without an account</h3>
        <p>Anyone with the tracking number can check the latest status of a shipment.</p>
        <span className="lp-mock-field" aria-hidden="true"><Search size={15} />CE-<i /></span>
      </article>

      <article className="lp-card lp-reveal">
        <span className="lp-card-icon" aria-hidden="true"><Camera size={22} /></span>
        <h3>Photo proof, both ends</h3>
        <p>Pickup and delivery photos are kept with the order as proof of delivery.</p>
        <span className="lp-frames" aria-hidden="true">
          <span><Camera size={16} />Pickup</span>
          <span><Camera size={16} />Delivery</span>
        </span>
      </article>

      <article className="lp-card lp-card-wide lp-reveal">
        <span className="lp-card-icon" aria-hidden="true"><Headset size={22} /></span>
        <div className="lp-card-body">
          <h3>People you can reach</h3>
          <p>Call, email or use the contact form, no account needed. Signed-in customers can also chat with support.</p>
        </div>
        <Link to="/about#contact" className="lp-card-link">
          Contact us <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </article>
    </div>
  </section>
);

export const ExploreLinks = ({ exclude }) => (
  <nav className="lp-explore" aria-label="Explore CargoExpress PH">
    {EXPLORE_LINKS.filter(({ to }) => to !== exclude).map(({ to, icon: Icon, title, text }) => (
      <Link key={to} to={to} className="lp-explore-link lp-reveal">
        <span className="lp-explore-icon" aria-hidden="true"><Icon size={20} /></span>
        <span className="lp-explore-text"><strong>{title}</strong><span>{text}</span></span>
        <ArrowUpRight size={18} className="lp-explore-arrow" aria-hidden="true" />
      </Link>
    ))}
  </nav>
);

export const ClosingCta = () => (
  <section className="lp-cta lp-reveal" aria-labelledby="lp-cta-title">
    <HeroBackdrop />
    <p className="lp-eyebrow"><span className="lp-eyebrow-dot" aria-hidden="true" /><RouteLabel /></p>
    <h2 id="lp-cta-title">Ready to send cargo between Manila and Bohol?</h2>
    <p>Create an account to book a pickup, or check when the next trip leaves.</p>
    <div className="lp-actions">
      <Link to="/register" className="lp-btn lp-btn-primary">Create an account <ArrowRight size={16} aria-hidden="true" /></Link>
      <Link to={SCHEDULES_PATH} className="lp-btn lp-btn-glass">View trip schedules <ArrowRight size={16} aria-hidden="true" /></Link>
    </div>
  </section>
);

// The 404 page, live (NotFoundPage.jsx) and generated (dist/404.html).
export const NOT_FOUND_HERO = {
  eyebrow: 'Error 404',
  heading: 'Page not found',
  summary: 'The link may be outdated, or the address may have a typo. Track a shipment below, or pick up from one of these pages.',
  track: true,
  actions: [
    { to: '/', label: 'Go to homepage' },
    { to: SCHEDULES_PATH, label: 'View trip schedules' },
  ],
};

const HOME = PUBLIC_PAGES['/'];

/** The whole home page body, shared by the live page and the generated one. */
export const LandingContent = () => (
  <>
    <LandingHero
      eyebrow={<><RouteLabel /> · Door-to-door cargo</>}
      heading={HOME.heading}
      summary={HOME.summary}
      track
      actions={[
        { to: SCHEDULES_PATH, label: 'View trip schedules', primary: false },
        { to: '/register', label: 'Create an account', primary: false },
      ]}
    />
    <HowItWorks />
    <ServiceFeatures />
    <ExploreLinks exclude="/track" />
    <ClosingCta />
  </>
);
