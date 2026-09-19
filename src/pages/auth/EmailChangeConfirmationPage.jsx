import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Loader, MailCheck } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { getEmailChangeLinkError } from '../../lib/emailChange';
import { logAuth } from '../../lib/activityLog';
import { BrandLogo, BrandWordmark } from '../../components/ui/BrandLogo';
import usePageTitle from '../../hooks/usePageTitle';

const EmailChangeConfirmationPage = () => {
  usePageTitle('Confirm Email Change');
  const navigate = useNavigate();
  const { userProfile, loading: authLoading, refreshProfile } = useAuth();
  const [state, setState] = useState({ status: 'verifying', message: '' });
  const loggedRef = useRef(false);

  useEffect(() => {
    if (authLoading) return undefined;

    const linkError = getEmailChangeLinkError();
    if (linkError) {
      setState({ status: 'error', message: linkError.message });
      return undefined;
    }

    let active = true;
    const verify = async () => {
      const { data, error } = await supabase.auth.getUser();
      if (!active) return;

      if (error || !data?.user) {
        setState({
          status: 'error',
          message: 'We could not verify this email-change link. It may be invalid, expired, or already used.',
        });
        return;
      }

      if (data.user.new_email) {
        setState({
          status: 'pending',
          message: 'This confirmation was accepted. Approve the message in the other inbox to finish changing your email.',
        });
        return;
      }

      await refreshProfile();
      if (!loggedRef.current) {
        loggedRef.current = true;
        void logAuth('Email change completed', {
          recordId: data.user.id,
          recordRef: 'email-change',
          details: 'Secure email change completed after confirmation.',
        });
      }
      setState({
        status: 'complete',
        message: 'Your sign-in email and profile have been updated successfully.',
      });
    };

    void verify();
    return () => { active = false; };
  }, [authLoading, refreshProfile]);

  const destination = userProfile?.role === 'admin'
    ? '/admin/profile'
    : userProfile?.role === 'customer'
      ? '/customer/profile'
      : '/login';

  const icon = state.status === 'complete'
    ? <CheckCircle2 size={48} />
    : state.status === 'pending'
      ? <MailCheck size={48} />
      : state.status === 'error'
        ? <AlertCircle size={48} />
        : <Loader size={40} className="animate-spin" />;

  const title = state.status === 'complete'
    ? 'Email changed successfully'
    : state.status === 'pending'
      ? 'One more confirmation needed'
      : state.status === 'error'
        ? 'Link expired or invalid'
        : 'Verifying email change...';

  return (
    <div className="auth-page">
      <div className="auth-orb auth-orb-1" aria-hidden="true" />
      <div className="auth-orb auth-orb-2" aria-hidden="true" />
      <div className="auth-card auth-success-card" role={state.status === 'error' ? 'alert' : 'status'}>
        <div className="auth-brand flex flex-row items-center justify-center" style={{ gap: 8 }}>
          <BrandLogo size={34} decorative />
          <div className="auth-brand-text"><BrandWordmark /></div>
        </div>
        <div className="auth-success-icon">{icon}</div>
        <h1 className="auth-success-title">{title}</h1>
        <p className="auth-success-sub">{state.message || 'This only takes a moment.'}</p>
        {state.status !== 'verifying' && (
          <button
            type="button"
            className="auth-submit-btn text-no-underline mt-12"
            onClick={() => navigate(destination, { replace: true })}
          >
            {state.status === 'pending' ? 'Return to Profile' : state.status === 'error' ? 'Continue' : 'Go to Profile'}
          </button>
        )}
      </div>
    </div>
  );
};

export default EmailChangeConfirmationPage;
