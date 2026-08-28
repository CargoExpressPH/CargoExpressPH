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
  event.preventDefault();
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    const last = raw ? Number(raw) : 0;
    const now = Date.now();
    if (!last || Number.isNaN(last) || now - last > RELOAD_THROTTLE_MS) {
      sessionStorage.setItem(RELOAD_KEY, String(now));
      window.location.reload();
      return;
    }
  } catch {
    // sessionStorage blocked (Safari private mode / 3rd-party cookie block) -
    // still recover once; guard falls back to in-memory single attempt.
    window.location.reload();
    return;
  }
  console.error('Vite preload error: skipping reload to prevent infinite loop.', event);
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
