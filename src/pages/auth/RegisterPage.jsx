import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { normalizeProfileAddressFields } from '../../lib/address';
import {
  Container, Eye, EyeOff, Loader, Check, ArrowRight, ArrowLeft,
  AlertTriangle, User, Mail, Phone, Lock, MapPin, MessageSquare,
  Home, Landmark, CheckCircle2, Ship, DollarSign, Search,
  Zap, Package, Navigation, ShieldCheck,
} from 'lucide-react';
import { PH_LOCATIONS, VALID_PROVINCES } from '../../constants/phLocations';
import CustomSelect from '../../components/ui/CustomSelect';
import usePageTitle from '../../hooks/usePageTitle';
import { toTitleCase } from '../../utils/string';
import { getPasswordStrength } from '../../utils/password';
import FieldError from '../../components/ui/FieldError';

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
   RegisterPage — 100% World-Class & Ultra-Premium Standard
══════════════════════════════════════════════════════════════════════════ */
const RegisterPage = () => {
  usePageTitle('Create Account');
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(() => {
    try {
      const saved = sessionStorage.getItem('reg_draft');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          name: parsed.name || '',
          email: parsed.email || '',
          phone: parsed.phone || '',
          password: '',
          confirmPassword: '',
          facebook_name: parsed.facebook_name || '',
          address_province: parsed.address_province || '',
          address_city: parsed.address_city || '',
          address_barangay: parsed.address_barangay || '',
          address_street: parsed.address_street || '',
          address_lot_block: parsed.address_lot_block || '',
          address_landmark: parsed.address_landmark || '',
        };
      }
    } catch (e) {}
    return {
      name: '', email: '', phone: '', password: '', confirmPassword: '',
      facebook_name: '',
      address_province: '', address_city: '', address_barangay: '',
      address_street: '', address_lot_block: '', address_landmark: '',
    };
  });

  const [showPw,        setShowPw]        = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [capsLockOn,    setCapsLockOn]    = useState(false);
  const [error,         setError]         = useState('');
  const [fieldErrors,   setFieldErrors]   = useState({});
  const [touchedFields, setTouchedFields] = useState({});
  const [loading,       setLoading]       = useState(false);
  const [success,       setSuccess]       = useState(false);
  const topRef = useRef(null);
  const errorRef = useRef(null);

  const { register } = useAuth();
  const navigate     = useNavigate();

  const cities = form.address_province ? PH_LOCATIONS[form.address_province] || [] : [];
  const pwStrength = getPasswordStrength(form.password);

  // Auto-save non-sensitive draft fields
  useEffect(() => {
    try {
      const { password, confirmPassword, ...draft } = form;
      sessionStorage.setItem('reg_draft', JSON.stringify(draft));
    } catch (e) {}
  }, [form]);

  // Scroll card top on step change
  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [step]);

  const checkCapsLock = (e) => {
    if (e.getModifierState) {
      setCapsLockOn(e.getModifierState('CapsLock'));
    }
  };

  /* ── Field validation helper ────────────────────────────────────────── */
  const validateSingleField = (name, value, currentForm = form) => {
    switch (name) {
      case 'name':
        if (!value.trim()) return 'Full name is required.';
        if (value.trim().length < 2) return 'Full name must be at least 2 characters.';
        return '';
      // Required here to match the booking wizard, which rejects an empty
      // Facebook Name on both the sender and receiver steps. Labelling it
      // "(optional)" at registration and mandatory at booking was the same
      // field asking two different questions.
      case 'facebook_name':
        if (!value.trim()) return 'Facebook Name is required.';
        return '';
      case 'email':
        if (!value.trim()) return 'Email address is required.';
        if (!isEmailValid(value)) return 'Please enter a valid email address.';
        return '';
      case 'phone':
        if (!value) return 'Mobile Number is required.';
        if (!isPhoneValid(value)) return 'Mobile number must be 11 digits starting with 09.';
        return '';
      case 'password':
        return getPasswordError(value);
      case 'confirmPassword':
        if (!value) return 'Please confirm your password.';
        if (value !== currentForm.password) return 'Passwords do not match.';
        return '';
      case 'address_province':
        if (!value) return 'Province is required.';
        return '';
      case 'address_city':
        if (!value) return 'City / Municipality is required.';
        return '';
      case 'address_barangay':
        if (!value.trim()) return 'Barangay is required.';
        return '';
      case 'address_street':
        if (!value.trim()) return 'Street is required.';
        return '';
      case 'address_lot_block':
        if (!value.trim()) return 'Lot / Block / Purok is required.';
        return '';
      case 'address_landmark':
        if (!value.trim()) return 'Landmark is required.';
        return '';
      default:
        return '';
    }
  };

  /* ── Step-wide validation ───────────────────────────────────────────── */
  const validateStep1 = (currentForm = form) => {
    const errors = {};
    const nameErr = validateSingleField('name', currentForm.name, currentForm);
    if (nameErr) errors.name = nameErr;

    const fbErr = validateSingleField('facebook_name', currentForm.facebook_name, currentForm);
    if (fbErr) errors.facebook_name = fbErr;

    const emailErr = validateSingleField('email', currentForm.email, currentForm);
    if (emailErr) errors.email = emailErr;

    const phoneErr = validateSingleField('phone', currentForm.phone, currentForm);
    if (phoneErr) errors.phone = phoneErr;

    const pwErr = validateSingleField('password', currentForm.password, currentForm);
    if (pwErr) errors.password = pwErr;

    const confirmErr = validateSingleField('confirmPassword', currentForm.confirmPassword, currentForm);
    if (confirmErr) errors.confirmPassword = confirmErr;

    return errors;
  };

  const validateStep2 = (currentForm = form) => {
    const errors = {};
    const provErr = validateSingleField('address_province', currentForm.address_province, currentForm);
    if (provErr) errors.address_province = provErr;

    const cityErr = validateSingleField('address_city', currentForm.address_city, currentForm);
    if (cityErr) errors.address_city = cityErr;

    const brgyErr = validateSingleField('address_barangay', currentForm.address_barangay, currentForm);
    if (brgyErr) errors.address_barangay = brgyErr;

    const streetErr = validateSingleField('address_street', currentForm.address_street, currentForm);
    if (streetErr) errors.address_street = streetErr;

    const lotErr = validateSingleField('address_lot_block', currentForm.address_lot_block, currentForm);
    if (lotErr) errors.address_lot_block = lotErr;

    const markErr = validateSingleField('address_landmark', currentForm.address_landmark, currentForm);
    if (markErr) errors.address_landmark = markErr;

    return errors;
  };

  /* ── Smooth focus on first failing field ────────────────────────────── */
  const focusFirstError = (errors) => {
    const errorKeys = Object.keys(errors);
    if (!errorKeys.length) return;

    const fieldIdMap = {
      name: 'reg-name',
      facebook_name: 'reg-facebook',
      email: 'reg-email',
      phone: 'reg-phone',
      password: 'reg-password',
      confirmPassword: 'reg-confirm-password',
      address_province: 'reg-province',
      address_city: 'reg-city',
      address_barangay: 'reg-barangay',
      address_street: 'reg-street',
      address_lot_block: 'reg-lot',
      address_landmark: 'reg-landmark',
    };

    const firstFieldKey = errorKeys[0];
    const elementId = fieldIdMap[firstFieldKey];
    requestAnimationFrame(() => {
      if (elementId) {
        const el = document.getElementById(elementId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus({ preventScroll: true });
          return;
        }
      }
      const target = errorRef.current || topRef.current;
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  /* ── Form State Management ──────────────────────────────────────────── */
  const update = (k, v) => {
    setForm(prev => {
      const nextForm = { ...prev, [k]: v };
      if (touchedFields[k] || fieldErrors[k]) {
        const err = validateSingleField(k, v, nextForm);
        setFieldErrors(pe => ({ ...pe, [k]: err }));
      }
      if (k === 'password' && (touchedFields.confirmPassword || fieldErrors.confirmPassword || nextForm.confirmPassword)) {
        const confirmErr = validateSingleField('confirmPassword', nextForm.confirmPassword, nextForm);
        setFieldErrors(pe => ({ ...pe, confirmPassword: confirmErr }));
      }
      return nextForm;
    });
  };

  const handleBlur = (field) => {
    setTouchedFields(prev => ({ ...prev, [field]: true }));
    const err = validateSingleField(field, form[field]);
    setFieldErrors(prev => ({ ...prev, [field]: err }));
  };

  const handleTitleCase = (key) => (e) => update(key, toTitleCase(e.target.value));

  const handlePhone = (e) => {
    let raw = e.target.value.trim();
    if (raw.startsWith('+63')) raw = '0' + raw.slice(3);
    else if (raw.startsWith('63') && raw.length >= 11) raw = '0' + raw.slice(2);
    else if (raw.length === 10 && raw.startsWith('9')) raw = '0' + raw;
    const digits = raw.replace(/\D/g, '').slice(0, 11);
    update('phone', digits);
    setTouchedFields(prev => ({ ...prev, phone: true }));
    const err = validateSingleField('phone', digits);
    setFieldErrors(pe => ({ ...pe, phone: err }));
  };

  /* ── Navigation Handlers ────────────────────────────────────────────── */
  const goToStep2 = () => {
    const allStep1Touched = { name: true, email: true, phone: true, password: true, confirmPassword: true };
    setTouchedFields(prev => ({ ...prev, ...allStep1Touched }));

    const errors = validateStep1();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError('Please resolve all highlighted errors before continuing.');
      focusFirstError(errors);
      return;
    }
    setError('');
    setFieldErrors({});
    setStep(2);
  };

  const handleFormSubmit = (e) => {
    e.preventDefault();
    if (step === 1) {
      goToStep2();
    } else {
      executeSubmit();
    }
  };

  const executeSubmit = async () => {
    const step1Errors = validateStep1();
    if (Object.keys(step1Errors).length > 0) {
      setStep(1);
      setFieldErrors(step1Errors);
      setError('Please resolve all errors in your account information.');
      focusFirstError(step1Errors);
      return;
    }

    const allStep2Touched = {
      address_province: true, address_city: true, address_barangay: true,
      address_street: true, address_lot_block: true, address_landmark: true,
    };
    setTouchedFields(prev => ({ ...prev, ...allStep2Touched }));

    const step2Errors = validateStep2();
    if (Object.keys(step2Errors).length > 0) {
      setFieldErrors(step2Errors);
      setError('Please complete all required address fields highlighted below.');
      focusFirstError(step2Errors);
      return;
    }

    setError('');
    setFieldErrors({});
    setLoading(true);

    try {
      const normalizedAddress = normalizeProfileAddressFields(form);
      const result = await register(form.email.trim(), form.password, {
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
        try { sessionStorage.removeItem('reg_draft'); } catch (e) {}
        setSuccess(true);
        setTimeout(() => navigate('/'), 1400);
      } else {
        const errorMsg = result.error || 'Registration failed. Please try again.';
        setError(errorMsg);
        if (errorMsg.toLowerCase().includes('email')) {
          setStep(1);
          setFieldErrors({ email: errorMsg });
          focusFirstError({ email: errorMsg });
        } else if (errorMsg.toLowerCase().includes('password')) {
          setStep(1);
          setFieldErrors({ password: errorMsg });
          focusFirstError({ password: errorMsg });
        } else {
          requestAnimationFrame(() => {
            errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            errorRef.current?.focus({ preventScroll: true });
          });
        }
      }
    } catch (err) {
      setLoading(false);
      const msg = err.message || 'Registration failed. Please try again.';
      setError(msg);
      requestAnimationFrame(() => {
        errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        errorRef.current?.focus({ preventScroll: true });
      });
    }
  };

  /* ── Success Flash View ── */
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
              <span style={{ color: 'var(--primary-text)' }}>EXPRESS</span>
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

        {/* ── Interactive Step Progress Bar ── */}
        <div className="reg-step-bar" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={2}>
          {STEPS.map((s, idx) => (
            <div key={s.id} className="reg-step-item">
              <button
                type="button"
                className={`reg-step-node ${step === s.id ? 'active' : ''} ${step > s.id ? 'completed' : ''}`}
                onClick={() => {
                  if (s.id === 1) {
                    setError('');
                    setStep(1);
                  } else if (s.id === 2) {
                    goToStep2();
                  }
                }}
                aria-label={`Step ${s.id}: ${s.label}`}
              >
                <div className="reg-step-circle">
                  {step > s.id
                    ? <Check size={13} strokeWidth={3} />
                    : <s.icon size={13} />
                  }
                </div>
                <span className="reg-step-label">{s.label}</span>
              </button>
              {idx < STEPS.length - 1 && (
                <div className={`reg-step-connector ${step > s.id ? 'done' : ''}`} />
              )}
            </div>
          ))}
        </div>

        {/* ── Error Banner ── */}
        {error && (
          <div className="auth-error-banner" role="alert" tabIndex={-1} ref={errorRef}>
            <AlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleFormSubmit} noValidate>

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
                  Full Name <span className="required">*</span>
                </label>
                <div className="form-input-wrapper">
                  <User size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-name"
                    className={`form-input form-input-icon-left ${fieldErrors.name ? 'field-invalid' : touchedFields.name && form.name.trim().length >= 2 ? 'success' : ''}`}
                    placeholder="Juan Dela Cruz"
                    value={form.name}
                    onChange={handleTitleCase('name')}
                    onBlur={() => handleBlur('name')}
                    required
                    autoComplete="name"
                    aria-required="true"
                    aria-invalid={!!fieldErrors.name}
                    aria-describedby={fieldErrors.name ? 'reg-name-error' : undefined}
                  />
                  {form.name.trim().length >= 2 && !fieldErrors.name && (
                    <Check size={14} className="form-input-icon-right-check" aria-hidden="true" />
                  )}
                </div>
                {fieldErrors.name && (
                  <FieldError id="reg-name-error" message={fieldErrors.name} />
                )}
              </div>

              {/* Facebook Name */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-facebook">
                  Facebook Name <span className="required">*</span>
                </label>
                <div className="form-input-wrapper">
                  <MessageSquare size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-facebook"
                    className={`form-input form-input-icon-left ${fieldErrors.facebook_name ? 'field-invalid' : ''}`}
                    placeholder="Your Facebook display name"
                    value={form.facebook_name}
                    onChange={e => update('facebook_name', e.target.value)}
                    onBlur={() => handleBlur('facebook_name')}
                    required
                    autoComplete="nickname"
                    aria-required="true"
                    aria-invalid={!!fieldErrors.facebook_name}
                    aria-describedby={fieldErrors.facebook_name ? 'reg-facebook-error' : undefined}
                  />
                </div>
                {fieldErrors.facebook_name && (
                  <FieldError id="reg-facebook-error" message={fieldErrors.facebook_name} />
                )}
              </div>

              {/* Email */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-email">
                  Email Address <span className="required">*</span>
                </label>
                <div className="form-input-wrapper">
                  <Mail size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-email"
                    type="email"
                    className={`form-input form-input-icon-left ${fieldErrors.email ? 'field-invalid' : isEmailValid(form.email) ? 'success' : ''}`}
                    placeholder="you@email.com"
                    value={form.email}
                    onChange={e => update('email', e.target.value)}
                    onBlur={() => handleBlur('email')}
                    required
                    autoComplete="email"
                    aria-required="true"
                    aria-invalid={!!fieldErrors.email}
                    aria-describedby={fieldErrors.email ? 'reg-email-error' : undefined}
                  />
                  {isEmailValid(form.email) && !fieldErrors.email && (
                    <Check size={14} className="form-input-icon-right-check" aria-hidden="true" />
                  )}
                </div>
                {fieldErrors.email && (
                  <FieldError id="reg-email-error" message={fieldErrors.email} />
                )}
              </div>

              {/* Mobile */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-phone">
                  Mobile Number <span className="required">*</span>
                </label>
                <div className="form-input-wrapper">
                  <Phone size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-phone"
                    className={`form-input form-input-icon-left ${fieldErrors.phone ? 'field-invalid' : form.phone.length === 11 && isPhoneValid(form.phone) ? 'success' : ''}`}
                    placeholder="09xxxxxxxxx"
                    value={form.phone}
                    onChange={handlePhone}
                    onBlur={() => handleBlur('phone')}
                    inputMode="numeric"
                    maxLength={11}
                    autoComplete="tel"
                    aria-describedby="reg-phone-hint reg-phone-error"
                    aria-invalid={!!fieldErrors.phone}
                  />
                  {form.phone.length === 11 && isPhoneValid(form.phone) && !fieldErrors.phone && (
                    <Check size={14} className="form-input-icon-right-check" aria-hidden="true" />
                  )}
                </div>
                <div className="form-meta-row" id="reg-phone-hint">
                  {fieldErrors.phone
                    ? <FieldError id="reg-phone-error" message={fieldErrors.phone} />
                    : <span className="form-helper">Philippine mobile number (09xxxxxxxxx)</span>
                  }
                  <span className="form-char-count">{form.phone.length}/11</span>
                </div>
              </div>

              {/* Password */}
              <div className="form-group">
                <div className="login-pw-header">
                  <label className="form-label" htmlFor="reg-password">Password <span className="required">*</span></label>
                  {capsLockOn && (
                    <span className="caps-warning" style={{ fontSize: '0.72rem', color: 'var(--warning-text)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <AlertTriangle size={11} /> Caps Lock ON
                    </span>
                  )}
                </div>
                <div className="form-input-wrapper">
                  <Lock size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-password"
                    type={showPw ? 'text' : 'password'}
                    className={`form-input form-input-icon-left form-input-icon-right ${fieldErrors.password ? 'field-invalid' : form.password && !getPasswordError(form.password) ? 'success' : ''}`}
                    placeholder="Min. 8 characters"
                    value={form.password}
                    onChange={e => update('password', e.target.value)}
                    onBlur={() => handleBlur('password')}
                    onKeyDown={checkCapsLock}
                    onKeyUp={checkCapsLock}
                    required
                    autoComplete="new-password"
                    aria-required="true"
                    aria-describedby={fieldErrors.password ? 'reg-password-error reg-pw-strength' : 'reg-pw-strength'}
                    aria-invalid={!!fieldErrors.password}
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
                {fieldErrors.password && (
                  <FieldError id="reg-password-error" message={fieldErrors.password} />
                )}

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
                  Confirm Password <span className="required">*</span>
                </label>
                <div className="form-input-wrapper">
                  <Lock size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-confirm-password"
                    type={showConfirmPw ? 'text' : 'password'}
                    className={`form-input form-input-icon-left form-input-icon-right ${
                      fieldErrors.confirmPassword ? 'field-invalid' :
                      form.confirmPassword && form.confirmPassword === form.password ? 'success' : ''
                    }`}
                    placeholder="Repeat password"
                    value={form.confirmPassword}
                    onChange={e => update('confirmPassword', e.target.value)}
                    onBlur={() => handleBlur('confirmPassword')}
                    onKeyDown={checkCapsLock}
                    onKeyUp={checkCapsLock}
                    required
                    autoComplete="new-password"
                    aria-required="true"
                    aria-invalid={!!fieldErrors.confirmPassword}
                    aria-describedby={fieldErrors.confirmPassword ? 'reg-confirm-password-error' : undefined}
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
                {fieldErrors.confirmPassword && (
                  <FieldError id="reg-confirm-password-error" message={fieldErrors.confirmPassword} />
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
                  Province <span className="required">*</span>
                </label>
                <div className="form-input-wrapper">
                  <MapPin size={15} className="form-input-icon" aria-hidden="true" />
                  <CustomSelect
                    id="reg-province"
                    className={`form-select form-input-icon-left ${fieldErrors.address_province ? 'field-invalid' : form.address_province ? 'success' : ''}`}
                    value={form.address_province}
                    onChange={e => {
                      update('address_province', e.target.value);
                      update('address_city', '');
                    }}
                    autoComplete="address-level1"
                    aria-required="true"
                    aria-invalid={!!fieldErrors.address_province}
                    aria-describedby={fieldErrors.address_province ? 'reg-province-error' : undefined}
                  >
                    <option value="">Select Province</option>
                    {VALID_PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
                  </CustomSelect>
                </div>
                {fieldErrors.address_province && (
                  <FieldError id="reg-province-error" message={fieldErrors.address_province} />
                )}
              </div>

              {/* City */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-city">City / Municipality <span className="required">*</span></label>
                <div className="form-input-wrapper">
                  <Landmark size={15} className="form-input-icon" aria-hidden="true" />
                  <CustomSelect
                    id="reg-city"
                    className={`form-select form-input-icon-left ${fieldErrors.address_city ? 'field-invalid' : form.address_city ? 'success' : ''}`}
                    value={form.address_city}
                    onChange={e => update('address_city', e.target.value)}
                    autoComplete="address-level2"
                    disabled={!form.address_province}
                    aria-required="true"
                    aria-invalid={!!fieldErrors.address_city}
                    aria-describedby={fieldErrors.address_city ? 'reg-city-error' : undefined}
                  >
                    <option value="">Select City</option>
                    {cities.map(c => <option key={c} value={c}>{c}</option>)}
                  </CustomSelect>
                </div>
                {fieldErrors.address_city && (
                  <FieldError id="reg-city-error" message={fieldErrors.address_city} />
                )}
              </div>

              {/* Barangay */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-barangay">Barangay <span className="required">*</span></label>
                <div className="form-input-wrapper">
                  <Home size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-barangay"
                    className={`form-input form-input-icon-left ${fieldErrors.address_barangay ? 'field-invalid' : touchedFields.address_barangay && form.address_barangay.trim() ? 'success' : ''}`}
                    placeholder="e.g. Barangay Poblacion"
                    value={form.address_barangay}
                    onChange={handleTitleCase('address_barangay')}
                    onBlur={() => handleBlur('address_barangay')}
                    required
                    autoComplete="address-level3"
                    aria-required="true"
                    aria-invalid={!!fieldErrors.address_barangay}
                    aria-describedby={fieldErrors.address_barangay ? 'reg-barangay-error' : undefined}
                  />
                </div>
                {fieldErrors.address_barangay && (
                  <FieldError id="reg-barangay-error" message={fieldErrors.address_barangay} />
                )}
              </div>

              {/* Street */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-street">Street <span className="required">*</span></label>
                <div className="form-input-wrapper">
                  <MapPin size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-street"
                    className={`form-input form-input-icon-left ${fieldErrors.address_street ? 'field-invalid' : touchedFields.address_street && form.address_street.trim() ? 'success' : ''}`}
                    placeholder="e.g. Rizal Street"
                    value={form.address_street}
                    onChange={handleTitleCase('address_street')}
                    onBlur={() => handleBlur('address_street')}
                    required
                    autoComplete="street-address"
                    aria-required="true"
                    aria-invalid={!!fieldErrors.address_street}
                    aria-describedby={fieldErrors.address_street ? 'reg-street-error' : undefined}
                  />
                </div>
                {fieldErrors.address_street && (
                  <FieldError id="reg-street-error" message={fieldErrors.address_street} />
                )}
              </div>

              {/* Lot/Block */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-lot">Lot / Block / Purok <span className="required">*</span></label>
                <div className="form-input-wrapper">
                  <Home size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-lot"
                    className={`form-input form-input-icon-left ${fieldErrors.address_lot_block ? 'field-invalid' : touchedFields.address_lot_block && form.address_lot_block.trim() ? 'success' : ''}`}
                    placeholder="e.g. Lot 12, Block 5"
                    value={form.address_lot_block}
                    onChange={handleTitleCase('address_lot_block')}
                    onBlur={() => handleBlur('address_lot_block')}
                    required
                    aria-required="true"
                    aria-invalid={!!fieldErrors.address_lot_block}
                    aria-describedby={fieldErrors.address_lot_block ? 'reg-lot-error' : undefined}
                  />
                </div>
                {fieldErrors.address_lot_block && (
                  <FieldError id="reg-lot-error" message={fieldErrors.address_lot_block} />
                )}
              </div>

              {/* Landmark */}
              <div className="form-group">
                <label className="form-label" htmlFor="reg-landmark">Landmark <span className="required">*</span></label>
                <div className="form-input-wrapper">
                  <Navigation size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="reg-landmark"
                    className={`form-input form-input-icon-left ${fieldErrors.address_landmark ? 'field-invalid' : touchedFields.address_landmark && form.address_landmark.trim() ? 'success' : ''}`}
                    placeholder="e.g. Near Sari-sari Store, Beside Church"
                    value={form.address_landmark}
                    onChange={handleTitleCase('address_landmark')}
                    onBlur={() => handleBlur('address_landmark')}
                    required
                    aria-required="true"
                    aria-invalid={!!fieldErrors.address_landmark}
                    aria-describedby={fieldErrors.address_landmark ? 'reg-landmark-error' : undefined}
                  />
                </div>
                {fieldErrors.address_landmark && (
                  <FieldError id="reg-landmark-error" message={fieldErrors.address_landmark} />
                )}
              </div>

              {/* Terms note */}
              <div className="reg-address-note" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
                <ShieldCheck size={14} style={{ color: 'var(--primary-text)', marginTop: 2 }} />
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                  By creating an account, you agree to CargoExpress PH's Terms of Service and Privacy Policy.
                </p>
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
                    ? <><Loader size={16} className="animate-spin" /> Creating Account…</>
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
