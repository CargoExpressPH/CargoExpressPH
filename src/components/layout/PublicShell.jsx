import { useEffect, useState } from 'react';
import { Outlet, Link } from 'react-router-dom';
import BrandLockup from '../ui/BrandLogo';
import Footer from './Footer';
import { getCompanyInformation } from '../../lib/database';
import BusinessStructuredData from '../public/BusinessStructuredData';
import { useDashboardPath } from '../../hooks/useDashboardPath';

/**
 * Minimal chrome for guest-accessible pages that aren't part of the About
 * page itself (currently /schedules and /faq) — a slim top bar with the
 * brand and sign-in/sign-up, the page content, and the same public Footer
 * used on About. Deliberately not CustomerLayout: that layout assumes a
 * signed-in user everywhere (avatar, notification bell, unread counts) and
 * would either break or need auth-guarding just to render for a guest.
 *
 * No live system-status indicator here (see Footer.jsx) — that's wired up
 * from About page's own data-loading effect and isn't worth duplicating for
 * two lightweight pages.
 */
const PublicShell = ({ children }) => {
  const [company, setCompany] = useState(null);
  // A signed-in visitor is offered their dashboard instead of being asked
  // to log in again.
  const dashboardPath = useDashboardPath();

  useEffect(() => {
    let mounted = true;
    getCompanyInformation()
      .then(info => { if (mounted) setCompany(info); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  return (
    <div className="public-shell">
      <header className="public-shell-header">
        <Link to="/" className="public-shell-brand" aria-label="CargoExpress PH home">
          <BrandLockup size={32} />
        </Link>
        <nav className="public-shell-nav" aria-label="Account">
          {dashboardPath ? (
            <Link to={dashboardPath} className="btn btn-primary btn-sm">Go to Dashboard</Link>
          ) : (
            <>
              <Link to="/login" className="public-shell-link">Log In</Link>
              <Link to="/register" className="btn btn-primary btn-sm">Sign Up</Link>
            </>
          )}
        </nav>
      </header>

      <main className="public-shell-main">
        {children || <Outlet />}
      </main>

      <Footer companyName={company?.name} info={company} />
      <BusinessStructuredData info={company} />
    </div>
  );
};

export default PublicShell;
