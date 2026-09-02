import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import { useRouteError } from 'react-router-dom';

const RouteErrorBoundary = () => {
  const error = useRouteError();
  const [isOnline, setIsOnline] = useState(() => navigator.onLine !== false);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const isOfflineFailure = !isOnline
    || error?.code === 'OFFLINE_CHUNK_UNAVAILABLE';

  const title = isOfflineFailure ? "You're offline" : 'This screen could not load';
  const description = isOfflineFailure
    ? 'CargoExpress PH cannot refresh live shipment data without an internet connection. Reconnect, then try this screen again.'
    : 'The app may have been updated while this screen was open. Reload to use the latest version.';
  const Icon = isOfflineFailure ? WifiOff : AlertTriangle;

  return (
    <main className="error-boundary-fallback route-error-fallback" role="alert" aria-live="assertive">
      <div className="error-boundary-icon">
        <Icon size={36} aria-hidden="true" />
      </div>
      <h1>{title}</h1>
      <p>{description}</p>
      <div className="error-boundary-actions">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn btn-primary"
          disabled={!isOnline}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {isOnline ? 'Try Again' : 'Waiting for connection'}
        </button>
      </div>
      <p className="route-error-hint">
        Your saved account and cached app data have not been removed.
      </p>
    </main>
  );
};

export default RouteErrorBoundary;
