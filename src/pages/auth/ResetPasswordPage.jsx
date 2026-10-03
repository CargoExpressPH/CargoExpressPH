import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, initialAuthRedirectHash, initialAuthRedirectPathname } from '../../lib/supabase';
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
import {
  INVALID_RECOVERY_LINK_MESSAGE,
  clearPasswordRecoveryPending,
  hasUsedPasswordRecoveryLink,
  isUsableRecoverySession,
  markPasswordRecoveryPending,
  parsePasswordRecoveryUrl,
  rememberUsedPasswordRecoveryLink,
  stripPasswordRecoveryParams,
} from '../../lib/passwordRecovery';

const clearRecoveryQuery = () => {
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${stripPasswordRecoveryParams(window.location.search)}`,
    );
  } catch {
    // History can be unavailable in an embedded browser. Verification and
    // password update must still work even if the address bar cannot change.
  }
};

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
  const initialUrlStateRef = useRef(null);
  if (initialUrlStateRef.current === null) {
    const initialHash = typeof window === 'undefined' ? '' : (
      window.location.hash || (initialAuthRedirectPathname === '/reset-password' ? initialAuthRedirectHash : '')
    );
    initialUrlStateRef.current = parsePasswordRecoveryUrl(
      initialHash,
      typeof window === 'undefined' ? '' : window.location.search,
    );
  }
  const [ready,           setReady]           = useState(Boolean(initialUrlStateRef.current.errorMessage));
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  // Set once verification finishes with no usable session — the link is
  // missing, malformed, expired, or already used. Distinct from `ready`,
  // which only means "we're done checking," not "the link was good."
  const [linkInvalid,     setLinkInvalid]     = useState(Boolean(initialUrlStateRef.current.errorMessage));
  const [linkError,       setLinkError]       = useState(initialUrlStateRef.current.errorMessage);
  const recoverySessionEstablishedRef = useRef(false);
  const verificationInFlightRef = useRef(false);
  const { changePassword, completePasswordRecovery, discardPasswordRecovery } = useAuth();
  const navigate = useNavigate();

  // Keep the recovery-session marker even if Supabase has already consumed the
  // hash before this page mounts. If the user closes the app now, AuthContext
  // will clear the persisted recovery session on the next launch.
  useEffect(() => {
    if (initialUrlStateRef.current.accessToken) {
      markPasswordRecoveryPending();
    }
  }, []);

  // Every way out of this page must destroy the temporary recovery session
  // before navigating. Clicking a recovery email creates a real Supabase
  // session, and leaving it alive makes /login look like an already signed-in
  // visit. It also makes a reused one-time email link appear to log the user
  // in instead of showing the expired-link state. The ref prevents duplicate
  // sign-outs when an automatic redirect and a click happen together.
  const navigatedAwayRef = useRef(false);
  const leaveRecovery = useCallback(async (endSession, destination, state = null) => {
    if (navigatedAwayRef.current) return;
    navigatedAwayRef.current = true;
    try {
      await endSession();
    } finally {
      navigate(destination, { replace: true, state });
    }
  }, [navigate]);

  // Completing the reset revokes the recovery account's sessions. Cancelling
  // clears only this browser's recovery session.
  const goToSignIn = useCallback(() => leaveRecovery(completePasswordRecovery, '/login', {
    flashMessage: 'Password updated successfully. Please sign in with your new password.',
  }), [completePasswordRecovery, leaveRecovery]);

  const discardEstablishedRecovery = useCallback(() => (
    recoverySessionEstablishedRef.current
      ? discardPasswordRecovery()
      : Promise.resolve({ success: true })
  ), [discardPasswordRecovery]);

  const cancelRecovery = useCallback(
    () => leaveRecovery(discardEstablishedRecovery, '/login'),
    [discardEstablishedRecovery, leaveRecovery],
  );
  const requestNewLink = useCallback(
    () => leaveRecovery(discardEstablishedRecovery, '/forgot-password'),
    [discardEstablishedRecovery, leaveRecovery],
  );

  // The legacy implicit link is valid only when Supabase accepts the access
  // token from this URL. A previous login session must not validate a bad
  // link. Token-hash links require a human click before verification, so an
  // email scanner opening the page cannot consume the one-time token.
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const initialUrlState = initialUrlStateRef.current;

    const settle = (valid, message = '') => {
      if (cancelled || settled) return;
      settled = true;
      if (!valid) clearPasswordRecoveryPending();
      recoverySessionEstablishedRef.current = valid;
      setReady(true);
      setLinkInvalid(!valid);
      setLinkError(valid ? '' : (message || INVALID_RECOVERY_LINK_MESSAGE));
    };

    if (initialUrlState.errorMessage) {
      clearRecoveryQuery();
      return () => { cancelled = true; };
    }

    // Keep an unverified token-hash link in the URL until the customer clicks
    // Continue. A PWA update, manual refresh, or offline retry can recover it.
    if (initialUrlState.tokenHash) {
      hasUsedPasswordRecoveryLink(initialUrlState.tokenHash)
        .then(used => {
          if (cancelled) return;
          if (used) {
            setLinkInvalid(true);
            setLinkError(INVALID_RECOVERY_LINK_MESSAGE);
            clearRecoveryQuery();
          } else {
            setConfirmationRequired(true);
          }
          setReady(true);
        })
        .catch(() => {
          if (cancelled) return;
          setConfirmationRequired(true);
          setReady(true);
        });
      return () => { cancelled = true; };
    }

    if (!initialUrlState.accessToken) {
      settle(false);
      return () => { cancelled = true; };
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (isUsableRecoverySession({ session, expectedAccessToken: initialUrlState.accessToken })) {
        settle(true);
      }
    });

    supabase.auth.getSession()
      .then(({ data, error: sessionError }) => {
        settle(!sessionError && isUsableRecoverySession({
          session: data?.session,
          expectedAccessToken: initialUrlState.accessToken,
        }));
      })
      .catch(() => settle(false));

    return () => {
      cancelled = true;
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

  const confirmRecoveryLink = async () => {
    const tokenHash = initialUrlStateRef.current.tokenHash;
    if (verificationInFlightRef.current || !tokenHash || linkInvalid) return;
    verificationInFlightRef.current = true;
    setError('');
    setLoading(true);
    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'recovery',
      });
      if (verifyError || !data?.session?.user) {
        const invalid = !verifyError || /invalid|expired|already used|otp/i.test(
          `${verifyError.code || ''} ${verifyError.message || ''}`,
        );
        if (invalid) {
          await rememberUsedPasswordRecoveryLink(tokenHash);
          setLinkInvalid(true);
          setLinkError(INVALID_RECOVERY_LINK_MESSAGE);
          setConfirmationRequired(false);
          clearRecoveryQuery();
        } else {
          setError('Could not verify the reset link right now. Please check your connection and try again.');
        }
        return;
      }

      // verifyOtp consumes the one-time token and stores a temporary session.
      // Remember the used link locally so reopening this email on the same
      // browser/PWA reports its status before asking for a new password.
      await rememberUsedPasswordRecoveryLink(tokenHash);
      recoverySessionEstablishedRef.current = true;
      initialUrlStateRef.current.tokenHash = '';
      markPasswordRecoveryPending();
      clearRecoveryQuery();
      setConfirmationRequired(false);
      setReady(true);
    } catch {
      setError('Could not verify the reset link right now. Please check your connection and try again.');
    } finally {
      verificationInFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading || !ready || linkInvalid || confirmationRequired || success ||
        !recoverySessionEstablishedRef.current) return;
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

  if (confirmationRequired) {
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
            <div className="fp-hero-icon fp-hero-icon-lock"><ShieldCheck size={26} /></div>
            <h1 className="fp-title">Confirm Password Reset</h1>
            <p className="fp-subtitle">Continue to verify this link, then set your new password.</p>
          </div>
          {error && (
            <div className="auth-error-banner" role="alert">
              <AlertTriangle size={15} />
              <span>{error}</span>
            </div>
          )}
          <button
            type="button"
            onClick={confirmRecoveryLink}
            className="auth-submit-btn text-no-underline mt-12"
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? <><Loader size={16} className="animate-spin" /> Verifying…</> : 'Continue'}
          </button>
          <div className="auth-card-footer">
            <button
              type="button"
              onClick={cancelRecovery}
              className="auth-link bg-none border-none cursor-pointer p-0"
              style={{ font: 'inherit' }}
            >
              <ArrowLeft size={12} style={{ verticalAlign: 'middle', marginRight: 2 }} />
              Back to Sign In
            </button>
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
              {linkError || INVALID_RECOVERY_LINK_MESSAGE}
            </p>
          </div>
          <button
            type="button"
            onClick={requestNewLink}
            className="auth-submit-btn text-no-underline mt-12"
          >
            Request New Link
          </button>
          <div className="auth-card-footer">
            <p>
              <button
                type="button"
                onClick={cancelRecovery}
                className="auth-link bg-none border-none cursor-pointer p-0"
                style={{ font: 'inherit' }}
              >
                <ArrowLeft size={12} style={{ verticalAlign: 'middle', marginRight: 2 }} />
                Back to Sign In
              </button>
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
              <button
                type="button"
                onClick={cancelRecovery}
                className="auth-link bg-none border-none cursor-pointer p-0"
                style={{ font: 'inherit' }}
              >
                <ArrowLeft size={12} style={{ verticalAlign: 'middle', marginRight: 2 }} />
                Back to Sign In
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
