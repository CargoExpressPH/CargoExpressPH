import PublicShell from '../../components/layout/PublicShell';
import usePageTitle from '../../hooks/usePageTitle';
import { ExploreLinks, LandingHero, NOT_FOUND_HERO } from './LandingSections';
import './landing.css';

// The same hero and links the build writes into dist/404.html (see
// src/seo/SeoPage.jsx), so the page looks the same before and after the app
// loads. `not-found-page` is the hook the viewport rules and e2e tests use.
const NotFoundPage = () => {
  usePageTitle('Page Not Found');

  return (
    <div className="not-found-page">
      <PublicShell wide>
        <div className="lp lp-theme">
          <LandingHero {...NOT_FOUND_HERO} />
          <ExploreLinks />
        </div>
      </PublicShell>
    </div>
  );
};

export default NotFoundPage;
