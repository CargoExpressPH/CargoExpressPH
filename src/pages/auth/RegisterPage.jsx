import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { normalizeProfileAddressFields } from '../../lib/address';
import {
  Container, Eye, EyeOff, Loader, Check, ArrowRight, ArrowLeft,
  AlertTriangle, User, Mail, Phone, Lock, MapPin, MessageSquare,
  Home, Landmark, CheckCircle2, Sparkles, Ship, DollarSign, Search,
  Zap, Package, Navigation,
} from 'lucide-react';
import { PH_LOCATIONS, VALID_PROVINCES } from '../../constants/phLocations';
import CustomSelect from '../../components/ui/CustomSelect';
import usePageTitle from '../../hooks/usePageTitle';
import { toTitleCase } from '../../utils/string';
import { getPasswordStrength } from '../../utils/password';

/* ── Helpers ──────────────────────────────────────────────────────────── */

const isPhoneValid = (phone) => /^09\d{9}$/.test(phone);
const isEmailValid = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

const getPasswordError = (password) => {
  if (!password) return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must include a number.';
  return '';
};

/* ── Step definitions ────────────────────────────────────────────────── */
const STEPS = [
  { id: 1, label: 'Account',  icon: User    },
  { id: 2, label: 'Address',  icon: MapPin  },
];

/* ══════════════════════════════════════════════════════════════════════════
   RegisterPage
══════════════════════════════════════════════════════════════════════════ */
const RegisterPage = () => {
  usePageTitle('Create Account');
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: '', email: '', phone: '', password: '', confirmPassword: '',
    facebook_name: '',
    address_province: '', address_city: '', address_barangay: '',
    address_street: '', address_lot_block: '', address_landmark: '',
  });
  const [showPw,        setShowPw]        = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [error,         setError]         = useState('');
  const [phoneError,    setPhoneError]    = useState('');
  const [loading,       setLoading]       = useState(false);
  const [success,       setSuccess]       = useState(false);
  const topRef = useRef(null);
  const errorRef = useRef(null);

  const { register } = useAuth();
  const navigate     = useNavigate();

  const update = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const cities = form.address_province ? PH_LOCATIONS[form.address_province] || [] : [];
  const pwStrength = getPasswordStrength(form.password);

  // Scroll card top on step change
  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [step]);

  const showError = (message) => {
    setError(message);
    requestAnimationFrame(() => {
      const target = errorRef.current || topRef.current;
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current?.focus({ preventScroll: true });
    });
  };

  const handleTitleCase = (key) => (e) => update(key, toTitleCase(e.target.value));

  const handlePhone = (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 11);
    update('phone', digits);
    if (digits.length === 0)             setPhoneError('');
    else if (!digits.startsWith('09'))   setPhoneError('Must start with 09');
    else if (digits.length < 11)         setPhoneError('Must be exactly 11 digits');
    else                                 setPhoneError('');
  };

  const goToStep2 = () => {
    if (!form.name.trim())
      return showError('Full name is required.');
    if (!form.email.trim())
      return showError('Email address is required.');
    if (!isEmailValid(form.email))
      return showError('Please enter a valid email address.');
    if (form.phone && !isPhoneValid(form.phone))
      return showError('Mobile number must be 11 digits starting with 09.');
    const passwordError = getPasswordError(form.password);
    if (passwordError)
      return showError(passwordError);
    if (!form.confirmPassword)
      return showError('Please confirm your password.');
    if (form.password !== form.confirmPassword)
      return showError('Passwords do not match.');
    setError('');
    setStep(2);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return showError('Full name is required.');
    if (!form.email.trim()) return showError('Email address is required.');
    if (!isEmailValid(form.email)) return showError('Please enter a valid email address.');
    if (form.phone && !isPhoneValid(form.phone)) return showError('Mobile number must be 11 digits starting with 09.');
    const passwordError = getPasswordError(form.password);
    if (passwordError) return showError(passwordError);
    if (!form.confirmPassword) return showError('Please confirm your password.');
    if (form.password !== form.confirmPassword) return showError('Passwords do not match.');
    if (!form.address_province) return showError('Province is required.');
    if (!form.address_city) return showError('City / Municipality is required.');
    if (!form.address_barangay.trim()) return showError('Barangay is required.');
    if (!form.address_street.trim()) return showError('Street is required.');
    if (!form.address_lot_block.trim()) return showError('Lot / Block / Purok is required.');
    if (!form.address_landmark.trim()) return showError('Landmark is required.');
    setError('');
    setLoading(true);
    try {
      const normalizedAddress = normalizeProfileAddressFields(form);
      const result = await register(form.email, form.password, {
        name:             form.name,
        phone:            form.phone,
        facebook_name:    form.facebook_name,
        address_province: normalizedAddress.address_province,
        address_city:     normalizedAddress.address_city,
        address_barangay: normalizedAddress.address_barangay,
        address_street:   normalizedAddress.address_street,
        address_lot_block:normalizedAddress.address_lot_block,
        address_landmark: normalizedAddress.address_landmark,
      });
      setLoading(false);
      if (result.success) {
        setSuccess(true);
        setTimeout(() => navigate('/'), 1400);
      } else {
        showError(result.error);
      }
    } catch (err) {
      setLoading(false);
      showError(err.message || 'Registration failed. Please try again.');
    }
  };

  /* ── Success flash ── */
  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-mesh-bg" aria-hidden="true">
          <div className="auth-mesh-orb auth-mesh-orb-1" />
          <div className="auth-mesh-orb auth-mesh-orb-2" />
          <div className="auth-mesh-orb auth-mesh-orb-3" />
        </div>
        <div className="auth-card auth-success-card animate-scale-in">
          <div className="auth-success-icon">
            <CheckCircle2 size={48} />
          </div>
          <h2 className="auth-success-title">Account Created!</h2>
          <p className="auth-success-sub">Welcome to CargoExpress PH. Redirecting you now…</p>
          <div className="auth-success-loader">
            <div className="auth-success-bar" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-split-page" ref={topRef}>

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

      {/* RIGHT PANEL — Registration Form */}
      <div className="login-right-panel">
        <div className="login-form-container wide-form animate-slide-up">

          <div className="login-mobile-brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Container size={20} color="var(--primary)" />
            <span style={{ display: 'inline-flex', gap: 4, fontWeight: 900, fontSize: '1.25rem' }}>
              <span className="text-accent">CARGO</span>
              <span className="text-primary">EXPRESS</span>
            </span>
          </div>

          <div className="login-form-header">
            <h2 className="login-form-title">Create Account</h2>
            <p className="login-form-sub">Sign up for free and manage your cargo deliveries.</p>
          </div>

        {/* ── Step Progress ── */}
        <div className="reg-step-bar" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={2}>
          {STEPS.map((s, idx) => (
            <div key={s.id} className="reg-step-item">
              <div className={`reg-step-node ${step === s.id ? 'active' : ''} ${step > s.id ? 'completed' : ''}`}>
                <div className="reg-step-circle">
                  {step > s.id
                    ? <Check size={13} strokeWidth={3} />
                    : <s.icon size={13} />
                  }
                </div>
                <span className="reg-step-label">{s.label}</span>
              </div>
              {idx < STEPS.length - 1 && (
                <div className={`reg-step-connector ${step > s.id ? 'done' : ''}`} />
              )}
            </div>
          ))}
        </div>

        {/* ── Error banner ── */}
        {error && (
          <div className="auth-error-banner" role="alert" tabIndex={-1} ref={errorRef}>
            <AlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>

          {/* ══════════════════════════ STEP 1 — ACCOUNT ══════════════════════════ */}
          {step === 1 && (
            <div className="reg-step-content animate-slide-up" key="step1">

              <div className="reg-section-label">
                <User size={13} />
                Personal Information
              </div>

              {/* Full Name */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-name">
                  Full Name
                </label>
                <div className="form-input-wrapper">
                  <User size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-name"
                    className="form-input form-input-icon-left"
                    placeholder="Juan Dela Cruz"
                    value={form.name}
                    onChange={handleTitleCase('name')}
                    required
                    autoComplete="name"
                    aria-required="true"
                    aria-invalid={error === 'Full name is required.' ? 'true' : 'false'}
                  />
                </div>
              </div>

              {/* Facebook Name */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-facebook">
                  Facebook Name <span className="form-label-hint">(optional)</span>
                </label>
                <div className="form-input-wrapper">
                  <MessageSquare size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-facebook"
                    className="form-input form-input-icon-left"
                    placeholder="Your Facebook display name"
                    value={form.facebook_name}
                    onChange={e => update('facebook_name', e.target.value)}
                    autoComplete="nickname"
                  />
                </div>
              </div>

              {/* Email */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-email">
                  Email Address
                </label>
                <div className="form-input-wrapper">
                  <Mail size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-email"
                    type="email"
                    className="form-input form-input-icon-left"
                    placeholder="you@email.com"
                    value={form.email}
                    onChange={e => update('email', e.target.value)}
                    required
                    autoComplete="email"
                    aria-required="true"
                    aria-invalid={(error === 'Email address is required.' || error === 'Please enter a valid email address.') ? 'true' : 'false'}
                  />
                </div>
              </div>

              {/* Mobile */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-phone">
                  Mobile Number <span className="form-label-hint">(optional)</span>
                </label>
                <div className="form-input-wrapper">
                  <Phone size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-phone"
                    className={`form-input form-input-icon-left ${phoneError ? 'error' : form.phone.length === 11 && !phoneError ? 'success' : ''}`}
                    placeholder="09xxxxxxxxx"
                    value={form.phone}
                    onChange={handlePhone}
                    inputMode="numeric"
                    maxLength={11}
                    autoComplete="tel"
                    aria-describedby="reg-phone-hint"
                    aria-invalid={!!phoneError || (error === 'Mobile number must be 11 digits starting with 09.') ? 'true' : 'false'}
                  />
                  {form.phone.length === 11 && !phoneError && (
                    <Check size={14} className="form-input-icon-right-check" aria-hidden="true" />
                  )}
                </div>
                <div className="form-meta-row" id="reg-phone-hint">
                  {phoneError
                    ? <span className="form-error">{phoneError}</span>
                    : <span className="form-helper">Philippine mobile number</span>
                  }
                  <span className="form-char-count">{form.phone.length}/11</span>
                </div>
              </div>

              {/* Password */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-password">
                  Password
                </label>
                <div className="form-input-wrapper">
                  <Lock size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-password"
                    type={showPw ? 'text' : 'password'}
                    className="form-input form-input-icon-left form-input-icon-right"
                    placeholder="Min. 8 characters"
                    value={form.password}
                    onChange={e => update('password', e.target.value)}
                    required
                    autoComplete="new-password"
                    aria-required="true"
                    aria-describedby="reg-pw-strength"
                    aria-invalid={['Password is required.', 'Password must be at least 8 characters.', 'Password must include an uppercase letter.', 'Password must include a lowercase letter.', 'Password must include a number.'].includes(error) ? 'true' : 'false'}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(!showPw)}
                    className="form-pw-toggle"
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    aria-pressed={showPw}
                  >
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>

                {/* Strength meter */}
                {form.password && (
                  <div className="pw-strength-wrap" id="reg-pw-strength" aria-live="polite">
                    <div className="pw-strength-bars">
                      {[1,2,3,4].map(i => (
                        <div
                          key={i}
                          className="pw-strength-bar"
                          style={{
                            background: i <= pwStrength.level ? pwStrength.color : 'var(--border)',
                          }}
                        />
                      ))}
                    </div>
                    <span className="pw-strength-label" style={{ color: pwStrength.color }}>
                      {pwStrength.label}
                    </span>
                  </div>
                )}

                {/* Rules */}
                <div className="pw-rules">
                  {[
                    { test: form.password.length >= 8,       text: '8+ characters'       },
                    { test: /[A-Z]/.test(form.password),     text: 'Uppercase letter'     },
                    { test: /[a-z]/.test(form.password),     text: 'Lowercase letter'     },
                    { test: /[0-9]/.test(form.password),     text: 'Number'               },
                  ].map((r, i) => (
                    <div key={i} className={`pw-rule ${r.test ? 'met' : ''}`}>
                      <Check size={10} strokeWidth={3} />
                      {r.text}
                    </div>
                  ))}
                </div>
              </div>

              {/* Confirm Password */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-confirm-password">
                  Confirm Password
                </label>
                <div className="form-input-wrapper">
                  <Lock size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-confirm-password"
                    type={showConfirmPw ? 'text' : 'password'}
                    className={`form-input form-input-icon-left form-input-icon-right ${
                      form.confirmPassword && form.confirmPassword === form.password ? 'success' :
                      form.confirmPassword && form.confirmPassword !== form.password ? 'error' : ''
                    }`}
                    placeholder="Repeat password"
                    value={form.confirmPassword}
                    onChange={e => update('confirmPassword', e.target.value)}
                    required
                    autoComplete="new-password"
                    aria-required="true"
                    aria-invalid={(error === 'Please confirm your password.' || error === 'Passwords do not match.' || (form.confirmPassword && form.confirmPassword !== form.password)) ? 'true' : 'false'}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPw(!showConfirmPw)}
                    className="form-pw-toggle"
                    aria-label={showConfirmPw ? 'Hide confirm password' : 'Show confirm password'}
                    aria-pressed={showConfirmPw}
                  >
                    {showConfirmPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                {form.confirmPassword && form.confirmPassword !== form.password && (
                  <p className="form-error">Passwords don't match</p>
                )}
              </div>

              <button
                type="button"
                className="auth-submit-btn"
                onClick={goToStep2}
              >
                Continue to Address <ArrowRight size={17} />
              </button>
            </div>
          )}

          {/* ══════════════════════════ STEP 2 — ADDRESS ══════════════════════════ */}
          {step === 2 && (
            <div className="reg-step-content animate-slide-up" key="step2">

              <div className="reg-section-label">
                <MapPin size={13} />
                Delivery Address
              </div>

              {/* Province */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-province">
                  Province
                </label>
                <div className="form-input-wrapper">
                  <MapPin size={15} className="form-input-icon" aria-hidden="true" />
                  <CustomSelect
                    id="reg-province"
                    className="form-select form-input-icon-left"
                    value={form.address_province}
                    onChange={e => { update('address_province', e.target.value); update('address_city', ''); }}
                    autoComplete="address-level1"
                  >
                    <option value="">Select Province</option>
                    {VALID_PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
                  </CustomSelect>
                </div>
              </div>

              {/* City */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-city">City / Municipality</label>
                <div className="form-input-wrapper">
                  <Landmark size={15} className="form-input-icon" aria-hidden="true" />
                  <CustomSelect
                    id="reg-city"
                    className="form-select form-input-icon-left"
                    value={form.address_city}
                    onChange={e => update('address_city', e.target.value)}
                    autoComplete="address-level2"
                    disabled={!form.address_province}
                  >
                    <option value="">Select City</option>
                    {cities.map(c => <option key={c} value={c}>{c}</option>)}
                  </CustomSelect>
                </div>
              </div>

              {/* Barangay */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-barangay">Barangay</label>
                <div className="form-input-wrapper">
                  <Home size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-barangay"
                    className="form-input form-input-icon-left"
                    placeholder="e.g. Barangay Poblacion"
                    value={form.address_barangay}
                    onChange={handleTitleCase('address_barangay')}
                    autoComplete="address-level3"
                  />
                </div>
              </div>

              {/* Street */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-street">Street</label>
                <div className="form-input-wrapper">
                  <MapPin size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-street"
                    className="form-input form-input-icon-left"
                    placeholder="e.g. Rizal Street"
                    value={form.address_street}
                    onChange={handleTitleCase('address_street')}
                    autoComplete="street-address"
                  />
                </div>
              </div>

              {/* Lot/Block */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-lot">Lot / Block / Purok</label>
                <div className="form-input-wrapper">
                  <Home size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-lot"
                    className="form-input form-input-icon-left"
                    placeholder="e.g. Lot 12, Block 5"
                    value={form.address_lot_block}
                    onChange={handleTitleCase('address_lot_block')}
                    required
                    aria-required="true"
                    aria-invalid={error === 'Lot / Block / Purok is required.' ? 'true' : 'false'}
                  />
                </div>
              </div>

              {/* Landmark */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-landmark">Landmark</label>
                <div className="form-input-wrapper">
                  <Navigation size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-landmark"
                    className="form-input form-input-icon-left"
                    placeholder="e.g. Near Sari-sari Store, Beside Church"
                    value={form.address_landmark}
                    onChange={handleTitleCase('address_landmark')}
                    required
                    aria-required="true"
                    aria-invalid={error === 'Landmark is required.' ? 'true' : 'false'}
                  />
                </div>
              </div>

              {/* Address note */}
              <div className="reg-address-note">
                <MapPin size={13} />
                <p>Your address helps us arrange pickups and deliveries more accurately.</p>
              </div>

              {/* Buttons */}
              <div className="reg-btn-row">
                <button
                  type="button"
                  className="auth-back-btn"
                  onClick={() => { setError(''); setStep(1); }}
                >
                  <ArrowLeft size={16} /> Back
                </button>
                <button
                  type="submit"
                  className="auth-submit-btn auth-submit-flex"
                  disabled={loading}
                  aria-busy={loading}
                >
                  {loading
                    ? <><Loader size={16} className="animate-spin" /> Creating…</>
                    : 'Create Account'
                  }
                </button>
              </div>
            </div>
          )}
        </form>

        <div className="auth-card-footer">
          <p>Already have an account? <Link to="/login" className="auth-link">Sign In</Link></p>
        </div>
      </div>
      </div>
      </div>
  );
};

export default RegisterPage;
