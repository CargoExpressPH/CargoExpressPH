import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  Container, Eye, EyeOff,
  Ship, Package, DollarSign, Search, Zap, AlertTriangle,
  Mail, Lock,
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { logAuth } from '../../lib/activityLog';

// ── Error mapper ─────────────────────────────────────────────────────────────
const INVALID_CREDENTIALS_ERROR = 'Incorrect password or email.';

const getFriendlyError = (msg) => {
  if (!msg) return 'An unexpected error occurred. Please try again.';
  const m = msg.toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid credentials'))
    return INVALID_CREDENTIALS_ERROR;
  if (m.includes('incorrect password') || m.includes('no account'))
    return INVALID_CREDENTIALS_ERROR;
  if (m.includes('email not confirmed'))
    return 'Your email is not confirmed. Please check your inbox.';
  if (m.includes('too many') || m.includes('rate limit'))
    return 'Too many failed attempts. Please wait a few minutes.';
  if (m.includes('network') || m.includes('fetch'))
    return 'Network error. Please check your connection.';
  if (m.includes('invalid'))
    return INVALID_CREDENTIALS_ERROR;
  return msg;
};

const isEmailValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const getLoginErrorPlacement = (msg) => {
  const friendly = getFriendlyError(msg);
  const lower = friendly.toLowerCase();

  if (friendly === INVALID_CREDENTIALS_ERROR) {
    return {
      fieldErrors: { email: '', password: '' },
      loginError: INVALID_CREDENTIALS_ERROR,
      credentialError: true,
    };
  }

  if (lower.includes('email is not confirmed')) {
    return {
      fieldErrors: { email: friendly, password: '' },
      loginError: friendly,
      credentialError: false,
    };
  }

  return {
    fieldErrors: { email: '', password: '' },
    loginError: friendly,
    credentialError: false,
  };
};

// ════════════════════════════════════════════════════════════════════════════
// LoginPage
// ════════════════════════════════════════════════════════════════════════════
const LoginPage = () => {
  usePageTitle('Login');
  // ── Login state ──────────────────────────────────────────────────────────
  const [email, setEmail]               = useState(() => localStorage.getItem('remembered_email') || '');
  const [password, setPassword]         = useState('');
  const [rememberMe, setRememberMe]     = useState(() => localStorage.getItem('remember_me') === 'true');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError]     = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [fieldErrors, setFieldErrors]   = useState({ email: '', password: '' });
  const [credentialErrorActive, setCredentialErrorActive] = useState(false);
  const { login }  = useAuth();
  const navigate   = useNavigate();

  const loginErrorTimerRef = useRef(null);

  useEffect(() => () => {
    if (loginErrorTimerRef.current) clearTimeout(loginErrorTimerRef.current);
  }, []);

  // ── Login handler ────────────────────────────────────────────────────────
  const clearLoginErrorTimer = () => {
    if (loginErrorTimerRef.current) {
      clearTimeout(loginErrorTimerRef.current);
      loginErrorTimerRef.current = null;
    }
  };

  const showLoginAlert = (message, isCredentialError = false) => {
    clearLoginErrorTimer();
    setLoginError(message);
    setCredentialErrorActive(isCredentialError);
  };

  const clearLoginFieldError = (field) => {
    clearLoginErrorTimer();
    setLoginError('');
    setCredentialErrorActive(false);
    setFieldErrors(prev => {
      if (!prev[field]) return prev;
      return { ...prev, [field]: '' };
    });
  };

  const handleEmailChange = (e) => {
    setEmail(e.target.value);
    clearLoginFieldError('email');
  };

  const handlePasswordChange = (e) => {
    setPassword(e.target.value);
    clearLoginFieldError('password');
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    clearLoginErrorTimer();
    setLoginError('');
    setCredentialErrorActive(false);
    setFieldErrors({ email: '', password: '' });

    const nextFieldErrors = { email: '', password: '' };
    if (!email.trim()) {
      nextFieldErrors.email = 'Email address is required.';
    } else if (!isEmailValid(email)) {
      nextFieldErrors.email = 'Please enter a valid email address.';
    }

    if (!password.trim()) {
      nextFieldErrors.password = 'Password is required.';
    }

    if (nextFieldErrors.email || nextFieldErrors.password) {
      setFieldErrors(nextFieldErrors);
      return;
    }

    setLoginLoading(true);
    try {
      const result = await login(email.trim(), password);
      if (result.success) {
        if (rememberMe) {
          localStorage.setItem('remember_me', 'true');
          localStorage.setItem('remembered_email', email.trim());
        } else {
          localStorage.removeItem('remember_me');
          localStorage.removeItem('remembered_email');
        }
        logAuth('User Logged In', { details: `User logged in with email: ${email.trim()}` });
        navigate('/');
      } else {
        const nextError = getLoginErrorPlacement(result.error);
        setFieldErrors(nextError.fieldErrors);
        showLoginAlert(nextError.loginError, nextError.credentialError);
      }
    } catch (err) {
      const nextError = getLoginErrorPlacement(err?.message);
      setFieldErrors(nextError.fieldErrors);
      showLoginAlert(nextError.loginError, nextError.credentialError);
    } finally {
      setLoginLoading(false);
    }
  };

  const emailHasError = !!fieldErrors.email || credentialErrorActive;
  const passwordHasError = !!fieldErrors.password || credentialErrorActive;

  return (
    <div className="login-split-page">

      {/* Modern Mesh Gradient Background */}
      <div className="auth-mesh-bg" aria-hidden="true">
        <div className="auth-mesh-orb auth-mesh-orb-1" />
        <div className="auth-mesh-orb auth-mesh-orb-2" />
        <div className="auth-mesh-orb auth-mesh-orb-3" />
      </div>

      {/* ════════════════════════════════════════════════════════════
          LEFT PANEL — Branding
      ════════════════════════════════════════════════════════════ */}
      <div className="login-left-panel">
        <div className="login-left-content">
          <div className="login-brand" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Container size={28} color="var(--primary)" />
            <h1 style={{ display: 'flex', gap: 4, margin: 0, fontSize: '2rem', fontWeight: 900 }}>
              <span style={{ color: '#fff' }}>CARGO</span>
              <span style={{ color: 'var(--primary-light)' }}>EXPRESS</span>
            </h1>
          </div>

          {/* Tagline */}
          <h2 className="login-tagline">
            Fast &amp; Reliable<br />Cargo Delivery
          </h2>
          <p className="login-tagline-sub">
            Connecting Bohol and Manila with safe,<br />
            affordable sea cargo shipping.
          </p>

          {/* Route pills */}
          <div className="login-route-pills">
            <div className="login-route-pill">
              <Ship size={14} /> Bohol → Manila
            </div>
            <div className="login-route-pill">
              <Ship size={14} /> Manila → Bohol
            </div>
          </div>

          {/* Features */}
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

        {/* Bottom attribution */}
        <div className="login-left-footer">
          <div>© {new Date().getFullYear()} CargoExpress PH. All rights reserved.</div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════
          RIGHT PANEL — Login Form
      ════════════════════════════════════════════════════════════ */}
      <div className="login-right-panel">
        <div className="login-right-bg-orb login-right-bg-orb-1" aria-hidden="true" />
        <div className="login-right-bg-orb login-right-bg-orb-2" aria-hidden="true" />

        <div className="login-form-container animate-slide-up">

          <div className="login-mobile-brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Container size={20} color="var(--primary)" />
            <span style={{ display: 'inline-flex', gap: 4, fontWeight: 900, fontSize: '1.25rem' }}>
              <span className="text-accent">CARGO</span>
              <span className="text-primary">EXPRESS</span>
            </span>
          </div>

          <div className="login-form-header">
            <h2 className="login-form-title">Welcome back</h2>
            <p className="login-form-sub">Sign in to manage your shipments &amp; track orders.</p>
          </div>

          {loginError && (
            <div className="login-error-box" role="alert">
              <AlertTriangle size={15} />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} noValidate>
            {/* Email */}
            <div className="form-group">
              <label className="form-label" htmlFor="login-email">Email Address</label>
              <div className="form-input-wrapper">
                <Mail size={16} className="form-input-icon" aria-hidden="true" />
                <input
                  id="login-email"
                  type="email"
                  className={`form-input form-input-icon-left ${emailHasError ? 'error' : ''}`}
                  placeholder="your@email.com"
                  value={email}
                  onChange={handleEmailChange}
                  required
                  autoComplete="email"
                  aria-required="true"
                  aria-invalid={emailHasError}
                  aria-describedby={fieldErrors.email ? 'login-email-error' : undefined}
                />
              </div>
              {fieldErrors.email && (
                <p className="form-error" id="login-email-error">{fieldErrors.email}</p>
              )}
            </div>

            {/* Password */}
            <div className="form-group">
              <div className="login-pw-header">
                <label className="form-label" htmlFor="login-password">Password</label>
                <Link to="/forgot-password" className="login-forgot-link">
                  Forgot password?
                </Link>
              </div>
              <div className="form-input-wrapper">
                <Lock size={16} className="form-input-icon" aria-hidden="true" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  className={`form-input form-input-icon-left form-input-icon-right ${passwordHasError ? 'error' : ''}`}
                  placeholder="Enter your password"
                  value={password}
                  onChange={handlePasswordChange}
                  required
                  autoComplete="current-password"
                  aria-required="true"
                  aria-invalid={passwordHasError}
                  aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="form-pw-toggle"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {fieldErrors.password && (
                <p className="form-error" id="login-password-error">{fieldErrors.password}</p>
              )}
            </div>

            {/* Remember Me */}
            <div className="remember-me-group">
              <label className="remember-me-label">
                <input
                  type="checkbox"
                  className="remember-me-checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span>Remember me</span>
              </label>
            </div>

            <button
              type="submit"
              className="login-submit-btn"
              disabled={loginLoading}
              aria-busy={loginLoading}
            >
              {loginLoading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {/* Divider */}
          <div className="login-divider">
            <span>Don't have an account?</span>
          </div>

          {/* Sign up */}
          <Link to="/register" className="login-signup-btn">
            Create account
          </Link>

          {/* Footer links */}
          <div className="login-footer-links">
            <Link to="/about" className="login-footer-btn">About Us</Link>
            <span className="login-footer-sep" aria-hidden="true">·</span>
            <Link to="/track" className="login-footer-btn">Track Package</Link>
          </div>
        </div>
      </div>

    </div>
  );
};

export default LoginPage;
