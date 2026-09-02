import { lazy } from 'react';

export class OfflineChunkError extends Error {
  constructor(cause) {
    super('This screen is not available offline yet. Reconnect and try again.', { cause });
    this.name = 'OfflineChunkError';
    this.code = 'OFFLINE_CHUNK_UNAVAILABLE';
  }
}

const validateModule = (module) => {
  if (!module || typeof module !== 'object' || !('default' in module)) {
    throw new TypeError('Lazy-loaded module did not provide a default export.');
  }
  return module;
};

/**
 * A wrapper for React.lazy that automatically retries the dynamic import
 * if it fails due to network issues (e.g. chunk load error).
 * It will retry up to 3 times with exponential backoff.
 */
export const lazyWithRetry = (componentImport, retries = 3, interval = 1000) => {
  return lazy(() => {
    return new Promise((resolve, reject) => {
      // Create a retry function
      const retry = (attemptLeft, delay) => {
        componentImport()
          .then(validateModule)
          .then(resolve)
          .catch((error) => {
            // A retry cannot fetch an uncached chunk without a connection and
            // only keeps the user staring at a loader for another seven seconds.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
              reject(new OfflineChunkError(error));
              return;
            }

            if (attemptLeft === 0) {
              reject(error);
              return;
            }
            setTimeout(() => {
              // Retry but append a query string to bust browser cache
              // (Dynamic import errors can sometimes be cached by the browser)
              // Since componentImport is a function () => import('./...'), we just call it again.
              retry(attemptLeft - 1, delay * 2);
            }, delay);
          });
      };
      retry(retries, interval);
    });
  });
};
