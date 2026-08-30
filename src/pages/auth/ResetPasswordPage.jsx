import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  Lock, Loader, CheckCircle2,
  Eye, EyeOff, ShieldCheck, AlertTriangle, Check,
  ArrowLeft, KeyRound,
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { getPasswordStrength } from '../../utils/password';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { fieldAttrs, invalidClass } from '../../components/ui/FieldError';
import { BrandLogo, BrandWordmark } from '../../components/ui/BrandLogo';

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
  // Set once verification finishes with no usable session — the link is
  // missing, malformed, expired, or already used. Distinct from `ready`,
  // which only means "we're done checking," not "the link was good."
  const [linkInvalid,     setLinkInvalid]     = useState(false);
  const { changePassword, logout, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  // Cross-tab recovery: the email client opens the recovery link in a new
  // tab, but Supabase's PASSWORD_RECOVERY event also fires in whichever tab
  // the user originally had open, so both tabs land on this page with a
  // session. Once the user finishes the reset in one tab, that tab logs the
  // session out — which, thanks to the shared Supabase auth state, signs the
  // *other* tab out too, stranding it here mid-flow. If this tab is done
  // loading, has no user, and never completed its own reset (`success`),
  // that's exactly what happened, so send it to /login instead of leaving it
  // stuck on a dead form.
  useEffect(() => {
    if (!authLoading && !user && !success) {
      navigate('/login');
    }
  }, [user, authLoading, success, navigate]);

  // Shared by the 3s auto-redirect and the manual "Go to Sign In" button so
  // both paths behave identically: the recovery link left an active Supabase
  // session, and it must be destroyed before navigating to /login, otherwise
  // AuthRoute sees a logged-in user and bounces them to their dashboard
  // instead of the login form where they can confirm the new password. The
  // ref guards against running it twice if the button is clicked just before
  // the timeout fires.
  const navigatedAwayRef = useRef(false);
  const goToSignIn = useCallback(async () => {
    if (navigatedAwayRef.current) return;
    navigatedAwayRef.current = true;
    await logout();
    // Recovery links opened by an email client are almost always a
    // browser-opened tab (not one the user navigated to directly), so
    // window.close() is usually allowed to self-close it here — dropping the
    // user seamlessly back onto their original tab, which the effect above
    // will already be redirecting to /login. If the browser blocks the
    // close (it silently no-ops rather than throwing), just fall through to
    // navigating this tab to /login as before.
    window.close();
    navigate('/login');
  }, [logout, navigate]);

  // Verify there is an actual usable session instead of assuming a flat delay
  // was enough. Two things can produce one here:
  //   1. `getSession()` already reflects it — the GoTrue client parses a
  //      recovery link's token out of the URL hash at construction time
  //      (detectSessionInUrl), which on this route usually finishes before
  //      this page even mounts (the client is a module-level singleton
  //      created well before routing).
  //   2. It hasn't finished yet — PASSWORD_RECOVERY (or any event carrying a
  //      session) fires once processing completes, covering the case where
  //      this effect subscribed just ahead of it.
  // If neither ever produces a session, the link itself is bad (expired,
  // already used, or the hash never had one), and the customer is told that
  // immediately instead of being handed a form that can only fail at submit.
  useEffect(() => {
    let cancelled = false;
    let settled = false;

    const settle = (valid) => {
      if (cancelled || settled) return;
      settled = true;
      setReady(true);
      setLinkInvalid(!valid);
    };

    supabase.auth.getSession()
      .then(({ data }) => { if (data?.session) settle(true); })
      .catch(() => {});

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        settle(true);
      }
    });

    const timer = setTimeout(() => settle(false), 4000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, []);

  const pwStrength = getPasswordStrength(password);

  const checks = {
    length:    password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number:    /[0-9]/.test(password),
  };
  const allChecks = Object.values(checks).every(Boolean);

  const { errors, validate, clearError } = useFieldErrors();

  // Mismatch is worth flagging while typing; an untouched confirm field is not
  // yet a mistake. Submit-time errors win — they explain this attempt.
  const shownErrors = {
    ...(confirmPassword && password !== confirmPassword
      ? { confirm_password: "Passwords don't match." }
      : {}),
    ...errors,
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const ok = validate({
      password: !password
        ? 'Please enter a new password.'
        : !allChecks
          ? 'Password does not meet all the requirements listed below.'
          : null,
      confirm_password: !confirmPassword
        ? 'Please repeat your new password.'
        : password !== confirmPassword
          ? "Passwords don't match."
          : null,
    });
    if (!ok) return;

    setLoading(true);
    try {
      const result = await changePassword(password);
      if (result?.error) {
        setError(result.error);
        setLoading(false);
      } else {
        // Not clearing `loading` here: `success` now takes over rendering
        // via the early-return below, and this page never reads `loading`
        // again — clearing it would risk a frame of the un-loading form
        // before that switch (and before the 3s-delayed navigate away).
        setSuccess(true);
        setTimeout(goToSignIn, 3000);
      }
    } catch (err) {
      setError(err.message || 'Failed to update password. Please try again.');
      setLoading(false);
    }
  };

  /* ── Verifying token state ── */
  if (!ready) {
    return (
      <div className="auth-page">
        <div className="auth-orb auth-orb-1" aria-hidden="true" />
        <div className="auth-orb auth-orb-2" aria-hidden="true" />
        <div className="auth-card rp-loading-card">
          <div className="auth-brand flex flex-row items-center justify-center" style={{ gap: 8 }}>
            <BrandLogo size={34} decorative />
            <div className="auth-brand-text"><BrandWordmark /></div>
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

  /* ── Invalid / expired link state ── */
  if (linkInvalid) {
    return (
      <div className="auth-page">
        <div className="auth-orb auth-orb-1" aria-hidden="true" />
        <div className="auth-orb auth-orb-2" aria-hidden="true" />
        <div className="auth-card fp-card">
          <div className="auth-brand flex flex-row items-center justify-center" style={{ gap: 8 }}>
            <BrandLogo size={34} decorative />
            <div className="auth-brand-text"><BrandWordmark /></div>
          </div>
          <div className="fp-hero">
            <div className="fp-hero-icon fp-hero-icon-error">
              <KeyRound size={26} />
            </div>
            <h1 className="fp-title">Link Expired or Invalid</h1>
            <p className="fp-subtitle">
              This password reset link is no longer valid — it may have already been used, or it has expired.
              Request a new one and we'll send a fresh link.
            </p>
          </div>
          <Link to="/forgot-password" className="auth-submit-btn text-no-underline mt-12">
            Request New Link
          </Link>
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
          <h1 className="auth-success-title">Password Updated!</h1>
          <p className="auth-success-sub">
            Your new password is set. Redirecting you to sign in…
          </p>
          <div className="auth-success-loader">
            <div className="auth-success-bar" />
          </div>
          <button type="button" onClick={goToSignIn} className="auth-submit-btn text-no-underline mt-12">
            Go to Sign In
          </button>
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

        <div className="auth-brand flex flex-row items-center justify-center" style={{ gap: 8 }}>
          <BrandLogo size={34} decorative />
          <div className="auth-brand-text"><BrandWordmark /></div>
        </div>

        <div className="animate-slide-up">

          {/* Icon + heading */}
          <div className="fp-hero">
            <div className="fp-hero-icon fp-hero-icon-lock">
              <Lock size={26} />
            </div>
            <h1 className="fp-title">Set New Password</h1>
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
                  className={`form-input form-input-icon-left form-input-icon-right ${invalidClass('password', errors)}`}
                  placeholder="Min. 8 characters"
                  value={password}
                  onChange={e => { setPassword(e.target.value); clearError('password'); }}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  aria-required="true"
                  {...fieldAttrs('password', errors, 'rp-strength')}
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
              <FieldError name="password" errors={errors} />

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
                    shownErrors.confirm_password ? 'field-invalid' :
                    confirmPassword && confirmPassword === password ? 'success' : ''
                  }`}
                  placeholder="Repeat new password"
                  value={confirmPassword}
                  onChange={e => { setConfirmPassword(e.target.value); clearError('confirm_password'); }}
                  required
                  autoComplete="new-password"
                  aria-required="true"
                  {...fieldAttrs('confirm_password', shownErrors)}
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
              <FieldError name="confirm_password" errors={shownErrors} />
              {!shownErrors.confirm_password && confirmPassword && password === confirmPassword && allChecks && (
                <p className="rp-match-ok">
                  <CheckCircle2 size={13} /> Passwords match
                </p>
              )}
            </div>

            <button
              type="submit"
              className="auth-submit-btn"
              disabled={loading}
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
