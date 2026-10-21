import { WifiOff, RefreshCw } from 'lucide-react';

/**
 * OfflineFallbackBanner — Tier 3 content-area placeholder.
 * Renders when a module requires live internet and the device is offline.
 *
 * @param {string} [label]  Short module name, e.g. "Sales & Reports"
 */
export default function OfflineFallbackBanner({ label }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 360,
        padding: '2.5rem 1.5rem',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 88,
          height: 88,
          borderRadius: '50%',
          background: 'rgba(245,158,11,0.10)',
          border: '2px solid rgba(245,158,11,0.20)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '1.5rem',
        }}
      >
        <WifiOff size={38} color="#F59E0B" strokeWidth={1.5} aria-hidden="true" />
      </div>

      <h2
        style={{
          margin: '0 0 0.5rem',
          fontSize: 'var(--text-18, 1.125rem)',
          fontWeight: 700,
          color: 'var(--text)',
        }}
      >
        Internet Connection Required
      </h2>

      <p
        style={{
          margin: '0 0 1.75rem',
          maxWidth: 360,
          fontSize: 'var(--text-14, 0.875rem)',
          color: 'var(--text-secondary, #94a3b8)',
          lineHeight: 1.6,
        }}
      >
        {label
          ? <><strong style={{ color: 'var(--text)' }}>{label}</strong> is an online-only feature.</>
          : 'This feature is online-only.'
        }
        {' '}Please connect to the internet and try again. Other modules like Bookings and Trips are still available offline.
      </p>

      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '0.75rem 1.5rem',
          background: 'var(--bg-secondary, rgba(255,255,255,0.06))',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          fontSize: 'var(--text-14, 0.875rem)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        <RefreshCw size={15} aria-hidden="true" />
        Retry
      </button>
    </div>
  );
}
