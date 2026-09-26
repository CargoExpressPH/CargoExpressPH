import '../../styles/boot-splash.css';

/**
 * The full-screen brand splash shown while the app starts.
 *
 * It renders twice per cold visit, and the two must look identical so the
 * hand-off is invisible: first as plain HTML baked into every public page by
 * scripts/generate-seo-pages.mjs (shown until the JS bundle mounts React),
 * then as App.jsx's <LoadingScreen/> while the session is checked. Keep it
 * free of hooks and context so the build can render it without the app.
 *
 * Styles live in src/styles/boot-splash.css, which the build also inlines
 * into the generated pages.
 */
const BootSplash = ({ className = '' }) => (
  <div className={`boot-splash ${className}`.trim()} role="status">
    <span className="boot-splash-glow" aria-hidden="true" />
    <span className="boot-splash-mark" aria-hidden="true">
      <span className="boot-splash-orbit" />
      <img src="/images/logo-nav.png" alt="" width="88" height="88" decoding="async" />
    </span>
    <span className="boot-splash-name" aria-hidden="true">
      CARGOEXPRESS <span className="boot-splash-name-suffix">PH</span>
    </span>
    <span className="boot-splash-route" aria-hidden="true">
      Manila
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" />
      </svg>
      Bohol
    </span>
    <span className="boot-splash-bar" aria-hidden="true" />
    <span className="boot-splash-sr">Loading CargoExpress PH…</span>
  </div>
);

export default BootSplash;
