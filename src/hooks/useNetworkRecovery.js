import { useEffect } from 'react';

/**
 * A hook that listens for the browser's 'online' event and triggers a callback.
 * This is useful for automatically clearing error states and re-fetching data
 * when the user's internet connection is restored.
 * 
 * @param {Function} onRecover - The callback function to execute when network recovers.
 * @param {boolean} [enabled=true] - Whether the listener is active.
 */
export const useNetworkRecovery = (onRecover, enabled = true) => {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const handleOnline = () => {
      // Execute the recovery callback
      if (typeof onRecover === 'function') {
        onRecover();
      }
    };

    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [onRecover, enabled]);
};

export default useNetworkRecovery;
