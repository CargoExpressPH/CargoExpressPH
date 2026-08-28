import { useState, useEffect, useCallback } from 'react';
import { X, Download, Zap, Bell, Smartphone, ShieldCheck } from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────
const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent);
const isInStandaloneMode = () =>
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

const DISMISSED_KEY = 'install_banner_dismissed';
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Capture the browser event as soon as this module is loaded. The event is
// one-shot, so waiting for an authenticated layout to mount can lose it after
// a clean visit to /login. The root App imports this module eagerly and the
// banner subscribes to the small in-memory store below when it mounts.
let pendingInstallPrompt = null;
const installPromptSubscribers = new Set();

const notifyInstallPromptSubscribers = () => {
  installPromptSubscribers.forEach((subscriber) => subscriber(pendingInstallPrompt));
};

const handleBeforeInstallPrompt = (event) => {
  event.preventDefault();
  pendingInstallPrompt = event;
  notifyInstallPromptSubscribers();
};

const handleAppInstalled = () => {
  pendingInstallPrompt = null;
  notifyInstallPromptSubscribers();
  try { localStorage.setItem('pwa_installed', 'true'); } catch { /* private browsing */ }
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  window.addEventListener('appinstalled', handleAppInstalled);
}

const subscribeToInstallPrompt = (subscriber) => {
  installPromptSubscribers.add(subscriber);
  subscriber(pendingInstallPrompt);
  return () => installPromptSubscribers.delete(subscriber);
};

function wasDismissedRecently() {
  try {
    const ts = parseInt(localStorage.getItem(DISMISSED_KEY) || '0', 10);
    return Date.now() - ts < DISMISS_DURATION_MS;
  } catch {
    return false;
  }
}

/**
 * Why installing is worth it. Four claims, each one true of this build:
 *
 *   One tap      — an installed PWA opens standalone from the home screen.
 *   Live alerts  — FCM + VAPID web push, fired on every status change.
 *   Under 2 MB   — the service worker precaches ~1.5 MB (measured against the
 *                  build's PRECACHE_ASSETS). "Installs in" is deliberate: what
 *                  the install itself stores, not the lifetime cache, which
 *                  grows as route chunks and images load on demand.
 *   Never stored — card and wallet details go to PayMongo, never to us. The
 *                  same promise is printed on the Payment History page.
 *
 * There is still no offline claim, and there should not be one: the service
 * worker precaches the app shell so a reopen is fast, but orders, tracking and
 * payments are live Supabase reads that fail without a network. The removed
 * "Keeps working when your connection drops" promised an offline mode this app
 * does not have — do not let a rewrite quietly reintroduce it.
 *
 * Keep labels to roughly 50 characters. The desktop card is 380px wide, which
 * is about 32 characters a line; past two lines per perk the Install button
 * starts getting pushed off a small phone screen.
 */
const perks = [
  { icon: Zap, label: 'One tap from your home screen — no URL to type' },
  { icon: Bell, label: 'Know the moment your cargo moves, in real time' },
  { icon: Smartphone, label: 'Installs in under 2 MB — a fraction of a normal app' },
  { icon: ShieldCheck, label: 'Secure GCash checkout, card details never stored' },
];

// ── Component ────────────────────────────────────────────────────────────────

/**
 * InstallAppBanner
 *
 * Android / Windows / macOS install prompt. Chromium fires
 * `beforeinstallprompt` only when the app already meets every installability
 * criterion. The event is captured at module load and this banner subscribes
 * to it, so route/authentication timing cannot make the prompt disappear.
 *
 * iOS is handled separately by IosInstallBanner (Safari has no install event).
 */
export default function InstallAppBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState(() => pendingInstallPrompt);
  const [visible, setVisible] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    // Never compete with IosInstallBanner, and never nag an installed user
    if (isIos() || isInStandaloneMode()) return;

    let showTimer;
    const handlePrompt = (event) => {
      window.clearTimeout(showTimer);
      setDeferredPrompt(event);
      setVisible(false);

      if (!event || wasDismissedRecently()) return;
      // Delay so it doesn't fight with first paint.
      showTimer = window.setTimeout(() => setVisible(true), 3000);
    };

    const unsubscribe = subscribeToInstallPrompt(handlePrompt);

    return () => {
      unsubscribe();
      window.clearTimeout(showTimer);
    };
  }, []);

  const dismiss = useCallback(() => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* private browsing */ }
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        dismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, dismiss]);

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
      {/* Backdrop — mobile only; desktop shows a corner card instead.
          Decorative: keyboard users dismiss via Escape or the Close/Not-now buttons. */}
      <div
        onClick={dismiss}
        aria-hidden="true"
        className="install-banner-backdrop fixed"
        style={{inset: 0,
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(4px)',
          zIndex: 9998,
          animation: 'installFadeIn 0.3s ease',
        }}
      />

      <div
        role="dialog"
        aria-label="Install CargoExpress PH"
        className="install-banner-card fixed"
        style={{zIndex: 9999,
          background: 'var(--surface, #1e293b)',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.4)',
          border: '1px solid var(--border)',
          animation: 'installSlideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        <div className="relative" style={{ padding: '20px 24px 24px',}}>
          <button
            onClick={dismiss}
            aria-label="Close install prompt"
            className="absolute w-32 h-32 flex items-center justify-center cursor-pointer"
            style={{top: 4,
              right: 20,
              background: 'var(--bg-secondary)',
              border: 'none',
              borderRadius: '50%',
              color: 'var(--text-secondary, #94a3b8)',
            }}
          >
            <X size={16} />
          </button>

          {/* Header */}
          <div className="flex items-center" style={{gap: 14, marginBottom: 18, paddingRight: 40}}>
            <div className="flex items-center justify-center" style={{
              width: 52,
              height: 52,
              borderRadius: 12,
              background: 'linear-gradient(135deg, #16A34A, #15803D)',
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
          <div className="flex flex-col" style={{gap: 10, marginBottom: 20}}>
            {perks.map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center" style={{gap: 12,
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
            className="w-full flex items-center justify-center"
            style={{padding: '14px',
              background: 'linear-gradient(135deg, #16A34A, #15803D)',
              color: '#fff',
              border: 'none',
              borderRadius: 14,
              fontSize: '0.95rem',
              fontWeight: 700,
              cursor: installing ? 'wait' : 'pointer',
              opacity: installing ? 0.75 : 1,
              boxShadow: '0 4px 20px rgba(22,163,74,0.4)',
              gap: 8,
            }}
          >
            <Download size={18} />
            {installing ? 'Opening installer…' : 'Install App'}
          </button>
          <button
            onClick={dismiss}
            className="w-full cursor-pointer"
            style={{marginTop: 10,
              padding: '12px',
              background: 'transparent',
              color: 'var(--text-secondary, #94a3b8)',
              border: 'none',
              borderRadius: 14,
              fontSize: '0.85rem',
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
