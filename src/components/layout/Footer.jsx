import { Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { BrandLogo } from '../ui/BrandLogo';
import { getGoogleMapsSearchUrl } from '../../utils/googleMaps';

/**
 * The site's one public footer — used on the About page and on the public
 * shell that wraps guest-accessible pages like /schedules and /faq (see
 * PublicShell.jsx). Every link here is a real route, not an in-page anchor:
 * this footer renders on more than one page now, so "scroll to a section on
 * this page" doesn't generalize — About-page sections are linked as
 * /about#section instead, which still lands on the right place from
 * anywhere, just without the smooth-scroll animation About page's own
 * in-page links use.
 *
 * `systemStatus`/`systemStatusLabel` are optional: only AboutPage currently
 * computes a live status (it already polls connectivity/API health as part
 * of its own data load), so the indicator only renders when a caller
 * supplies both.
 */
const Footer = ({ companyName, info, systemStatus, systemStatusLabel }) => {
  const name = companyName || 'CargoExpress PH';

  return (
    <footer className="about-footer">
      <div className="about-footer-grid">
        {/* Brand + hubs */}
        <div>
          <div className="about-footer-brand">
            <BrandLogo size={34} decorative />
            <h3>{name}</h3>
          </div>
          <p className="about-footer-desc">
            {info?.short_description || 'Reliable logistics and cargo delivery services across the Philippines.'}
          </p>
          {(info?.manila_address || info?.bohol_address) && (
            <div className="about-footer-hubs">
              {info?.manila_address && (
                <a
                  href={getGoogleMapsSearchUrl(info.manila_address)}
                  className="about-footer-hub"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open Manila Hub in Google Maps: ${info.manila_address}`}
                >
                  <strong>Manila Hub:</strong> {info.manila_address}
                </a>
              )}
              {info?.bohol_address && (
                <a
                  href={getGoogleMapsSearchUrl(info.bohol_address)}
                  className="about-footer-hub"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open Bohol Hub in Google Maps: ${info.bohol_address}`}
                >
                  <strong>Bohol Hub:</strong> {info.bohol_address}
                </a>
              )}
            </div>
          )}
          <div className="about-footer-social">
            {info?.facebook && (
              <a href={info.facebook} target="_blank" rel="noreferrer" className="about-social-btn" title="Facebook">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
              </a>
            )}

            {info?.email && (
              <a href={`mailto:${info.email}`} className="about-social-btn" title="Email">
                <Mail size={18} />
              </a>
            )}
          </div>
        </div>

        {/* Quick Links */}
        <div>
          <h4 className="about-footer-heading">Quick Links</h4>
          <div className="about-footer-links">
            <Link to="/track" className="about-footer-link">Track Your Cargo</Link>
            <Link to="/schedules" className="about-footer-link">View Trip Schedules</Link>
            <Link to="/customer/book" className="about-footer-link">Book a Cargo</Link>
            <Link to="/about#faq" className="about-footer-link">FAQs</Link>
          </div>
        </div>

        {/* Company */}
        <div>
          <h4 className="about-footer-heading">Company</h4>
          <div className="about-footer-links">
            <Link to="/about" className="about-footer-link">About Us</Link>
            <Link to="/about#coverage" className="about-footer-link">Coverage Areas</Link>
            <Link to="/about#contact" className="about-footer-link">Contact Us</Link>
          </div>
        </div>
      </div>

      <div className="about-footer-bottom">
        <span>&copy; {new Date().getFullYear()} {name}. All rights reserved.</span>
        <span className="about-footer-legal-links" aria-label="Legal information">
          <Link to="/terms" className="about-footer-link">Terms of Service</Link>
          <Link to="/privacy" className="about-footer-link">Privacy Policy</Link>
        </span>
        {systemStatus && systemStatusLabel && (
          <span
            className={`about-footer-status about-footer-status-${systemStatus}`}
            role="status"
            aria-live="polite"
            aria-label={`Service status: ${systemStatusLabel}`}
          >
            <span className="about-footer-status-dot">{'●'}</span> {systemStatusLabel}
          </span>
        )}
      </div>
    </footer>
  );
};

export default Footer;
