import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Search } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { getTrips } from '../../lib/database';
import { PUBLIC_PAGES } from '../../seo/publicPages';
import { formatMoney } from '../../utils/currencyInput';
import { formatPhDate } from '../../utils/datetime';
import './landing.css';

// Same heading and summary the build writes into the crawlable HTML, so the
// page a search engine reads is the page a visitor sees.
const { heading, summary } = PUBLIC_PAGES['/'];

const STEPS = [
  ['Check the trip schedule', 'See when the next trip between Manila and Bohol leaves.'],
  ['Book a pickup', 'Enter the sender and receiver details. Your cargo is collected from the pickup address.'],
  ['Weighed at pickup', 'The price is based on the actual weight measured at pickup, not an estimate.'],
  ['Pay and track', 'Pay by GCash or cash, or let the receiver pay. Follow your shipment with its tracking number.'],
];

const PAGES = [
  ['/schedules', 'Trip schedules', 'Every upcoming departure, with space left and the rate per kilo.'],
  ['/faq', 'Help & guidelines', 'How to pack, what cannot be shipped, pickup and delivery.'],
  ['/about', 'About CargoExpress PH', 'Coverage areas, customer feedback and how to reach us.'],
];

const BOARD_ROWS = 4;

/** Goes to /track?q=…, which TrackingPage searches on open. */
const TrackForm = () => {
  const navigate = useNavigate();
  const [value, setValue] = useState('');

  const submit = (event) => {
    event.preventDefault();
    const trackingNumber = value.trim().toUpperCase();
    navigate(trackingNumber ? `/track?q=${encodeURIComponent(trackingNumber)}` : '/track');
  };

  return (
    <form className="lx-track" action="/track" method="get" role="search" onSubmit={submit}>
      <label className="lx-track-label" htmlFor="lx-track-input">Track a shipment</label>
      <div className="lx-track-field">
        <Search size={18} className="lx-track-icon" aria-hidden="true" />
        <input
          id="lx-track-input"
          name="q"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value.toUpperCase())}
          placeholder="CE-"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck="false"
          aria-describedby="lx-track-hint"
        />
        <button type="submit" className="lx-track-submit">Track</button>
      </div>
      <p id="lx-track-hint" className="lx-track-hint">Enter the tracking number from your booking. No account needed.</p>
    </form>
  );
};

/**
 * The next few open trips, read live from the same query as /schedules. If
 * the trips cannot be loaded the board says so and points to the schedules
 * page rather than showing an empty frame.
 */
const DeparturesBoard = () => {
  const [trips, setTrips] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    getTrips('active')
      .then((data) => { if (mounted) setTrips((data || []).slice(0, BOARD_ROWS)); })
      .catch(() => { if (mounted) setFailed(true); });
    return () => { mounted = false; };
  }, []);

  let body;
  if (failed) {
    body = <p className="lx-board-note">Trips could not be loaded right now.</p>;
  } else if (!trips) {
    body = (
      <ul className="lx-board-rows" aria-busy="true" aria-label="Loading trips">
        {Array.from({ length: 3 }, (_, index) => <li key={index} className="lx-board-skeleton" />)}
      </ul>
    );
  } else if (trips.length === 0) {
    body = <p className="lx-board-note">No trips are open for booking right now. New trips are added regularly.</p>;
  } else {
    body = (
      <ul className="lx-board-rows">
        {trips.map((trip) => (
          <li key={trip.id}>
            <span className="lx-board-date">
              <strong>{formatPhDate(trip.departure_date, { month: 'short', day: 'numeric', year: undefined })}</strong>
              <span>{formatPhDate(trip.departure_date, { weekday: 'short', month: undefined, day: undefined, year: undefined })}</span>
            </span>
            <span className="lx-board-route">
              {trip.origin} <ArrowRight size={13} aria-hidden="true" /><span className="sr-only">to</span> {trip.destination}
              <span className="lx-board-trip">{trip.trip_number}</span>
            </span>
            <span className="lx-board-rate">{formatMoney(parseFloat(trip.price_per_kg || 70))}<span>/kg</span></span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="lx-board" aria-labelledby="lx-board-title">
      <header>
        <h2 id="lx-board-title">Next departures</h2>
        <span>Open for booking</span>
      </header>
      {body}
      <Link to="/schedules" className="lx-board-all">
        See all trip schedules <ArrowRight size={15} aria-hidden="true" />
      </Link>
    </section>
  );
};

const LandingPage = () => {
  usePageTitle();

  return (
    <div className="lx">
      <section className="lx-hero" aria-labelledby="lx-hero-title">
        <picture className="lx-hero-photo" aria-hidden="true">
          <source media="(max-width: 700px)" srcSet="/images/landing-hero-sm.webp" type="image/webp" />
          <img src="/images/landing-hero.webp" alt="" width="1376" height="768" fetchPriority="high" decoding="async" />
        </picture>
        <div className="lx-hero-inner">
          <div className="lx-hero-copy">
            <p className="lx-route-line">Manila <span aria-hidden="true">⇄</span><span className="sr-only">and</span> Bohol</p>
            <h1 id="lx-hero-title">{heading}</h1>
            <p className="lx-lede">{summary}</p>
            <TrackForm />
          </div>
          <DeparturesBoard />
        </div>
      </section>

      <section className="lx-section" aria-labelledby="lx-steps-title">
        <div className="lx-section-head">
          <h2 id="lx-steps-title">How shipping works</h2>
          <Link to="/register" className="lx-text-link">Create an account to book <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        <ol className="lx-steps">
          {STEPS.map(([title, text], index) => (
            <li key={title}>
              <span className="lx-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <strong>{title}</strong>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lx-section lx-more" aria-labelledby="lx-more-title">
        <h2 id="lx-more-title">Before you book</h2>
        <ul className="lx-pages">
          {PAGES.map(([to, title, text]) => (
            <li key={to}>
              <Link to={to}>
                <span><strong>{title}</strong><span>{text}</span></span>
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="lx-cta" aria-labelledby="lx-cta-title">
        <div>
          <h2 id="lx-cta-title">Ready to send cargo?</h2>
          <p>Create an account to book a pickup and follow every order in one place.</p>
        </div>
        <div className="lx-cta-actions">
          <Link to="/register" className="lx-btn lx-btn-primary">Create an account</Link>
          <Link to="/login" className="lx-btn lx-btn-secondary">Log in</Link>
        </div>
      </section>
    </div>
  );
};

export default LandingPage;
