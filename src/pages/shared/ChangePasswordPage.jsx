import { useState, useCallback } from 'react';
import { useNavigate, useBlocker } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  ArrowLeft, Loader, Lock, CheckCircle2,
  Eye, EyeOff, ShieldCheck, Check,
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from '../../components/ui/ConfirmModal';
import usePageTitle from '../../hooks/usePageTitle';
import { getPasswordStrength } from '../../utils/password';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { fieldAttrs, invalidClass } from '../../components/ui/FieldError';

const ChangePasswordPage = () => {
  usePageTitle('Change Password');
  const { user, userProfile } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const role = userProfile?.role;
  const profilePath = role === 'admin' ? '/admin/profile' : '/customer/profile';

  const [currentPassword,  setCurrentPassword]  = useState('');
  const [password,         setPassword]         = useState('');
  const [confirmPassword,  setConfirmPassword]  = useState('');
  const [showCurrent,      setShowCurrent]      = useState(false);
  const [showPassword,     setShowPassword]     = useState(false);
  const [showConfirm,      setShowConfirm]      = useState(false);
  const [loading,          setLoading]          = useState(false);

  const { errors, validate, clearError, setError: setFieldError } = useFieldErrors();

  const pwStrength = getPasswordStrength(password);

  const checks = {
    length:    password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number:    /[0-9]/.test(password),
  };
  const allChecks = Object.values(checks).every(Boolean);

  // The mismatch is worth saying while typing; the empty case is not, because
  // an untouched confirm field is not yet a mistake. Submit-time errors take
  // precedence — they explain this attempt.
  const confirmShown = {
    ...(confirmPassword && password !== confirmPassword
      ? { confirm_password: "Passwords don't match." }
      : {}),
    ...errors,
  };
  const confirmError = confirmShown.confirm_password;

  // Block navigation when the form has unsaved input
  const isFormDirty = useCallback(
    () => Boolean(currentPassword || password || confirmPassword),
    [currentPassword, password, confirmPassword]
  );
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    return isFormDirty() && currentLocation.pathname !== nextLocation.pathname;
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!user?.email) { toast.error('You are not logged in.'); return; }

    const ok = validate({
      current_password: !currentPassword ? 'Please enter your current password.' : null,
      new_password: !password
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
      // 1) Verify the current password before allowing a change
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (verifyError) {
        // Attributable to a specific field, so it is reported at that field
        // rather than in a toast the user must map back to an input themselves.
        setFieldError('current_password', 'Current password is incorrect.');
        setLoading(false);
        return;
      }
      // 2) Update to the new password
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setCurrentPassword('');
      setPassword('');
      setConfirmPassword('');
      toast.success('Password updated successfully!');
      setTimeout(() => navigate(profilePath, { replace: true }), 1200);
      // Not clearing `loading` here: the navigation is still 1200ms away, and
      // resetting it now would re-enable the form for that whole window
      // before the page actually leaves.
    } catch (err) {
      let msg = 'Failed to update password. Please try again.';
      if (err?.code === 'PGRST301' || err?.message?.includes('JWT')) {
        msg = 'Session expired. Please sign in again.';
      } else if (err?.message) {
        msg = err.message;
      }
      toast.error(msg);
      setLoading(false);
    }
  };

  return (
    <>
      {/* Unsaved changes guard modal */}
      <ConfirmModal
        isOpen={blocker.state === 'blocked'}
        onClose={() => blocker.reset()}
        onConfirm={() => blocker.proceed()}
        title="Discard unsaved changes?"
        message="You have entered a password in this form. If you leave now, your input will be lost."
        confirmLabel="Discard"
        cancelLabel="Stay"
        variant="danger"
      />

      <div className="animate-slide-up customer-personal-info-page">
      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>
      <h1 className="fw-800 mb-20">Change Password</h1>

      <div className="card">
        <div className="card-body">

          {/* Current Password */}
          <div className="form-group">
            <label className="form-label" htmlFor="change-current-password">Current Password <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Lock size={15} className="form-input-icon" aria-hidden="true" />
              <input
                id="change-current-password"
                type={showCurrent ? 'text' : 'password'}
                className={`form-input form-input-icon-left form-input-icon-right ${invalidClass('current_password', errors)}`}
                placeholder="Enter your current password"
                value={currentPassword}
                onChange={e => { setCurrentPassword(e.target.value); clearError('current_password'); }}
                required
                autoComplete="current-password"
                aria-required="true"
                {...fieldAttrs('current_password', errors)}
              />
              <button
                type="button"
                onClick={() => setShowCurrent(!showCurrent)}
                className="form-pw-toggle"
                aria-label={showCurrent ? 'Hide password' : 'Show password'}
                aria-pressed={showCurrent}
              >
                {showCurrent ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <FieldError name="current_password" errors={errors} />
          </div>

          {/* New Password */}
          <div className="form-group">
            <label className="form-label" htmlFor="change-new-password">New Password <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Lock size={15} className="form-input-icon" aria-hidden="true" />
              <input
                id="change-new-password"
                type={showPassword ? 'text' : 'password'}
                className={`form-input form-input-icon-left form-input-icon-right ${invalidClass('new_password', errors)}`}
                placeholder="Min. 8 characters"
                value={password}
                onChange={e => { setPassword(e.target.value); clearError('new_password'); }}
                required
                minLength={8}
                autoComplete="new-password"
                aria-required="true"
                {...fieldAttrs('new_password', errors, 'change-pw-strength')}
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
            <FieldError name="new_password" errors={errors} />

            {password && (
              <div className="pw-strength-wrap" id="change-pw-strength" aria-live="polite">
                <div className="pw-strength-bars">
                  {[1, 2, 3, 4].map(i => (
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
          </div>

          {/* Confirm New Password */}
          <div className="form-group">
            <label className="form-label" htmlFor="change-confirm-password">Confirm New Password <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Lock size={15} className="form-input-icon" aria-hidden="true" />
              <input
                id="change-confirm-password"
                type={showConfirm ? 'text' : 'password'}
                className={`form-input form-input-icon-left form-input-icon-right ${
                  confirmError ? 'field-invalid' :
                  confirmPassword && confirmPassword === password ? 'success' : ''
                }`}
                placeholder="Repeat new password"
                value={confirmPassword}
                onChange={e => { setConfirmPassword(e.target.value); clearError('confirm_password'); }}
                required
                autoComplete="new-password"
                aria-required="true"
                {...fieldAttrs('confirm_password', confirmShown)}
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
            <FieldError name="confirm_password" errors={confirmShown} />
            {!confirmError && confirmPassword && password === confirmPassword && allChecks && (
              <p className="rp-match-ok">
                <CheckCircle2 size={13} /> Passwords match
              </p>
            )}
          </div>

          {/* Submit */}
          <button
            type="button"
            className="btn btn-primary btn-lg w-full justify-center mt-8"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading
              ? <><Loader size={18} className="animate-spin" /> Updating...</>
              : <><ShieldCheck size={18} /> Update Password</>
            }
          </button>
          <p className="form-helper mt-12 text-center">
            You must enter your current password to change it.
          </p>

        </div>
      </div>
      </div>
    </>
  );
};

export default ChangePasswordPage;
