import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, ArrowUpRight, Building2, CircleHelp, Radar, Search, Truck, UserPlus,
} from 'lucide-react';

/**
 * The pieces of the 404 page: a dark hero with a tracking form and a route
 * illustration, and links to the main public pages. Styles: ./not-found.css.
 */

const SCHEDULES_PATH = '/schedules';

export const NOT_FOUND_HERO = {
  eyebrow: 'Error 404',
  heading: 'Page not found',
  summary: 'The link may be outdated, or the address may have a typo. Track a shipment below, or pick up from one of these pages.',
  actions: [
    { to: '/', label: 'Go to homepage' },
    { to: SCHEDULES_PATH, label: 'View trip schedules' },
  ],
};

const EXPLORE_LINKS = [
  { to: '/about', icon: Building2, title: 'About CargoExpress PH', text: 'Coverage areas, trip schedules, customer feedback and contact details.' },
  { to: '/faq', icon: CircleHelp, title: 'Help & shipping guidelines', text: 'Preparing cargo, restricted items, pickup, payment and delivery.' },
  { to: '/track', icon: Radar, title: 'Track a shipment', text: 'Check the latest status of a shipment with its tracking number.' },
  { to: '/register', icon: UserPlus, title: 'Create an account', text: 'Book pickups and follow every order in one place.' },
];

// The phrase in the heading that takes the brand gradient.
const ACCENT = /not found/;

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

/** Goes to /track?q=…, which TrackingPage searches on open. */
const TrackForm = ({ id = 'lp-track' }) => {
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
 * and the four shipment stages filling in. It carries no numbers or dates.
 * not-found.css hides the moving dots and stops the rest for reduced motion.
 */
const RouteArt = () => (
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

/** The dark hero panel; `actions` are { to, label, primary } links. */
export const NotFoundHero = ({ eyebrow, heading, summary, actions = [] }) => (
  <section className="lp-hero" aria-labelledby="lp-hero-title">
    <span className="lp-backdrop" aria-hidden="true">
      <span className="lp-aurora lp-aurora-1" />
      <span className="lp-aurora lp-aurora-2" />
      <span className="lp-aurora lp-aurora-3" />
      <span className="lp-grid" />
    </span>
    <div className="lp-hero-copy">
      <p className="lp-eyebrow"><span className="lp-eyebrow-dot" aria-hidden="true" />{eyebrow}</p>
      <h1 id="lp-hero-title" className="lp-hero-title">{withAccent(heading)}</h1>
      <p className="lp-hero-lede">{summary}</p>
      <TrackForm />
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

export const ExploreLinks = () => (
  <nav className="lp-explore" aria-label="Explore CargoExpress PH">
    {EXPLORE_LINKS.map(({ to, icon: Icon, title, text }) => (
      <Link key={to} to={to} className="lp-explore-link lp-reveal">
        <span className="lp-explore-icon" aria-hidden="true"><Icon size={20} /></span>
        <span className="lp-explore-text"><strong>{title}</strong><span>{text}</span></span>
        <ArrowUpRight size={18} className="lp-explore-arrow" aria-hidden="true" />
      </Link>
    ))}
  </nav>
);
