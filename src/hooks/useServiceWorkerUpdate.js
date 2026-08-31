import { useEffect, useState, useCallback } from 'react';

/**
 * Detects when a new service worker has taken control of this page —
 * i.e. a deploy happened and the update is already installed and active —
 * without ever reloading on its own. sw.js already calls self.skipWaiting()
 * on install and self.clients.claim() on activate, so the new worker is in
 * control the moment `controllerchange` fires; all that's missing is telling
 * the customer/admin so they can choose when to actually load it, rather
 * than losing whatever they were doing to a silent, surprise reload.
 *
 * Gated on `hadController`: clients.claim() also "hands off" a brand-new
 * visitor's very first, previously-uncontrolled page load to the
 * freshly-installed worker. That is not an update — there is nothing earlier
 * to refresh away from — so it must never surface this prompt.
 */
export const useServiceWorkerUpdate = () => {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;

    const hadController = !!navigator.serviceWorker.controller;
    if (!hadController) return undefined;

    const handleControllerChange = async () => {
      try {
        const res = await fetch('/update-target.json?t=' + Date.now());
        if (res.ok) {
          const data = await res.json();
          const target = data.target || 'both';
          const isAdmin = window.location.pathname.startsWith('/admin');
          
          if (target === 'admin' && !isAdmin) return;
          if (target === 'customer' && isAdmin) return;
        }
      } catch (err) {
        // Fallback to showing it if fetch fails
      }
      setUpdateAvailable(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
  }, []);

  // The reload the customer explicitly asks for, once they click "Refresh
  // Now" — the new worker is already in control, so this is just the normal
  // page load that finally pulls in its (already-cached) new assets.
  const reload = useCallback(() => window.location.reload(), []);

  return { updateAvailable, reload };
};

export default useServiceWorkerUpdate;
