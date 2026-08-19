import { useState, useCallback } from 'react';
import { useNavigate, useBlocker } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  ArrowLeft, Loader, Mail, Lock, CheckCircle2, Eye, EyeOff, ShieldCheck, Inbox, Info,
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from '../../components/ui/ConfirmModal';
import usePageTitle from '../../hooks/usePageTitle';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { fieldAttrs, invalidClass } from '../../components/ui/FieldError';

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

  const { errors, validate, clearError } = useFieldErrors();

  const newEmailTrimmed = newEmail.trim();
  const confirmTrimmed = confirmEmail.trim();
  const validEmail = EMAIL_RE.test(newEmailTrimmed);
  const isDifferent = newEmailTrimmed.toLowerCase() !== currentEmail.toLowerCase();
  const emailsMatch = newEmailTrimmed === confirmTrimmed;

  /**
   * Problems visible while typing — only ever on a field the user has already
   * put something in, because telling someone their empty field is invalid
   * before they have reached it is noise. The empty-required case is the
   * submit-time half, below.
   */
  const liveErrors = {
    new_email: newEmail && !validEmail
      ? 'Please enter a valid email address.'
      : newEmail && !isDifferent
        ? 'New email must be different from your current email.'
        : null,
    confirm_email: confirmEmail && !emailsMatch ? "Emails don't match." : null,
  };
  // A submit-time error outranks the live one: it is the more specific answer
  // to why this particular attempt was rejected.
  const shownErrors = { ...liveErrors, ...errors };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!currentEmail) { toast.error('You are not logged in.'); return; }

    const ok = validate({
      new_email: !newEmailTrimmed
        ? 'Please enter your new email address.'
        : !validEmail
          ? 'Please enter a valid email address.'
          : !isDifferent
            ? 'New email must be different from your current email.'
            : null,
      confirm_email: !confirmTrimmed
        ? 'Please confirm your new email address.'
        : !emailsMatch
          ? "Emails don't match."
          : null,
      current_password: !currentPassword ? 'Please enter your current password.' : null,
    });
    if (!ok) return;

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
            <div className="card-body ce-success-body">
              <div className="ce-success-hero">
                <div className="ce-success-icon-wrap">
                  <div className="ce-success-ring" aria-hidden="true" />
                  <div className="ce-success-icon">
                    <Inbox size={34} aria-hidden="true" />
                  </div>
                </div>
                <h2 className="ce-success-title">Check your new inbox</h2>
                <p className="ce-success-subtitle">
                  We sent a confirmation link to{' '}
                  <strong className="ce-email-highlight">{newEmailTrimmed}</strong>.
                  Your email will be updated once you click it.
                </p>
              </div>

              <div className="ce-steps-box">
                <p className="ce-steps-label">What happens next?</p>
                <ol className="ce-steps-list">
                  <li className="ce-step-item">
                    <span className="ce-step-dot" aria-hidden="true">1</span>
                    <span>Open the confirmation email sent to <strong className="ce-email-highlight">{newEmailTrimmed}</strong></span>
                  </li>
                  <li className="ce-step-item">
                    <span className="ce-step-dot" aria-hidden="true">2</span>
                    <span>Click the <strong>Confirm change</strong> button inside</span>
                  </li>
                  <li className="ce-step-item">
                    <span className="ce-step-dot" aria-hidden="true">3</span>
                    <span>You'll be signed in with your new email automatically</span>
                  </li>
                </ol>
              </div>

              <div className="ce-note-box">
                <Info size={14} className="ce-note-icon" aria-hidden="true" />
                <span>Until then, you can still sign in with your current email. Check your spam folder if the email doesn't arrive.</span>
              </div>

              <button
                type="button"
                className="btn btn-primary btn-lg w-full justify-center ce-success-cta"
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
                      shownErrors.new_email ? invalidClass('new_email', shownErrors) :
                      newEmail && validEmail && isDifferent ? 'success' : ''
                    }`}
                    placeholder="newemail@example.com"
                    value={newEmail}
                    onChange={e => { setNewEmail(e.target.value); clearError('new_email'); }}
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck="false"
                    aria-required="true"
                    {...fieldAttrs('new_email', shownErrors)}
                  />
                </div>
                <FieldError name="new_email" errors={shownErrors} />
                {!shownErrors.new_email && newEmail && validEmail && isDifferent && (
                  <p className="rp-match-ok">Looks good — confirmation link will be sent here.</p>
                )}
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
                      shownErrors.confirm_email ? invalidClass('confirm_email', shownErrors) :
                      confirmEmail && emailsMatch && validEmail && isDifferent ? 'success' : ''
                    }`}
                    placeholder="Repeat new email"
                    value={confirmEmail}
                    onChange={e => { setConfirmEmail(e.target.value); clearError('confirm_email'); }}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck="false"
                    aria-required="true"
                    {...fieldAttrs('confirm_email', shownErrors)}
                  />
                </div>
                <FieldError name="confirm_email" errors={shownErrors} />
                {!shownErrors.confirm_email && confirmEmail && emailsMatch && validEmail && isDifferent && (
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
                    className={`form-input form-input-icon-left form-input-icon-right ${invalidClass('current_password', shownErrors)}`}
                    placeholder="Enter your current password"
                    value={currentPassword}
                    onChange={e => { setCurrentPassword(e.target.value); clearError('current_password'); }}
                    autoComplete="current-password"
                    aria-required="true"
                    {...fieldAttrs('current_password', shownErrors, 'change-email-password-helper')}
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
                <FieldError name="current_password" errors={shownErrors} />
                <p className="form-helper" id="change-email-password-helper">
                  For your security, we verify your password before any change.
                </p>
              </div>

              {/* Submit — enabled even when incomplete, so pressing it reports
                  what is missing instead of doing nothing. */}
              <button
                type="button"
                className="btn btn-primary btn-lg w-full justify-center mt-8"
                onClick={handleSubmit}
                disabled={loading}
              >
                {loading
                  ? <><Loader size={18} className="animate-spin" /> Sending confirmation...</>
                  : <><ShieldCheck size={18} /> Update Email</>
                }
              </button>
              <p className="form-helper mt-12 text-center">
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
