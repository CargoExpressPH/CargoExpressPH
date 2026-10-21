import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { countAllPending } from '../lib/offlineScannerQueue';
import { preloadOfflineData } from '../lib/offlinePreloader';

const OfflineContext = createContext(null);

export function OfflineProvider({ children }) {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true
  );
  const [pendingCount, setPendingCount] = useState(0);
  const intervalRef = useRef(null);

  const refreshPendingCount = useCallback(async () => {
    try {
      const count = await countAllPending();
      setPendingCount(count);
    } catch {
      // IndexedDB unavailable; leave count unchanged
    }
  }, []);

  const triggerPreload = useCallback((options = {}) => {
    return preloadOfflineData(options);
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      refreshPendingCount();
      preloadOfflineData();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    refreshPendingCount();
    intervalRef.current = setInterval(refreshPendingCount, 30_000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(intervalRef.current);
    };
  }, [refreshPendingCount]);

  return (
    <OfflineContext.Provider value={{ isOnline, pendingCount, refreshPendingCount, triggerPreload }}>
      {children}
    </OfflineContext.Provider>
  );
}

export const useNetworkState = () => {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useNetworkState must be used within OfflineProvider');
  return ctx;
};
