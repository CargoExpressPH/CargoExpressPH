import { useEffect, useState } from 'react';
import { Outlet, Link, NavLink } from 'react-router-dom';
import BrandLockup from '../ui/BrandLogo';
import Footer from './Footer';
import { getCompanyInformation } from '../../lib/database';
import BusinessStructuredData from '../public/BusinessStructuredData';
import { useDashboardPath } from '../../hooks/useDashboardPath';

/**
 * Minimal chrome for guest-accessible pages that aren't part of the About
 * page itself (currently /schedules and /faq) — a slim top bar with the
 * brand and sign-in/sign-up (or "Go to Dashboard" once signed in), the page
 * content, and the same public Footer
 * used on About. Deliberately not CustomerLayout: that layout assumes a
 * signed-in user everywhere (avatar, notification bell, unread counts) and
 * would either break or need auth-guarding just to render for a guest.
 *
 * No live system-status indicator here (see Footer.jsx) — that's wired up
 * from About page's own data-loading effect and isn't worth duplicating for
 * two lightweight pages.
 *
 * `wide` lifts the reading-width cap for pages whose full-bleed panels lay
 * out their own columns (the home page and the 404 page). `links` adds the
 * public page links to the header; phones hide them, the footer has them.
 */
const PAGE_LINKS = [
  ['/schedules', 'Trip Schedules'],
  ['/track', 'Track'],
  ['/faq', 'Help'],
  ['/about', 'About'],
];

const PublicShell = ({ children, wide = false, links = false }) => {
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
        {links && (
          <nav className="public-shell-pages" aria-label="Site pages">
            {PAGE_LINKS.map(([to, label]) => (
              <NavLink key={to} to={to} className="public-shell-page-link">{label}</NavLink>
            ))}
          </nav>
        )}
        <nav className="public-shell-nav" aria-label="Account">
          {dashboardPath ? (
            <Link to={dashboardPath} className="btn btn-primary btn-sm public-shell-dashboard">
              <span><span className="public-shell-dashboard-prefix">Go to </span>Dashboard</span>
            </Link>
          ) : (
            <>
              <Link to="/login" className="public-shell-link">Log In</Link>
              <Link to="/register" className="btn btn-primary btn-sm">Sign Up</Link>
            </>
          )}
        </nav>
      </header>

      <main className={`public-shell-main${wide ? ' public-shell-main--wide' : ''}`}>
        {children || <Outlet />}
      </main>

      <Footer companyName={company?.name} info={company} />
      <BusinessStructuredData info={company} />
    </div>
  );
};

export default PublicShell;
