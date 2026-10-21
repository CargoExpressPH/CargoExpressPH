import { WifiOff } from 'lucide-react';
import { useNetworkState } from '../../contexts/OfflineContext';
import OfflineFallbackBanner from './OfflineFallbackBanner';

/**
 * OfflineBoundary — Route-level offline tier wrapper.
 *
 * Tier 1 (Full Offline Operational): transparent pass-through. The page owns
 *   its own IndexedDB read/write and queue logic.
 *
 * Tier 2 (Cached Read-Only): renders children normally, but adds a slim banner
 *   when offline to signal that data may be stale.
 *
 * Tier 3 (Online-Only): replaces children with <OfflineFallbackBanner /> while
 *   the device is offline. The app shell (sidebar, nav) still renders; only the
 *   content area shows the fallback.
 *
 * @param {1|2|3}   tier     Offline behaviour tier
 * @param {string}  [label]  Human-readable module name for Tier 3 fallback copy
 * @param {node}    children Route content
 */
export default function OfflineBoundary({ tier, label, children }) {
  const { isOnline } = useNetworkState();

  // Tier 1: full offline support — let the page handle everything
  if (tier === 1) return children;

  // Online: all tiers render normally
  if (isOnline) return children;

  // Offline — Tier 3: replace content with informational fallback
  if (tier === 3) return <OfflineFallbackBanner label={label} />;

  // Offline — Tier 2: show content with a "cached data" notice
  return (
    <>
      <CachedDataNotice />
      {children}
    </>
  );
}

function CachedDataNotice() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0.5rem 1rem',
        background: 'rgba(245,158,11,0.10)',
        borderBottom: '1px solid rgba(245,158,11,0.20)',
        fontSize: 'var(--text-13, 0.8125rem)',
        color: '#D97706',
        fontWeight: 500,
      }}
    >
      <WifiOff size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span>Offline Mode · Showing Cached Data</span>
    </div>
  );
}
