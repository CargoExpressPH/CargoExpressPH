import { createClient } from '@supabase/supabase-js';

// ============================================================
// SUPABASE CONFIGURATION
// Reads from .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
// ============================================================
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing Supabase env variables. Check your .env file.');
}

// ---------------------------------------------------------------------------
// FETCH WRAPPER (Timeout & Retries)
// ---------------------------------------------------------------------------
const fetchWithRetry = async (url, options = {}, retries = 3, backoff = 1000) => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Network offline');
  }

  const timeoutMs = 15000; // 15 seconds timeout
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    // If Supabase provides its own signal (e.g. for cancelling pending requests),
    // we must link it to our controller so we don't accidentally ignore it.
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
      if (options.signal.aborted) controller.abort();
    }

    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    
    // If it's a 5xx error or 429 Too Many Requests, throw to trigger a retry
    if (!response.ok && (response.status >= 500 || response.status === 429)) {
      throw new Error(`HTTP Error ${response.status}`);
    }
    return response;
  } catch (error) {
    if (retries > 0 && error.name !== 'AbortError') {
      // Retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, backoff));
      // Exponential backoff: 1s, 2s, 4s
      return fetchWithRetry(url, options, retries - 1, backoff * 2);
    }
    // No more retries, throw the error so the UI can catch it
    throw error;
  }
};

// ---------------------------------------------------------------------------
// CUSTOM LOCK FOR TOKEN REFRESH
// Solves token refresh race condition on local HTTP environments
// where navigator.locks is disabled by the browser.
//
// Supabase's lock option signature is:
//   (name: string, acquireTimeout: number, fn: () => Promise<unknown>) => Promise<unknown>
// acquireTimeout = -1 means "wait indefinitely".
// ---------------------------------------------------------------------------
let inMemoryLocks = {};
const customLock = async (name, acquireTimeout, fn) => {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    // Wrap fn in a fresh arrow function — Chrome's LockManager requires a
    // plain Function instance and will reject Supabase's internal callables.
    return navigator.locks.request(name, () => fn());
  }
  // Fallback in-memory lock (used on HTTP or browsers without navigator.locks)
  while (inMemoryLocks[name]) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  inMemoryLocks[name] = true;
  try {
    return await fn();
  } finally {
    delete inMemoryLocks[name];
  }
};


export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Persist session in localStorage
    persistSession: true,
    // Detect session from URL (for OAuth/magic link redirects)
    detectSessionInUrl: true,
    // Auto-refresh the token before it expires
    autoRefreshToken: true,
    // Custom lock for concurrent refresh requests over HTTP
    lock: customLock,
  },
  global: {
    fetch: (...args) => {
      const url = args[0];
      const options = args[1] || {};
      
      // Force no-store caching for PostgREST GET requests to prevent stale data
      // This fixes the issue where newly opened tabs show old data until hard refreshed.
      if (options.method === 'GET' && typeof url === 'string' && url.includes('/rest/v1/')) {
        options.cache = 'no-store';
      }
      
      return fetch(url, options);
    }
  },
  realtime: {
    reconnectAfterMs: (tries) => Math.min(tries * 2000 + 1000, 15000),
  },
});

export default supabase;
