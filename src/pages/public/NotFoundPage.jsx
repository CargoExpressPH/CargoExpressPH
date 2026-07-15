import { Link } from 'react-router-dom';
import { PackageX, Home, Search, ArrowLeft, Compass } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

const NotFoundPage = () => {
  usePageTitle('Page Not Found');
  return (
  <div className="not-found-page">
    {/* Decorative background orbs */}
    <div className="nf-orb nf-orb-1" aria-hidden="true" />
    <div className="nf-orb nf-orb-2" aria-hidden="true" />

    <div className="not-found-card">
      {/* Animated icon with pulse ring */}
      <div className="nf-icon-wrap">
        <div className="nf-icon-ring" />
        <div className="nf-icon-circle">
          <PackageX size={36} strokeWidth={1.8} />
        </div>
      </div>

      {/* Error code with gradient */}
      <h1 className="nf-code">
        <span className="nf-code-4">4</span>
        <span className="nf-code-0">0</span>
        <span className="nf-code-4b">4</span>
      </h1>

      <h2 className="not-found-title">Page Not Found</h2>
      <p className="not-found-text">
        Looks like this package got lost in transit. The page you're looking for
        doesn't exist, has been moved, or is temporarily unavailable.
      </p>

      {/* Navigation suggestions */}
      <div className="nf-suggestions">
        <div className="nf-suggestion-label">
          <Compass size={14} /> Here's where you can go:
        </div>
      </div>

      <div className="not-found-actions">
        <Link to="/" className="btn btn-primary">
          <Home size={16} /> Go Home
        </Link>
        <Link to="/track" className="btn btn-outline">
          <Search size={16} /> Track Shipment
        </Link>
      </div>

      <button
        type="button"
        onClick={() => window.history.back()}
        className="nf-back-link"
      >
        <ArrowLeft size={14} /> Go back to previous page
      </button>
    </div>
  </div>
  );
};

export default NotFoundPage;
