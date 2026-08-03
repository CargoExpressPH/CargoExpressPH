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

  const pwStrength = getPasswordStrength(password);

  const checks = {
    length:    password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number:    /[0-9]/.test(password),
  };
  const allChecks = Object.values(checks).every(Boolean);

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
    if (!currentPassword) { toast.error('Please enter your current password.'); return; }
    if (!allChecks) { toast.error('Password does not meet all requirements.'); return; }
    if (password !== confirmPassword) { toast.error('Passwords do not match.'); return; }
    setLoading(true);
    try {
      // 1) Verify the current password before allowing a change
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (verifyError) {
        toast.error('Current password is incorrect.');
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
    } catch (err) {
      let msg = 'Failed to update password. Please try again.';
      if (err?.code === 'PGRST301' || err?.message?.includes('JWT')) {
        msg = 'Session expired. Please sign in again.';
      } else if (err?.message) {
        msg = err.message;
      }
      toast.error(msg);
    } finally {
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
                className="form-input form-input-icon-left form-input-icon-right"
                placeholder="Enter your current password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
                aria-required="true"
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
          </div>

          {/* New Password */}
          <div className="form-group">
            <label className="form-label" htmlFor="change-new-password">New Password <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Lock size={15} className="form-input-icon" aria-hidden="true" />
              <input
                id="change-new-password"
                type={showPassword ? 'text' : 'password'}
                className="form-input form-input-icon-left form-input-icon-right"
                placeholder="Min. 8 characters"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                aria-required="true"
                aria-describedby="change-pw-strength"
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

          {/* Submit */}
          <button
            type="button"
            className="btn btn-primary btn-lg w-full justify-center mt-8"
            onClick={handleSubmit}
            disabled={loading || !allChecks || password !== confirmPassword}
          >
            {loading
              ? <><Loader size={18} className="animate-spin" /> Updating...</>
              : <><ShieldCheck size={18} /> Update Password</>
            }
          </button>
          <p className="form-helper mt-12" style={{ textAlign: 'center' }}>
            You must enter your current password to change it.
          </p>

        </div>
      </div>
      </div>
    </>
  );
};

export default ChangePasswordPage;
