import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ui/ErrorBoundary';
import './styles/main.css';

// Safety net: If a user ignores the UpdateAvailableBanner and a lazy chunk
// 404s after a deploy, recover with a single reload instead of a white screen.
// Complements useServiceWorkerUpdate (polite banner) + lazyWithRetry (3 retries).
// Vite docs: https://vite.dev/guide/build#load-error-handling
const RELOAD_THROTTLE_MS = 10_000;
const RELOAD_KEY = 'cargoexpress:vite-preload-reload';

window.addEventListener('vite:preloadError', (event) => {
  // Vite only rejects the failed dynamic import when this event is NOT
  // cancelled. Cancelling while offline makes React.lazy receive `undefined`
  // and masks the useful chunk-load error with "reading 'default'". Let the
  // router's errorElement render the offline recovery screen instead.
  if (navigator.onLine === false) {
    console.warn('Vite preload error while offline; showing offline recovery UI.', event);
    return;
  }

  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    const last = raw ? Number(raw) : 0;
    const now = Date.now();
    if (!last || Number.isNaN(last) || now - last > RELOAD_THROTTLE_MS) {
      event.preventDefault();
      sessionStorage.setItem(RELOAD_KEY, String(now));
      window.location.reload();
      return;
    }
  } catch {
    // sessionStorage blocked (Safari private mode / 3rd-party cookie block) -
    // still recover once; guard falls back to in-memory single attempt.
    event.preventDefault();
    window.location.reload();
    return;
  }
  console.error('Vite preload error: skipping reload to prevent infinite loop.', event);
});

/**
 * The static boot splash is a sibling of #root, so createRoot never tears it
 * down before the first React frame is ready. Remove it only after this wrapper
 * commits; the short opacity handoff then reveals either the destination page,
 * the matching React splash, or the error boundary without a blank frame.
 */
const dismissBootSplash = () => {
  const splash = document.getElementById('app-boot-splash');
  if (!splash) return;

  const remove = () => {
    splash.remove();
    document.getElementById('boot-splash-styles')?.remove();
    // index.html gives the document a dark emergency background before CSS.
    // Once the app owns the screen, let the theme stylesheet own it again.
    document.documentElement.style.removeProperty('background');
  };

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    remove();
    return;
  }

  splash.classList.add('app-boot-splash--leaving');
  splash.addEventListener('transitionend', remove, { once: true });
  window.setTimeout(remove, 300);
};

const BootSplashHandoff = ({ children }) => {
  React.useEffect(() => {
    const frameId = window.requestAnimationFrame(dismissBootSplash);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  return children;
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BootSplashHandoff>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BootSplashHandoff>
  </React.StrictMode>
);
