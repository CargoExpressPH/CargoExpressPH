import { Link } from 'react-router-dom';
import usePageTitle from '../../hooks/usePageTitle';
import { PUBLIC_PAGES } from '../../seo/publicPages';
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

const LandingPage = () => {
  usePageTitle();

  return (
    <div className="public-landing">
      <section className="public-landing-hero" aria-labelledby="public-landing-title">
        <p className="public-landing-eyebrow">CargoExpress PH</p>
        <h1 id="public-landing-title">{heading}</h1>
        <p>{summary}</p>
        <div className="public-landing-actions">
          <Link className="btn btn-primary" to="/about#trip-schedules">View Trip Schedules</Link>
          <Link className="btn btn-outline" to="/track">Track a Shipment</Link>
        </div>
      </section>

      <section className="public-landing-steps" aria-labelledby="public-landing-steps-title">
        <h2 id="public-landing-steps-title">How it works</h2>
        <ol role="list">
          {STEPS.map(([title, text]) => (
            <li key={title}><strong>{title}</strong><span>{text}</span></li>
          ))}
        </ol>
      </section>

      <section className="public-landing-links" aria-label="Explore CargoExpress PH">
        <Link to="/about"><strong>About the service</strong><span>Learn about the company, its coverage, and how to get in touch.</span></Link>
        <Link to="/faq"><strong>Help & Guidelines</strong><span>Read the answers to common booking and delivery questions.</span></Link>
        <Link to="/register"><strong>Get started</strong><span>Create a customer account to arrange a shipment.</span></Link>
      </section>
    </div>
  );
};

export default LandingPage;
