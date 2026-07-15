import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  Container, Lock, Loader, CheckCircle2,
  Eye, EyeOff, ShieldCheck, AlertTriangle, Check,
  ArrowLeft,
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { getPasswordStrength } from '../../utils/password';

/* ══════════════════════════════════════════════════════════════════════════
   ResetPasswordPage — World-Class Premium Redesign
══════════════════════════════════════════════════════════════════════════ */
const ResetPasswordPage = () => {
  usePageTitle('Reset Password');
  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword,    setShowPassword]    = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState('');
  const [success,         setSuccess]         = useState(false);
  const [ready,           setReady]           = useState(false);
  const { changePassword } = useAuth();
  const navigate = useNavigate();

  // Give Supabase time to process the recovery token from the URL hash
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  const pwStrength = getPasswordStrength(password);

  const checks = {
    length:    password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number:    /[0-9]/.test(password),
  };
  const allChecks = Object.values(checks).every(Boolean);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!allChecks)               return setError('Password does not meet all requirements.');
    if (password !== confirmPassword) return setError('Passwords do not match.');
    setLoading(true);
    try {
      const result = await changePassword(password);
      if (result?.error) {
        setError(result.error);
      } else {
        setSuccess(true);
        setTimeout(() => navigate('/login'), 3000);
      }
    } catch (err) {
      setError(err.message || 'Failed to update password. Please try again.');
    }
    setLoading(false);
  };

  /* ── Verifying token state ── */
  if (!ready) {
    return (
      <div className="auth-page">
        <div className="auth-orb auth-orb-1" aria-hidden="true" />
        <div className="auth-orb auth-orb-2" aria-hidden="true" />
        <div className="auth-card rp-loading-card">
          <div className="auth-brand" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            <Container size={22} color="var(--primary)" />
            <div className="auth-brand-text" style={{ display: 'inline-flex', gap: 4, fontSize: '1.5rem', fontWeight: 900 }}>
              <span className="text-accent">CARGO</span>
              <span className="text-primary">EXPRESS</span>
            </div>
          </div>
          <div className="rp-verifying">
            <div className="rp-verifying-spinner">
              <Loader size={28} className="animate-spin" />
            </div>
            <p className="rp-verifying-text">Verifying your reset link…</p>
            <p className="rp-verifying-sub">This only takes a moment</p>
          </div>
        </div>
      </div>
    );
  }

  /* ── Success state ── */
  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-orb auth-orb-1" aria-hidden="true" />
        <div className="auth-orb auth-orb-2" aria-hidden="true" />
        <div className="auth-card auth-success-card">
          <div className="auth-success-icon">
            <CheckCircle2 size={48} />
          </div>
          <h2 className="auth-success-title">Password Updated!</h2>
          <p className="auth-success-sub">
            Your new password is set. Redirecting you to sign in…
          </p>
          <div className="auth-success-loader">
            <div className="auth-success-bar" />
          </div>
          <Link to="/login" className="auth-submit-btn text-no-underline mt-12">
            Go to Sign In
          </Link>
        </div>
      </div>
    );
  }

  /* ── Main reset form ── */
  return (
    <div className="auth-page">
      <div className="auth-orb auth-orb-1" aria-hidden="true" />
      <div className="auth-orb auth-orb-2" aria-hidden="true" />
      <div className="auth-orb auth-orb-3" aria-hidden="true" />

      <div className="auth-card fp-card">

        <div className="auth-brand" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
          <Container size={22} color="var(--primary)" />
          <div className="auth-brand-text" style={{ display: 'inline-flex', gap: 4, fontSize: '1.5rem', fontWeight: 900 }}>
            <span className="text-accent">CARGO</span>
            <span className="text-primary">EXPRESS</span>
          </div>
        </div>

        <div className="animate-slide-up">

          {/* Icon + heading */}
          <div className="fp-hero">
            <div className="fp-hero-icon fp-hero-icon-lock">
              <Lock size={26} />
            </div>
            <h2 className="fp-title">Set New Password</h2>
            <p className="fp-subtitle">
              Choose a strong password to keep your account secure.
            </p>
          </div>

          {error && (
            <div className="auth-error-banner" role="alert">
              <AlertTriangle size={15} />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate>

            {/* New password */}
            <div className="form-group">
              <label className="form-label" htmlFor="reset-password">
                New Password <span className="required">*</span>
              </label>
              <div className="form-input-wrapper">
                <Lock size={15} className="form-input-icon" aria-hidden="true" />
                <input
                  id="reset-password"
                  type={showPassword ? 'text' : 'password'}
                  className="form-input form-input-icon-left form-input-icon-right"
                  placeholder="Min. 8 characters"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  aria-required="true"
                  aria-describedby="rp-strength"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="form-pw-toggle"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>

              {/* Strength meter */}
              {password && (
                <div className="pw-strength-wrap" id="rp-strength" aria-live="polite">
                  <div className="pw-strength-bars">
                    {[1,2,3,4].map(i => (
                      <div
                        key={i}
                        className="pw-strength-bar"
                        style={{ background: i <= pwStrength.level ? pwStrength.color : 'var(--border)' }}
                      />
                    ))}
                  </div>
                  <span className="pw-strength-label" style={{ color: pwStrength.color }}>
                    {pwStrength.label}
                  </span>
                </div>
              )}
            </div>

            {/* Requirements card */}
            {password && (
              <div className="rp-requirements" role="list" aria-label="Password requirements">
                {[
                  { key: 'length',    label: '8+ characters'    },
                  { key: 'uppercase', label: 'Uppercase letter'  },
                  { key: 'lowercase', label: 'Lowercase letter'  },
                  { key: 'number',    label: 'Number'            },
                ].map(({ key, label }) => (
                  <div
                    key={key}
                    className={`rp-requirement-item ${checks[key] ? 'met' : ''}`}
                    role="listitem"
                    aria-label={`${label}: ${checks[key] ? 'met' : 'not met'}`}
                  >
                    <div className="rp-req-icon">
                      <Check size={10} strokeWidth={3} />
                    </div>
                    {label}
                  </div>
                ))}
              </div>
            )}

            {/* Confirm password */}
            <div className="form-group">
              <label className="form-label" htmlFor="reset-confirm-password">
                Confirm Password <span className="required">*</span>
              </label>
              <div className="form-input-wrapper">
                <Lock size={15} className="form-input-icon" aria-hidden="true" />
                <input
                  id="reset-confirm-password"
                  type={showConfirm ? 'text' : 'password'}
                  className={`form-input form-input-icon-left form-input-icon-right ${
                    confirmPassword && confirmPassword === password ? 'success' :
                    confirmPassword && confirmPassword !== password ? 'error' : ''
                  }`}
                  placeholder="Repeat new password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  aria-required="true"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(!showConfirm)}
                  className="form-pw-toggle"
                  aria-label={showConfirm ? 'Hide password' : 'Show password'}
                  aria-pressed={showConfirm}
                >
                  {showConfirm ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="form-error">Passwords don't match</p>
              )}
              {confirmPassword && password === confirmPassword && allChecks && (
                <p className="rp-match-ok">
                  <CheckCircle2 size={13} /> Passwords match
                </p>
              )}
            </div>

            <button
              type="submit"
              className="auth-submit-btn"
              disabled={loading || !allChecks || password !== confirmPassword}
              aria-busy={loading}
            >
              {loading
                ? <><Loader size={16} className="animate-spin" /> Updating…</>
                : <><ShieldCheck size={16} /> Update Password</>
              }
            </button>
          </form>

          <div className="auth-card-footer">
            <p>
              <Link to="/login" className="auth-link">
                <ArrowLeft size={12} style={{ verticalAlign: 'middle', marginRight: 2 }} />
                Back to Sign In
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
