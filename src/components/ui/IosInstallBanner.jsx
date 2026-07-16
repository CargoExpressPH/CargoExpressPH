import { useState, useEffect } from 'react';
import { X, Share, PlusSquare, Bell, Smartphone } from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────
const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent);
const isInStandaloneMode = () =>
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
const getIosVersion = () => {
  const match = window.navigator.userAgent.match(/OS (\d+)_/);
  return match ? parseInt(match[1], 10) : 0;
};

const DISMISSED_KEY = 'ios_install_banner_dismissed';
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function wasDismissedRecently() {
  try {
    const ts = parseInt(localStorage.getItem(DISMISSED_KEY) || '0', 10);
    return Date.now() - ts < DISMISS_DURATION_MS;
  } catch {
    return false;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * IosInstallBanner
 *
 * Shown ONLY to iOS Safari users who have NOT yet installed the PWA.
 * iOS 16.4+ supports Web Push, but ONLY when installed to Home Screen.
 * This banner guides users through the install flow.
 */
export default function IosInstallBanner() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(1); // 1 = prompt, 2 = instructions
  const iosVersion = getIosVersion();
  const pushSupported = iosVersion >= 16;

  useEffect(() => {
    // Only show on iOS Safari, not installed, not dismissed recently
    if (isIos() && !isInStandaloneMode() && !wasDismissedRecently()) {
      // Delay slightly so it doesn't flash on load
      const timer = setTimeout(() => setVisible(true), 3000);
      return () => clearTimeout(timer);
    }
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch {}
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={dismiss}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(4px)',
          zIndex: 9998,
          animation: 'fadeIn 0.3s ease',
        }}
      />

      {/* Banner card — slides up from bottom */}
      <div
        role="dialog"
        aria-label="Install CargoExpress PH"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: 'var(--surface, #1e293b)',
          borderRadius: '24px 24px 0 0',
          padding: '0 0 env(safe-area-inset-bottom, 16px)',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.4)',
          animation: 'slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderBottom: 'none',
        }}
      >
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12 }}>
          <div style={{
            width: 40, height: 4,
            borderRadius: 2,
            background: 'rgba(255,255,255,0.2)',
          }} />
        </div>

        <div style={{ padding: '16px 24px 24px' }}>
          {/* Close */}
          <button
            onClick={dismiss}
            aria-label="Close install banner"
            style={{
              position: 'absolute',
              top: 20,
              right: 20,
              background: 'rgba(255,255,255,0.08)',
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

          {step === 1 ? (
            // ── Step 1: Why install? ─────────────────────────────────────
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
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
                  <Smartphone size={26} color="#fff" />
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary, #f1f5f9)' }}>
                    Install CargoExpress PH
                  </h2>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary, #94a3b8)', marginTop: 2 }}>
                    Get the full app experience on iPhone
                  </p>
                </div>
              </div>

              {/* Feature pills */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
                {[
                  { icon: Bell, label: pushSupported ? '🔔 Push notifications for shipment updates' : '📦 Faster loading & offline access' },
                  { icon: null, label: '⚡ Lightning-fast app-like experience' },
                  { icon: null, label: '📱 Works from your Home Screen like a native app' },
                ].map((item, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 14px',
                    background: 'rgba(22,163,74,0.08)',
                    borderRadius: 10,
                    border: '1px solid rgba(22,163,74,0.15)',
                  }}>
                    <span style={{ fontSize: '0.875rem', color: 'var(--text-primary, #f1f5f9)', fontWeight: 500 }}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>

              {pushSupported && (
                <div style={{
                  padding: '10px 14px',
                  background: 'rgba(234,179,8,0.1)',
                  borderRadius: 10,
                  border: '1px solid rgba(234,179,8,0.2)',
                  marginBottom: 20,
                  fontSize: '0.8rem',
                  color: '#fbbf24',
                  lineHeight: 1.5,
                }}>
                  ⚠️ <strong>iOS requires installation</strong> before push notifications can be enabled — this is an Apple requirement.
                </div>
              )}

              <button
                id="ios-install-show-steps-btn"
                onClick={() => setStep(2)}
                style={{
                  width: '100%',
                  padding: '14px',
                  background: 'linear-gradient(135deg, #16A34A, #15803D)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 14,
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 4px 20px rgba(22,163,74,0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <PlusSquare size={18} />
                Show Me How to Install
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
                Maybe later
              </button>
            </>
          ) : (
            // ── Step 2: How to install ───────────────────────────────────
            <>
              <h2 style={{ margin: '0 0 6px', fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary, #f1f5f9)', paddingRight: 36 }}>
                How to Install on iPhone
              </h2>
              <p style={{ margin: '0 0 20px', fontSize: '0.8rem', color: 'var(--text-secondary, #94a3b8)' }}>
                Follow these 3 quick steps in Safari:
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
                {[
                  {
                    step: 1,
                    icon: <Share size={22} color="#3b82f6" />,
                    title: 'Tap the Share button',
                    desc: 'Tap the share icon (□↑) at the bottom of Safari',
                    bg: 'rgba(59,130,246,0.1)',
                    border: 'rgba(59,130,246,0.2)',
                  },
                  {
                    step: 2,
                    icon: <PlusSquare size={22} color="#16a34a" />,
                    title: 'Tap "Add to Home Screen"',
                    desc: 'Scroll down in the share menu and tap this option',
                    bg: 'rgba(22,163,74,0.1)',
                    border: 'rgba(22,163,74,0.2)',
                  },
                  {
                    step: 3,
                    icon: <Bell size={22} color="#f59e0b" />,
                    title: 'Open & enable notifications',
                    desc: 'Launch from Home Screen, then enable push notifications when prompted',
                    bg: 'rgba(245,158,11,0.1)',
                    border: 'rgba(245,158,11,0.2)',
                  },
                ].map((item) => (
                  <div key={item.step} style={{
                    display: 'flex',
                    gap: 14,
                    padding: '12px 14px',
                    background: item.bg,
                    borderRadius: 12,
                    border: `1px solid ${item.border}`,
                    alignItems: 'flex-start',
                  }}>
                    <div style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      background: 'rgba(0,0,0,0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      {item.icon}
                    </div>
                    <div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary, #f1f5f9)', marginBottom: 2 }}>
                        Step {item.step}: {item.title}
                      </div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary, #94a3b8)', lineHeight: 1.5 }}>
                        {item.desc}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Animated arrow pointing down toward Safari's share button */}
              <div style={{
                textAlign: 'center',
                padding: '8px',
                marginBottom: 16,
                animation: 'bounce 1.5s infinite',
                color: '#3b82f6',
                fontSize: '1.5rem',
              }}>
                ↓
              </div>

              <button
                onClick={dismiss}
                style={{
                  width: '100%',
                  padding: '13px',
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--text-secondary, #94a3b8)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 14,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Got it, I'll install it
              </button>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(6px); }
        }
      `}</style>
    </>
  );
}
