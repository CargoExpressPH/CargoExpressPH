import PublicShell from '../../components/layout/PublicShell';
import usePageTitle from '../../hooks/usePageTitle';
import { ExploreLinks, NOT_FOUND_HERO, NotFoundHero } from './NotFoundSections';
import './not-found.css';

// Links glow where the pointer is. The position is written as custom
// properties on the link itself, so no state change or re-render per move.
const followPointer = (event) => {
  if (event.pointerType !== 'mouse') return;
  const link = event.target.closest?.('.lp-explore-link');
  if (!link) return;
  const rect = link.getBoundingClientRect();
  link.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  link.style.setProperty('--my', `${event.clientY - rect.top}px`);
};

// `not-found-page` is the hook the viewport rules and e2e tests use.
const NotFoundPage = () => {
  usePageTitle('Page Not Found');

  return (
    <div className="not-found-page">
      <PublicShell wide>
        <div className="lp lp-theme" onPointerMove={followPointer}>
          <NotFoundHero {...NOT_FOUND_HERO} />
          <ExploreLinks />
        </div>
      </PublicShell>
    </div>
  );
};

export default NotFoundPage;
