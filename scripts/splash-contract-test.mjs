import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const index = read('index.html');
const main = read('src/main.jsx');
const app = read('src/App.jsx');
const splash = read('src/components/ui/SplashScreen.jsx');
const pageLoader = read('src/components/ui/PageLoader.jsx');
const paymentReturn = read('src/pages/shared/PaymentReturnPage.jsx');
const loadingStyles = read('src/styles/loading-search.css');

const requireSnippet = (source, snippet, message) => {
  if (!source.includes(snippet)) throw new Error(message);
};

const bootSplashIndex = index.indexOf('id="app-boot-splash"');
const reactRootIndex = index.indexOf('id="root"');
if (bootSplashIndex === -1 || reactRootIndex === -1 || bootSplashIndex > reactRootIndex) {
  throw new Error('The static boot splash must exist before #root for an immediate first paint.');
}

requireSnippet(index, 'id="boot-splash-styles"', 'Boot splash critical CSS must remain inline.');
requireSnippet(index, 'rel="preload" as="image" href="/images/logo-nav.png"', 'Boot logo must be preloaded.');
requireSnippet(index, 'role="status"', 'Static boot splash must expose an accessible status.');
requireSnippet(index, 'prefers-reduced-motion: reduce', 'Static boot splash must respect reduced motion.');

requireSnippet(main, 'const BootSplashHandoff', 'React must own the boot-splash handoff.');
requireSnippet(main, "splash.classList.add('app-boot-splash--leaving')", 'Boot splash must fade only after React commits.');
requireSnippet(main, '<BootSplashHandoff>', 'Boot-splash handoff wrapper is not mounted.');

requireSnippet(splash, 'role="status"', 'React splash status must be announced to assistive technology.');
requireSnippet(splash, 'aria-busy={showProgress', 'React splash must expose its busy state.');
requireSnippet(splash, 'slowAfterMs = 8000', 'React splash must detect abnormally slow startup.');
requireSnippet(splash, "window.addEventListener('offline'", 'React splash must react to offline state.');
requireSnippet(splash, 'window.location.reload()', 'React splash must provide recovery after a stalled load.');

requireSnippet(pageLoader, 'className="page-loader"', 'Lazy routes must use the contextual page loader.');
requireSnippet(app, '<Suspense fallback={<PageLoader />}>', 'Root lazy fallback must preserve page context.');
requireSnippet(paymentReturn, '<SplashScreen', 'Payment return must use the shared splash component.');
requireSnippet(loadingStyles, '@keyframes page-loader-shimmer', 'Contextual loader animation is missing.');

console.log('Splash screen contract checks passed.');
