import { useState, useEffect, useCallback } from 'react';
import { X, Download, Zap, WifiOff, Bell } from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────
const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent);
const isInStandaloneMode = () =>
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

const DISMISSED_KEY = 'install_banner_dismissed';
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function wasDismissedRecently() {
  try {
    const ts = parseInt(localStorage.getItem(DISMISSED_KEY) || '0', 10);
    return Date.now() - ts < DISMISS_DURATION_MS;
  } catch {
    return false;
  }
}

const perks = [
  { icon: Zap, label: 'Launches instantly from your home screen or desktop' },
  { icon: WifiOff, label: 'Keeps working when your connection drops' },
  { icon: Bell, label: 'Push alerts the moment a shipment status changes' },
];

// ── Component ────────────────────────────────────────────────────────────────

/**
 * InstallAppBanner
 *
 * Android / Windows / macOS install prompt. Chromium fires
 * `beforeinstallprompt` only when the app already meets every installability
 * criterion, so this banner appears exclusively on browsers that can actually
 * install — no capability sniffing needed on our side.
 *
 * iOS is handled separately by IosInstallBanner (Safari has no install event).
 */
export default function InstallAppBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [visible, setVisible] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    // Never compete with IosInstallBanner, and never nag an installed user
    if (isIos() || isInStandaloneMode()) return;

    const handleBeforeInstallPrompt = (event) => {
      // Suppress Chrome's own mini-infobar so we can present our own UI
      event.preventDefault();
      setDeferredPrompt(event);

      if (wasDismissedRecently()) return;
      // Delay so it doesn't fight with first paint
      setTimeout(() => setVisible(true), 3000);
    };

    const handleAppInstalled = () => {
      setVisible(false);
      setDeferredPrompt(null);
      try { localStorage.setItem('pwa_installed', 'true'); } catch { /* private browsing */ }
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* private browsing */ }
    setVisible(false);
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'dismissed') {
        // Chrome discards the event after one use — remember the refusal
        try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* private browsing */ }
      }
    } catch {
      // Prompt already consumed or blocked — fall through and close
    } finally {
      // The event can only be used once, whatever the outcome
      setDeferredPrompt(null);
      setInstalling(false);
      setVisible(false);
    }
  }, [deferredPrompt]);

  if (!visible) return null;

  return (
    <>
      {/* Backdrop — mobile only; desktop shows a corner card instead */}
      <div
        onClick={dismiss}
        className="install-banner-backdrop"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(4px)',
          zIndex: 9998,
          animation: 'installFadeIn 0.3s ease',
        }}
      />

      <div
        role="dialog"
        aria-label="Install CargoExpress PH"
        className="install-banner-card"
        style={{
          position: 'fixed',
          zIndex: 9999,
          background: 'var(--surface, #1e293b)',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.4)',
          border: '1px solid var(--border)',
          animation: 'installSlideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        <div style={{ padding: '20px 24px 24px', position: 'relative' }}>
          <button
            onClick={dismiss}
            aria-label="Close install prompt"
            style={{
              position: 'absolute',
              top: 4,
              right: 20,
              background: 'var(--bg-secondary)',
              border: 'none',
              borderRadius: '50%',
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-secondary, #94a3b8)',
            }}
          >
            <X size={16} />
          </button>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18, paddingRight: 40 }}>
            <div style={{
              width: 52,
              height: 52,
              borderRadius: 12,
              background: 'linear-gradient(135deg, #16A34A, #15803D)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxShadow: '0 4px 16px rgba(22,163,74,0.35)',
            }}>
              <Download size={26} color="#fff" />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--text)' }}>
                Install CargoExpress PH
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--text-secondary, #94a3b8)' }}>
                Add the app to your device — no app store needed
              </p>
            </div>
          </div>

          {/* Perks */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
            {perks.map(({ icon: Icon, label }) => (
              <div key={label} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 14px',
                background: 'rgba(22,163,74,0.08)',
                borderRadius: 10,
                border: '1px solid rgba(22,163,74,0.15)',
              }}>
                <Icon size={18} color="var(--primary-text)" aria-hidden="true" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: '0.85rem', color: 'var(--text)', fontWeight: 500 }}>
                  {label}
                </span>
              </div>
            ))}
          </div>

          <button
            onClick={install}
            disabled={installing}
            style={{
              width: '100%',
              padding: '14px',
              background: 'linear-gradient(135deg, #16A34A, #15803D)',
              color: '#fff',
              border: 'none',
              borderRadius: 14,
              fontSize: '0.95rem',
              fontWeight: 700,
              cursor: installing ? 'wait' : 'pointer',
              opacity: installing ? 0.75 : 1,
              boxShadow: '0 4px 20px rgba(22,163,74,0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <Download size={18} />
            {installing ? 'Opening installer…' : 'Install App'}
          </button>
          <button
            onClick={dismiss}
            style={{
              width: '100%',
              marginTop: 10,
              padding: '12px',
              background: 'transparent',
              color: 'var(--text-secondary, #94a3b8)',
              border: 'none',
              borderRadius: 14,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Not now
          </button>
        </div>
      </div>

      <style>{`
        @keyframes installSlideUp {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes installFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        /* Mobile: bottom sheet */
        .install-banner-card {
          bottom: 0;
          left: 0;
          right: 0;
          border-radius: 24px 24px 0 0;
          border-bottom: none;
          padding-bottom: env(safe-area-inset-bottom, 0px);
        }
        /* Desktop: corner card, no backdrop */
        @media (min-width: 768px) {
          .install-banner-backdrop { display: none; }
          .install-banner-card {
            left: auto;
            right: 24px;
            bottom: 24px;
            width: 380px;
            border-radius: 20px;
            border-bottom: 1px solid var(--border);
            animation: installSlideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .install-banner-card, .install-banner-backdrop { animation: none; }
        }
      `}</style>
    </>
  );
}
