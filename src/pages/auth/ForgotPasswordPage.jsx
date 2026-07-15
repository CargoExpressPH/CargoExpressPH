import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  Container, Mail, Loader,
  ArrowLeft, Send, AlertTriangle, RefreshCw, Inbox,
  Ship, DollarSign, Search, Zap, Package,
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

/* ══════════════════════════════════════════════════════════════════════════
   ForgotPasswordPage — World-Class Premium Redesign
══════════════════════════════════════════════════════════════════════════ */
const ForgotPasswordPage = () => {
  usePageTitle('Forgot Password');
  const [email,     setEmail]     = useState('');
  const [sent,      setSent]      = useState(false);
  const [error,     setError]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const [countdown, setCountdown] = useState(0);
  const { resetPassword } = useAuth();
  const timerRef  = useRef(null);

  // Clear resend countdown timer when leaving the screen.
  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const startCountdown = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCountdown(60);
    timerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) { clearInterval(timerRef.current); timerRef.current = null; return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    const emailTrimmed = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailTrimmed)) {
      setError('Please enter a valid email address (e.g. name@domain.com).');
      return;
    }

    setLoading(true);
    try {
      const result = await resetPassword(emailTrimmed);
      if (!result.success) throw new Error(result.error || 'Could not send reset email');
      setSent(true);
      startCountdown();
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    }
    setLoading(false);
  };

  const handleResend = async () => {
    if (countdown > 0) return;
    setLoading(true);
    try {
      const result = await resetPassword(email.trim());
      if (!result.success) throw new Error(result.error || 'Could not send reset email');
      startCountdown();
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  /* ── Countdown ring progress (0–100%) ── */
  const ringProgress = countdown > 0 ? (countdown / 60) * 100 : 0;

  return (
    <div className="login-split-page">

      {/* Modern Mesh Gradient Background */}
      <div className="auth-mesh-bg" aria-hidden="true">
        <div className="auth-mesh-orb auth-mesh-orb-1" />
        <div className="auth-mesh-orb auth-mesh-orb-2" />
        <div className="auth-mesh-orb auth-mesh-orb-3" />
      </div>

      {/* LEFT PANEL — Branding */}
      <div className="login-left-panel" aria-hidden="true">
        <div className="login-left-content">
          <div className="login-brand" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Container size={28} color="var(--primary)" />
            <h1 style={{ display: 'flex', gap: 4, margin: 0, fontSize: '2rem', fontWeight: 900 }}>
              <span style={{ color: '#fff' }}>CARGO</span>
              <span style={{ color: 'var(--primary-light)' }}>EXPRESS</span>
            </h1>
          </div>

          <h2 className="login-tagline">
            Fast &amp; Reliable<br />Cargo Delivery
          </h2>
          <p className="login-tagline-sub">
            Connecting Bohol and Manila with safe,<br />
            affordable sea cargo shipping.
          </p>

          <div className="login-route-pills">
            <div className="login-route-pill">
              <Ship size={14} /> Bohol → Manila
            </div>
            <div className="login-route-pill">
              <Ship size={14} /> Manila → Bohol
            </div>
          </div>

          <div className="login-features">
            {[
              { icon: Package,    text: 'Door-to-door delivery' },
              { icon: Search,     text: 'Real-time tracking' },
              { icon: DollarSign, text: 'Affordable per-kilo rates' },
              { icon: Zap,        text: 'Fast and reliable service' },
            ].map((f, i) => (
              <div key={i} className="login-feature-item">
                <div className="login-feature-icon-wrap"><f.icon size={14} /></div>
                {f.text}
              </div>
            ))}
          </div>
        </div>

        <div className="login-left-footer">
          <div>© {new Date().getFullYear()} CargoExpress PH. All rights reserved.</div>
        </div>
      </div>

      {/* RIGHT PANEL — Reset Form */}
      <div className="login-right-panel">
        <div className="login-form-container animate-slide-up">

          <div className="login-mobile-brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Container size={20} color="var(--primary)" />
            <span style={{ display: 'inline-flex', gap: 4, fontWeight: 900, fontSize: '1.25rem' }}>
              <span className="text-accent">CARGO</span>
              <span className="text-primary">EXPRESS</span>
            </span>
          </div>

        {/* ── Send state ── */}
        {!sent ? (
          <div className="animate-slide-up">

            {/* Icon + heading */}
            <div className="fp-hero">
              <div className="fp-hero-icon">
                <Mail size={26} />
              </div>
              <h2 className="fp-title">Reset Password</h2>
              <p className="fp-subtitle">
                Enter the email linked to your account and we'll send you a secure reset link.
              </p>
            </div>

            {error && (
              <div className="auth-error-banner" role="alert">
                <AlertTriangle size={15} />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate>
              <div className="form-group">
                <label className="form-label" htmlFor="forgot-email">
                  Email Address
                </label>
                <div className="form-input-wrapper">
                  <Mail size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="forgot-email"
                    type="email"
                    className="form-input form-input-icon-left"
                    placeholder="you@email.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    aria-required="true"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="auth-submit-btn"
                disabled={loading || !email.trim()}
                aria-busy={loading}
              >
                {loading
                  ? <><Loader size={16} className="animate-spin" /> Sending…</>
                  : <><Send size={16} /> Send Reset Link</>
                }
              </button>
            </form>

            {/* Tips box */}
            <div className="fp-tips-box">
              <p className="fp-tips-label">What happens next?</p>
              <div className="fp-tips-list">
                <div className="fp-tip-item">
                  <div className="fp-tip-dot">1</div>
                  <span>We send a secure link to your inbox</span>
                </div>
                <div className="fp-tip-item">
                  <div className="fp-tip-dot">2</div>
                  <span>Click the link to set a new password</span>
                </div>
                <div className="fp-tip-item">
                  <div className="fp-tip-dot">3</div>
                  <span>Sign in with your new credentials</span>
                </div>
              </div>
            </div>

            <div className="auth-card-footer">
              <p>Remember your password? <Link to="/login" className="auth-link">Sign In</Link></p>
            </div>
          </div>

        ) : (
          /* ── Success / Sent state ── */
          <div className="animate-slide-up">
            <div className="fp-sent-hero">

              {/* Animated envelope icon */}
              <div className="fp-sent-icon-wrap">
                <div className="fp-sent-ring" aria-hidden="true" />
                <div className="fp-sent-icon">
                  <Inbox size={32} />
                </div>
              </div>

              <h2 className="fp-title">Check Your Inbox</h2>
              <p className="fp-subtitle">
                We've sent a reset link to{' '}
                <strong className="fp-email-highlight">{email}</strong>
                . Check your spam folder if you don't see it.
              </p>
            </div>

            {error && (
              <div className="auth-error-banner" role="alert">
                <AlertTriangle size={15} />
                <span>{error}</span>
              </div>
            )}

            {/* Resend row */}
            <div className="fp-resend-row">
              <span className="fp-resend-label">Didn't receive it?</span>
              <button
                onClick={handleResend}
                className="fp-resend-btn"
                disabled={countdown > 0 || loading}
                aria-live="polite"
              >
                {loading
                  ? <><Loader size={13} className="animate-spin" /> Sending…</>
                  : countdown > 0
                    ? <><RefreshCw size={13} /> Resend in {countdown}s</>
                    : <><RefreshCw size={13} /> Resend Email</>
                }
              </button>
            </div>

            {/* Countdown progress bar */}
            {countdown > 0 && (
              <div className="fp-countdown-bar" aria-hidden="true">
                <div
                  className="fp-countdown-fill"
                  style={{ width: `${ringProgress}%` }}
                />
              </div>
            )}

            <Link to="/login" className="auth-submit-btn text-no-underline mt-20">
              <ArrowLeft size={16} /> Back to Sign In
            </Link>

            <div className="auth-card-footer">
              <p>Wrong email? <button
                className="auth-link bg-none border-none cursor-pointer p-0"
                style={{ font: 'inherit' }}
                onClick={() => { setSent(false); setError(''); setCountdown(0); if (timerRef.current) clearInterval(timerRef.current); }}
              >Try again</button></p>
            </div>
          </div>
        )}
      </div>
      </div>
      </div>
  );
};

export default ForgotPasswordPage;
