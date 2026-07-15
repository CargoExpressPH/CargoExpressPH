import { lazy } from 'react';

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
          .then(resolve)
          .catch((error) => {
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
