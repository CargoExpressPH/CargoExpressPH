import usePageTitle from '../../hooks/usePageTitle';
import { LandingContent } from './LandingSections';
import './landing.css';

// Cards light up where the pointer is. The position is written as custom
// properties on the card itself, so no state change or re-render per move.
const SPOTLIT = '.lp-card, .lp-explore-link';

const followPointer = (event) => {
  if (event.pointerType !== 'mouse') return;
  const card = event.target.closest?.(SPOTLIT);
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  card.style.setProperty('--my', `${event.clientY - rect.top}px`);
};

// The heading, summary and sections are the same ones the build writes into
// the crawlable HTML (src/seo/SeoPage.jsx), so the page a search engine reads
// is the page a visitor sees.
const LandingPage = () => {
  usePageTitle();

  return (
    <div className="lp lp-theme" onPointerMove={followPointer}>
      <LandingContent />
    </div>
  );
};

export default LandingPage;
