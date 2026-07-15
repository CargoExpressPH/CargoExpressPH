// ============================================================================
// CargoExpress PH — Service Worker v1.0.0
// Premium PWA Service Worker with offline support, smart caching strategies,
// and optimized performance for cargo delivery booking & tracking.
// ============================================================================

const CACHE_VERSION = '__BUILD_VERSION__';
const STATIC_CACHE = `cargoexpress-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `cargoexpress-dynamic-${CACHE_VERSION}`;
const IMAGE_CACHE = `cargoexpress-images-${CACHE_VERSION}`;

// Maximum items in dynamic cache to prevent unbounded growth
const DYNAMIC_CACHE_LIMIT = 80;
const IMAGE_CACHE_LIMIT = 60;

// App shell resources to pre-cache on install
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
];

// Offline fallback HTML — displayed when network is unavailable and no cache hit
const OFFLINE_FALLBACK_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#16A34A">
  <title>CargoExpress PH — Offline</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #0F172A 0%, #1B3A5C 50%, #0F172A 100%);
      color: #F1F5F9;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      overflow: hidden;
    }
    .offline-container {
      text-align: center;
      max-width: 440px;
      animation: fadeInUp 0.6s ease-out;
    }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .offline-icon {
      width: 120px;
      height: 120px;
      margin: 0 auto 2rem;
      background: rgba(22, 163, 74, 0.12);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid rgba(22, 163, 74, 0.25);
    }
    .offline-icon svg {
      width: 56px;
      height: 56px;
      stroke: #16A34A;
      stroke-width: 1.5;
      fill: none;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      background: linear-gradient(135deg, #16A34A, #4ADE80);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    p {
      font-size: 1rem;
      color: #94A3B8;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .retry-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.875rem 2rem;
      background: linear-gradient(135deg, #16A34A, #15803D);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.25s ease;
      box-shadow: 0 4px 20px rgba(22, 163, 74, 0.35);
    }
    .retry-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(22, 163, 74, 0.45);
    }
    .retry-btn:active { transform: translateY(0); }
    .brand {
      margin-top: 3rem;
      font-size: 0.8rem;
      color: #475569;
      letter-spacing: 0.05em;
    }
  </style>
</head>
<body>
  <div class="offline-container">
    <div class="offline-icon">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <line x1="1" y1="1" x2="23" y2="23" stroke-linecap="round"/>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="12" y1="20" x2="12.01" y2="20" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <h1>You're Offline</h1>
    <p>It looks like you've lost your internet connection. Please check your network and try again to continue using CargoExpress PH.</p>
    <button class="retry-btn" onclick="window.location.reload()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      Try Again
    </button>
    <div class="brand">CARGOEXPRESS PH</div>
  </div>
</body>
</html>
`;

// ============================================================================
// INSTALL — Pre-cache app shell
// ============================================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {
        // Pre-cache failed — app will still work via network
      })
  );
});

// ============================================================================
// ACTIVATE — Clean up old caches
// ============================================================================
self.addEventListener('activate', (event) => {
  const currentCaches = [STATIC_CACHE, DYNAMIC_CACHE, IMAGE_CACHE];
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name.startsWith('cargoexpress-') && !currentCaches.includes(name))
            .map((name) => caches.delete(name))
        );
      })
      .then(() => self.clients.claim())
  );
});

// ============================================================================
// HELPER — Trim cache to a maximum number of items
// ============================================================================
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    // Remove oldest entries first
    const deleteCount = keys.length - maxItems;
    await Promise.all(
      keys.slice(0, deleteCount).map((key) => cache.delete(key))
    );
  }
}

// ============================================================================
// HELPER — Check if a URL is an API / Supabase call
// ============================================================================
function isApiRequest(url) {
  return (
    url.includes('/api/') ||
    url.includes('supabase.co') ||
    url.includes('supabase.io') ||
    url.includes('/rest/v1/') ||
    url.includes('/auth/v1/') ||
    url.includes('/storage/v1/') ||
    url.includes('/realtime/') ||
    url.includes('/functions/v1/')
  );
}

// ============================================================================
// HELPER — Check if request is for a static asset
// ============================================================================
function isStaticAsset(url) {
  const staticExtensions = [
    '.js', '.css', '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif'
  ];
  const pathname = new URL(url).pathname;
  return staticExtensions.some((ext) => pathname.endsWith(ext));
}

// ============================================================================
// HELPER — Check if request is for an image
// ============================================================================
function isImageRequest(url) {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif'];
  const pathname = new URL(url).pathname;
  return imageExtensions.some((ext) => pathname.endsWith(ext));
}

// ============================================================================
// HELPER — Check if request is a navigation request
// ============================================================================
function isNavigationRequest(request) {
  return (
    request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))
  );
}

// ============================================================================
// STRATEGY — Network first (for API calls)
// ============================================================================
async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);
    return networkResponse;
  } catch (err) {
    // API calls fail silently when offline — the app handles these errors
    return new Response(
      JSON.stringify({ error: 'offline', message: 'You are currently offline' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// ============================================================================
// STRATEGY — Stale-while-revalidate (for static assets)
// ============================================================================
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse && networkResponse.ok) {
        cache.put(request, networkResponse.clone());
        trimCache(cacheName, cacheName === IMAGE_CACHE ? IMAGE_CACHE_LIMIT : DYNAMIC_CACHE_LIMIT);
      }
      return networkResponse;
    })
    .catch(() => cachedResponse);

  return cachedResponse || fetchPromise;
}

// ============================================================================
// STRATEGY — Cache first (for fonts and immutable assets)
// ============================================================================
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
      trimCache(cacheName, DYNAMIC_CACHE_LIMIT);
    }
    return networkResponse;
  } catch (err) {
    return new Response('', { status: 408, statusText: 'Offline' });
  }
}

// ============================================================================
// FETCH — Route requests to appropriate strategy
// ============================================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip chrome-extension and browser-internal requests
  if (url.startsWith('chrome-extension://') || url.startsWith('chrome://')) return;

  // Skip localhost dev server requests (Vite HMR, hot module reload, etc.)
  // In production builds, assets are served from the same origin without these paths
  const urlObj = new URL(url);
  if (
    urlObj.hostname === 'localhost' ||
    urlObj.hostname === '127.0.0.1' ||
    url.includes('/@vite') ||
    url.includes('/__vite') ||
    url.includes('/@react-refresh') ||
    url.includes('/node_modules/') ||
    url.includes('?t=') || // Vite cache-busting timestamps
    url.includes('hot-update')
  ) return;

  // ----- API / Supabase: Network First -----
  if (isApiRequest(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // ----- Navigation requests: Network first with offline fallback -----
  if (isNavigationRequest(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful navigation responses
          const responseClone = response.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(async () => {
          // Try cache first
          const cached = await caches.match(request);
          if (cached) return cached;

          // Try index.html from cache (SPA fallback)
          const indexCached = await caches.match('/index.html');
          if (indexCached) return indexCached;

          // Ultimate offline fallback
          return new Response(OFFLINE_FALLBACK_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        })
    );
    return;
  }

  // ----- Images: Stale-while-revalidate with dedicated cache -----
  if (isImageRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE));
    return;
  }

  // ----- Google Fonts: Cache first (immutable) -----
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // ----- All other static assets: Stale-while-revalidate -----
  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  // ----- Default: Network with cache fallback -----
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const responseClone = response.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => {
            cache.put(request, responseClone);
            trimCache(DYNAMIC_CACHE, DYNAMIC_CACHE_LIMIT);
          });
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        return cached || new Response('', { status: 408, statusText: 'Offline' });
      })
  );
});

// ============================================================================
// MESSAGE — Handle skip-waiting message from client
// ============================================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_VERSION });
  }
});

// ============================================================================
// PUSH — Firebase Cloud Messaging push notification received
// ============================================================================
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch (e) {
    data = { notification: { title: 'CargoExpress PH', body: event.data?.text() || 'You have a new update' } };
  }

  const notif = data.notification || {};
  const title = notif.title || 'CargoExpress PH';
  const body = notif.body || 'You have a new update';
  const url = data.data?.url || notif.click_action || '/customer/notifications';

  const notifOptions = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    data: { url },
    vibrate: [200, 100, 200],
    tag: 'cargoexpress-' + Date.now(),
    renotify: true,
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If the app is focused, send an in-app toast instead of a system notification
      const focusedClient = clientList.find((c) => c.focused);

      if (focusedClient) {
        focusedClient.postMessage({
          type: 'PUSH_NOTIFICATION',
          title,
          body,
          url,
        });
        return;
      }

      // App is in background or closed — show system notification
      return self.registration.showNotification(title, notifOptions);
    })
  );
});

// ============================================================================
// NOTIFICATION CLICK — User taps the push notification
// ============================================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/customer/notifications';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If the app is already open, focus it and navigate
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      // Otherwise open a new window
      return clients.openWindow(targetUrl);
    })
  );
});
