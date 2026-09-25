/**
 * The CargoExpress PH brand lockup, wherever the brand appears.
 *
 * Three exports, one source of truth:
 *
 *   BrandLogo      the badge mark alone
 *   BrandWordmark  the words alone — "CARGOEXPRESS PH", always
 *   BrandLockup    mark + wordmark, the standard pairing
 *
 * The on-screen mark is `/images/logo-mark.svg`: a flat green disc with a
 * parcel glyph, drawn to stay legible down to 24 px and to sit on light and
 * dark surfaces alike (no white backing). The original illustrated badge has
 * type baked into it that is illegible below about 80 px, so it is kept for
 * print (`/images/logo-nav.png`, PrintHeader) and social previews
 * (`/images/logo.png`, the untouched master) only. The HTML wordmark carries
 * the name — crisp at any size, themeable, selectable, and readable by a
 * screen reader.
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
 * says "CARGOEXPRESS PH" and announcing it twice is worse than not at all.
 */
export const BrandLogo = ({ size = 40, decorative = false, className = '' }) => (
  <img
    src="/images/logo-mark.svg"
    alt={decorative ? '' : 'CargoExpress PH'}
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
 * The words. "CARGOEXPRESS PH" in caps is the prominent-UI spelling; the two
 * spans exist only so "PH" can take the brand colour the way it does in the
 * artwork, and must not be split across a line — hence the nbsp-free
 * `white-space: nowrap` on the wrapper.
 */
export const BrandWordmark = ({ tone = 'default', className = '' }) => (
  <span className={`brand-wordmark brand-wordmark-${tone} ${className}`.trim()}>
    <span className="brand-wordmark-name">CARGOEXPRESS</span>{' '}
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
