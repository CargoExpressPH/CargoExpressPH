import { Link } from 'react-router-dom';
import usePageTitle from '../../hooks/usePageTitle';
import './landing.css';

const LandingPage = () => {
  usePageTitle();

  return (
    <div className="public-landing">
      <section className="public-landing-hero" aria-labelledby="public-landing-title">
        <p className="public-landing-eyebrow">CargoExpress PH</p>
        <h1 id="public-landing-title">Book and track cargo in one place</h1>
        <p>Check upcoming trips, arrange a cargo booking, and follow your shipment using its tracking number.</p>
        <div className="public-landing-actions">
          <Link className="btn btn-primary" to="/schedules">View Trip Schedules</Link>
          <Link className="btn btn-outline" to="/track">Track a Shipment</Link>
        </div>
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
