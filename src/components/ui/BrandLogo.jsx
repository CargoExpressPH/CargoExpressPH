/**
 * The Cargo Express PH brand lockup, wherever the brand appears.
 *
 * Three exports, one source of truth:
 *
 *   BrandLogo      the badge mark alone
 *   BrandWordmark  the words alone — "CARGO EXPRESS PH", always
 *   BrandLockup    mark + wordmark, the standard pairing
 *
 * The lockup exists because the supplied artwork is a circular badge with the
 * wordmark baked into it, and baked-in type is illegible below about 80 px. The
 * badge carries recognition, the HTML text carries the name — crisp at any
 * size, themeable, selectable, translatable, and readable by a screen reader.
 * Rendering the badge alone in a 40 px navbar left the product with no legible
 * brand name at all.
 *
 * Two properties of the artwork drive the mark:
 *
 *   It is a circle on an OPAQUE WHITE background — the PNG has no alpha. Left
 *   square it renders as a bright tile on the dark sidebar (#060E1A) and the
 *   dark glass navbar. `border-radius: 50%` clips it back to the circle the
 *   artwork already draws, so the white reads as the badge's own fill.
 *
 *   It is 2000×2000 and ~949 KB. Into a 40 px slot on every page of a PWA that
 *   is the entire image budget spent on a favicon-sized element, so
 *   `/logo-nav.png` is an optimized, downscaled derivative (256 px, ~38 KB).
 *   `/logo.png` remains the untouched master.
 *
 * `tone` picks the wordmark colours: "default" on light surfaces, "on-dark" for
 * the auth hero panels and the transparent About header, which sit on dark
 * imagery and previously hard-coded `color: '#fff'` at each call site.
 */

/**
 * The badge mark.
 *
 * `decorative` is for callers that supply their own accessible name — which is
 * every use inside BrandLockup, since the visible wordmark next to it already
 * says "CARGO EXPRESS PH" and announcing it twice is worse than not at all.
 */
export const BrandLogo = ({ size = 40, decorative = false, className = '' }) => (
  <img
    src="/logo-nav.png"
    alt={decorative ? '' : 'Cargo Express PH'}
    // Intrinsic size, so the row reserves the box before the image lands and
    // does not jolt sideways on first paint.
    width={size}
    height={size}
    className={`brand-logo ${className}`.trim()}
    // The size travels as a custom property rather than as inline width/height
    // so responsive rules can still override it. An inline style outranks every
    // stylesheet selector, and `@media (max-width: 640px)` deliberately shrinks
    // `.topbar-logo-icon` on phones — an inline size silently defeats that and
    // leaves a desktop-sized logo in a cramped mobile topbar.
    style={{ '--brand-logo-size': `${size}px` }}
    decoding="async"
  />
);

/**
 * The words. "CARGO EXPRESS PH" in caps is the prominent-UI spelling; the two
 * spans exist only so "PH" can take the brand colour the way it does in the
 * artwork, and must not be split across a line — hence the nbsp-free
 * `white-space: nowrap` on the wrapper.
 */
export const BrandWordmark = ({ tone = 'default', className = '' }) => (
  <span className={`brand-wordmark brand-wordmark-${tone} ${className}`.trim()}>
    <span className="brand-wordmark-name">CARGO EXPRESS</span>{' '}
    <span className="brand-wordmark-suffix">PH</span>
  </span>
);

const BrandLockup = ({ size = 40, tone = 'default', className = '' }) => (
  <span className={`brand-lockup ${className}`.trim()}>
    <BrandLogo size={size} decorative />
    <BrandWordmark tone={tone} />
  </span>
);

export default BrandLockup;
