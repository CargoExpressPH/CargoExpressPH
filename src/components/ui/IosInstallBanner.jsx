import { useState, useEffect } from 'react';
import { X, Share, PlusSquare, Bell, Smartphone, Zap, Package, AlertTriangle, ArrowDown } from 'lucide-react';
import {
  isAppleMobileDevice,
  isAppleMobileWebPushVersion,
  isStandaloneWebApp,
} from '../../lib/apple-platform';

// ── Helpers ──────────────────────────────────────────────────────────────────
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
  const pushSupported = isAppleMobileWebPushVersion();

  useEffect(() => {
    // Only show on iOS Safari, not installed, not dismissed recently
    if (isAppleMobileDevice() && !isStandaloneWebApp() && !wasDismissedRecently()) {
      // Delay slightly so it doesn't flash on load
      const timer = setTimeout(() => setVisible(true), 3000);
      return () => clearTimeout(timer);
    }
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* localStorage may be blocked in private browsing */ }
    setVisible(false);
  };

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        dismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible]);

  if (!visible) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={dismiss}
        className="fixed"
        style={{inset: 0,
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
        className="fixed"
        style={{bottom: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: 'var(--surface)',
          borderRadius: '24px 24px 0 0',
          padding: '0 0 env(safe-area-inset-bottom, 16px)',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.4)',
          animation: 'slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          border: '1px solid var(--border)',
          borderBottom: 'none',
        }}
      >
        {/* Drag handle */}
        <div className="flex justify-center" style={{paddingTop: 12}}>
          <div className="w-40 h-4" style={{borderRadius: 2,
            background: 'var(--border-hover)',
          }} />
        </div>

        <div style={{ padding: '16px 24px 24px' }}>
          {/* Close */}
          <button
            onClick={dismiss}
            aria-label="Close install banner"
            className="absolute w-32 h-32 flex items-center justify-center cursor-pointer text-secondary"
            style={{top: 20,
              right: 20,
              background: 'var(--bg-secondary)',
              border: 'none',
              borderRadius: '50%',
            }}
          >
            <X size={16} />
          </button>

          {step === 1 ? (
            // ── Step 1: Why install? ─────────────────────────────────────
            <>
              <div className="flex items-center" style={{gap: 14, marginBottom: 16}}>
                <div className="flex items-center justify-center" style={{
                  width: 52,
                  height: 52,
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                  flexShrink: 0,
                  boxShadow: '0 4px 16px rgba(22,163,74,0.35)',
                }}>
                  <Smartphone size={26} color="#fff" />
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--text)' }}>
                    Install CargoExpress PH
                  </h2>
                  <p className="text-secondary" style={{ margin: 0, fontSize: '0.8rem', marginTop: 2}}>
                    Get the full app experience on iPhone
                  </p>
                </div>
              </div>

              {/* Feature pills */}
              <div className="flex flex-col" style={{gap: 10, marginBottom: 20}}>
                {[
                  pushSupported
                    ? { icon: Bell, label: 'Push notifications for shipment updates' }
                    : { icon: Package, label: 'Faster loading & offline access' },
                  { icon: Zap, label: 'Lightning-fast app-like experience' },
                  { icon: Smartphone, label: 'Works from your Home Screen like a native app' },
                ].map(({ icon: Icon, label }) => (
                  <div key={label} className="flex items-center" style={{gap: 12,
                    padding: '10px 14px',
                    background: 'rgba(var(--primary-rgb), 0.08)',
                    borderRadius: 10,
                    border: '1px solid rgba(var(--primary-rgb), 0.15)',
                  }}>
                    <Icon size={18} color="var(--primary-text)" aria-hidden="true" style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: '0.875rem', color: 'var(--text)', fontWeight: 500 }}>
                      {label}
                    </span>
                  </div>
                ))}
              </div>

              {pushSupported && (
                <div className="flex items-start" style={{
                  padding: '10px 14px',
                  background: 'rgba(var(--warning-rgb), 0.1)',
                  borderRadius: 10,
                  border: '1px solid rgba(var(--warning-rgb), 0.2)',
                  marginBottom: 20,
                  fontSize: '0.8rem',
                  color: 'var(--warning-text)',
                  lineHeight: 1.5,
                  gap: 8,
                }}>
                  <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                  <span><strong>iOS requires installation</strong> before push notifications can be enabled — this is an Apple requirement.</span>
                </div>
              )}

              <button
                id="ios-install-show-steps-btn"
                onClick={() => setStep(2)}
                className="w-full cursor-pointer flex items-center justify-center"
                style={{padding: '14px',
                  background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 14,
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  boxShadow: '0 4px 20px rgba(22,163,74,0.4)',
                  gap: 8,
                }}
              >
                <PlusSquare size={18} />
                Show Me How to Install
              </button>
              <button
                onClick={dismiss}
                className="w-full text-secondary cursor-pointer"
                style={{marginTop: 10,
                  padding: '12px',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 14,
                  fontSize: '0.85rem',
                }}
              >
                Maybe later
              </button>
            </>
          ) : (
            // ── Step 2: How to install ───────────────────────────────────
            <>
              <h2 style={{ margin: '0 0 6px', fontSize: '1rem', fontWeight: 700, color: 'var(--text)', paddingRight: 36 }}>
                How to Install on iPhone
              </h2>
              <p className="text-secondary" style={{ margin: '0 0 20px', fontSize: '0.8rem',}}>
                Follow these 3 quick steps in Safari:
              </p>

              <div className="flex flex-col" style={{gap: 12, marginBottom: 24}}>
                {[
                  {
                    step: 1,
                    icon: <Share size={22} color="var(--info)" />,
                    title: 'Tap the Share button',
                    desc: 'Tap the Share icon at the bottom of Safari',
                    bg: 'rgba(var(--info-rgb), 0.1)',
                    border: 'rgba(var(--info-rgb), 0.2)',
                  },
                  {
                    step: 2,
                    icon: <PlusSquare size={22} color="var(--primary)" />,
                    title: 'Tap "Add to Home Screen"',
                    desc: 'Scroll down in the share menu and tap this option',
                    bg: 'rgba(var(--primary-rgb), 0.1)',
                    border: 'rgba(var(--primary-rgb), 0.2)',
                  },
                  {
                    step: 3,
                    icon: <Bell size={22} color="var(--warning)" />,
                    title: 'Open & enable notifications',
                    desc: 'Launch from Home Screen, then enable push notifications when prompted',
                    bg: 'rgba(var(--warning-rgb), 0.1)',
                    border: 'rgba(var(--warning-rgb), 0.2)',
                  },
                ].map((item) => (
                  <div key={item.step} className="flex items-start" style={{gap: 14,
                    padding: '12px 14px',
                    background: item.bg,
                    borderRadius: 12,
                    border: `1px solid ${item.border}`,
                  }}>
                    <div className="flex items-center justify-center" style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      background: 'var(--bg-secondary)',
                      flexShrink: 0,
                    }}>
                      {item.icon}
                    </div>
                    <div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>
                        Step {item.step}: {item.title}
                      </div>
                      <div className="text-secondary" style={{ fontSize: '0.78rem', lineHeight: 1.5}}>
                        {item.desc}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Animated arrow pointing down toward Safari's share button */}
              <div className="flex justify-center" style={{padding: '8px',
                marginBottom: 16,
                animation: 'bounce 1.5s infinite',
                color: 'var(--info-text)',
              }}>
                <ArrowDown size={24} aria-hidden="true" />
              </div>

              <button
                onClick={dismiss}
                className="w-full text-secondary cursor-pointer"
                style={{padding: '13px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 14,
                  fontSize: '0.875rem',
                  fontWeight: 600,
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
