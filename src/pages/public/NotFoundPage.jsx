import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CircleHelp, CircleX, Home, MapPin, Search } from 'lucide-react';
import BrandLockup from '../../components/ui/BrandLogo';
import usePageTitle from '../../hooks/usePageTitle';

const NotFoundPage = () => {
  usePageTitle('Page Not Found');
  const navigate = useNavigate();

  const handleGoBack = () => {
    // A direct visit has no useful in-app destination to return to.
    if (window.history.state?.idx > 0) {
      navigate(-1);
    } else {
      navigate('/', { replace: true });
    }
  };

  return (
    <main id="main-content" className="not-found-page">
      <a href="#nf-content" className="skip-link">Skip to main content</a>

      <div className="nf-shell">
        <header className="nf-header">
          <Link to="/" aria-label="CargoExpress PH home" className="nf-brand">
            <BrandLockup size={34} />
          </Link>
          <Link to="/about#contact" className="nf-help-link">
            <CircleHelp size={17} aria-hidden="true" /> <span>Need help?</span>
          </Link>
        </header>

        <div className="nf-layout" id="nf-content">
          <div className="nf-copy">
            <p className="nf-eyebrow"><span className="nf-eyebrow-dot" /> Error 404 <span className="nf-eyebrow-line" /> Page not found</p>
            <h1 className="nf-title">This page isn’t<br className="nf-desktop-break" /> on the route.</h1>
            <p className="nf-description">
              The link may be outdated, or the address may have a typo. Let’s get you back on track.
            </p>

            <div className="nf-actions">
              <Link to="/" className="nf-action nf-action-primary">
                <Home size={19} aria-hidden="true" /> Go to homepage <ArrowRight size={18} aria-hidden="true" className="nf-action-arrow" />
              </Link>
              <Link to="/track" className="nf-action nf-action-secondary">
                <Search size={19} aria-hidden="true" /> Track a shipment
              </Link>
            </div>

            <button type="button" onClick={handleGoBack} className="nf-back-link">
              <ArrowLeft size={17} aria-hidden="true" /> Go back to the previous page
            </button>
          </div>

          <div className="nf-art" aria-hidden="true">
            <div className="nf-art-top"><span>PAGE STATUS</span><span className="nf-art-status"><span /> LINK NOT FOUND</span></div>
            <div className="nf-art-center">
              <div className="nf-art-code">404</div>
              <div className="nf-art-route">
                <span className="nf-art-start"><MapPin size={20} /></span>
                <span className="nf-art-path" />
                <span className="nf-art-end"><CircleX size={25} /></span>
              </div>
            </div>
            <div className="nf-art-bottom"><span>WRONG TURN</span><span>FIND YOUR WAY BACK <ArrowRight size={15} /></span></div>
          </div>
        </div>

        <footer className="nf-footer">
          <span>CargoExpress PH</span><span className="nf-footer-separator" aria-hidden="true" />
          <span>Connecting Manila &amp; Bohol</span>
        </footer>
      </div>
    </main>
  );
};

export default NotFoundPage;
