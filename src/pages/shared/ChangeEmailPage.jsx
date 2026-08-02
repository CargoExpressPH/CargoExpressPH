import { useState, useCallback } from 'react';
import { useNavigate, useBlocker } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  ArrowLeft, Loader, Mail, Lock, CheckCircle2, Eye, EyeOff, ShieldCheck, Inbox,
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from '../../components/ui/ConfirmModal';
import usePageTitle from '../../hooks/usePageTitle';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ChangeEmailPage = () => {
  usePageTitle('Change Email');
  const { user, userProfile, changeEmail } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [newEmail,        setNewEmail]        = useState('');
  const [confirmEmail,    setConfirmEmail]    = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [showPassword,    setShowPassword]    = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [submitted,       setSubmitted]       = useState(false);

  const currentEmail = user?.email || userProfile?.email || '';
  const role = userProfile?.role;
  const profilePath = role === 'admin' ? '/admin/profile' : '/customer/profile';

  // Block navigation when the form has unsaved input (but never after success)
  const isFormDirty = useCallback(
    () => !submitted && Boolean(newEmail || confirmEmail || currentPassword),
    [newEmail, confirmEmail, currentPassword, submitted]
  );
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    return isFormDirty() && currentLocation.pathname !== nextLocation.pathname;
  });

  const newEmailTrimmed = newEmail.trim();
  const confirmTrimmed = confirmEmail.trim();
  const validEmail = EMAIL_RE.test(newEmailTrimmed);
  const isDifferent = newEmailTrimmed.toLowerCase() !== currentEmail.toLowerCase();
  const emailsMatch = newEmailTrimmed === confirmTrimmed;
  const canSubmit = validEmail && isDifferent && emailsMatch && Boolean(currentPassword) && !loading;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!currentEmail) { toast.error('You are not logged in.'); return; }
    if (!validEmail) { toast.error('Please enter a valid email address.'); return; }
    if (!isDifferent) { toast.error('New email must be different from your current email.'); return; }
    if (!emailsMatch) { toast.error('Emails do not match.'); return; }
    if (!currentPassword) { toast.error('Please enter your current password.'); return; }

    setLoading(true);
    try {
      const result = await changeEmail(newEmailTrimmed, currentPassword);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setSubmitted(true);
    } catch (err) {
      let msg = 'Failed to update email. Please try again.';
      if (err?.message) msg = err.message;
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const goBackToProfile = () => {
    if (role === 'admin' || role === 'customer') {
      navigate(profilePath, { replace: true });
    } else {
      navigate(-1);
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
        message="You have entered information in this form. If you leave now, your input will be lost."
        confirmLabel="Discard"
        cancelLabel="Stay"
        variant="danger"
      />

      <div className="page-transition animate-slide-up" style={{ maxWidth: 520 }}>
        <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
          <ArrowLeft size={18} /> Back
        </button>
        <h1 className="fw-800 mb-20">Change Email</h1>

        {submitted ? (
          <div className="card">
            <div className="card-body auth-success-card">
              <div className="auth-success-icon">
                <Inbox size={36} />
              </div>
              <div className="auth-success-title">Check your new inbox</div>
              <p className="auth-success-sub">
                We sent a confirmation link to <strong>{newEmailTrimmed}</strong>.
                Your email will be updated once you click it.
              </p>
              <ol className="auth-success-sub" role="list" style={{ textAlign: 'left', marginTop: 8 }}>
                <li role="listitem">Open the confirmation email sent to <strong>{newEmailTrimmed}</strong></li>
                <li role="listitem">Click the <strong>Confirm change</strong> button inside</li>
                <li role="listitem">You'll be signed in with your new email automatically</li>
              </ol>
              <p className="form-helper" style={{ textAlign: 'center' }}>
                Until then, you can still sign in with your current email.
                Check your spam folder if the email doesn't arrive.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-lg w-full justify-center mt-8"
                onClick={goBackToProfile}
              >
                Back to Profile
              </button>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="card-body">

              {/* Current Email */}
              <div className="form-group">
                <label className="form-label" htmlFor="change-current-email">Current Email</label>
                <div className="form-input-wrapper">
                  <Mail size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="change-current-email"
                    type="email"
                    className="form-input form-input-icon-left"
                    value={currentEmail}
                    disabled
                    aria-disabled="true"
                  />
                </div>
                <p className="form-helper">You must confirm your new email before it takes effect.</p>
              </div>

              {/* New Email */}
              <div className="form-group">
                <label className="form-label" htmlFor="change-new-email">New Email <span className="required">*</span></label>
                <div className="form-input-wrapper">
                  <Mail size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="change-new-email"
                    type="email"
                    className={`form-input form-input-icon-left ${
                      newEmail && (!validEmail || !isDifferent) ? 'error' :
                      newEmail && validEmail && isDifferent ? 'success' : ''
                    }`}
                    placeholder="newemail@example.com"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck="false"
                    aria-required="true"
                    aria-describedby="change-new-email-msg"
                  />
                </div>
                <div id="change-new-email-msg">
                  {newEmail && !validEmail && <p className="form-error">Please enter a valid email address.</p>}
                  {newEmail && validEmail && !isDifferent && (
                    <p className="form-error">New email must be different from your current email.</p>
                  )}
                  {newEmail && validEmail && isDifferent && (
                    <p className="rp-match-ok">Looks good — confirmation link will be sent here.</p>
                  )}
                </div>
              </div>

              {/* Confirm New Email */}
              <div className="form-group">
                <label className="form-label" htmlFor="change-confirm-email">Confirm New Email <span className="required">*</span></label>
                <div className="form-input-wrapper">
                  <Mail size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="change-confirm-email"
                    type="email"
                    className={`form-input form-input-icon-left ${
                      confirmEmail && !emailsMatch ? 'error' :
                      confirmEmail && emailsMatch && validEmail && isDifferent ? 'success' : ''
                    }`}
                    placeholder="Repeat new email"
                    value={confirmEmail}
                    onChange={e => setConfirmEmail(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck="false"
                    aria-required="true"
                  />
                </div>
                {confirmEmail && !emailsMatch && (
                  <p className="form-error">Emails don't match</p>
                )}
                {confirmEmail && emailsMatch && validEmail && isDifferent && (
                  <p className="rp-match-ok">
                    <CheckCircle2 size={13} /> Emails match
                  </p>
                )}
              </div>

              {/* Current Password */}
              <div className="form-group">
                <label className="form-label" htmlFor="change-email-password">Current Password <span className="required">*</span></label>
                <div className="form-input-wrapper">
                  <Lock size={15} className="form-input-icon" aria-hidden="true" />
                  <input
                    id="change-email-password"
                    type={showPassword ? 'text' : 'password'}
                    className="form-input form-input-icon-left form-input-icon-right"
                    placeholder="Enter your current password"
                    value={currentPassword}
                    onChange={e => setCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                    aria-required="true"
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
                <p className="form-helper">For your security, we verify your password before any change.</p>
              </div>

              {/* Submit */}
              <button
                type="button"
                className="btn btn-primary btn-lg w-full justify-center mt-8"
                onClick={handleSubmit}
                disabled={!canSubmit}
              >
                {loading
                  ? <><Loader size={18} className="animate-spin" /> Sending confirmation...</>
                  : <><ShieldCheck size={18} /> Update Email</>
                }
              </button>
              <p className="form-helper mt-12" style={{ textAlign: 'center' }}>
                A confirmation link will be sent to your new email address.
              </p>

            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default ChangeEmailPage;
