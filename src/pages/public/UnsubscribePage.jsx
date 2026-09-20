import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MailX, CheckCircle2, AlertTriangle, Loader, ShieldAlert } from 'lucide-react';
import { checkUnsubscribeStatus, confirmUnsubscribe } from '../../lib/database';
import usePageTitle from '../../hooks/usePageTitle';
import BrandLockup from '../../components/ui/BrandLogo';

// Shows enough of the address to recognize it without printing the whole
// thing in page content ("avoid exposing the recipient's full email...
// unnecessarily") — e.g. "ju***@gmail.com".
const maskEmail = (email) => {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return email || '';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 3))}@${domain}`;
};

// A plain reopen/retry of this page must be safe: it only ever reads the
// current preference (checkUnsubscribeStatus). The actual, one-time-mutating
// call (confirmUnsubscribe) fires exclusively from the button's onClick
// below, never from an effect — so a mail-scanner or link-preview bot that
// fetches this page's URL can only ever trigger the read, never the write.
const STATES = {
  LOADING: 'loading',
  CONFIRM: 'confirm',
  ALREADY: 'already',
  DONE: 'done',
  INVALID: 'invalid',
  ERROR: 'error',
};

const UnsubscribePage = () => {
  usePageTitle('Email Preferences');
  const [searchParams] = useSearchParams();
  const email = (searchParams.get('email') || '').trim();
  const token = (searchParams.get('token') || '').trim();

  const [state, setState] = useState(STATES.LOADING);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const runCheck = useCallback(async () => {
    setState(STATES.LOADING);
    if (!email || !token) {
      setState(STATES.INVALID);
      setErrorMsg('This unsubscribe link is incomplete. Please use the link from the email exactly as sent.');
      return;
    }
    try {
      const result = await checkUnsubscribeStatus({ email, token });
      setState(result.alreadyUnsubscribed ? STATES.ALREADY : STATES.CONFIRM);
    } catch (e) {
      const reason = e?.message;
      if (reason === 'invalid' || reason === 'malformed') {
        setState(STATES.INVALID);
        setErrorMsg('We could not verify this unsubscribe link. If you keep seeing this, contact support instead.');
      } else if (reason === 'missing') {
        setState(STATES.INVALID);
        setErrorMsg('This unsubscribe link is incomplete. Please use the link from the email exactly as sent.');
      } else {
        setState(STATES.ERROR);
        setErrorMsg(reason === 'server_error'
          ? 'We could not check your preference just now. Please try again shortly.'
          : (e?.message || 'Something went wrong. Please try again.'));
      }
    }
  }, [email, token]);

  useEffect(() => { runCheck(); }, [runCheck]);

  const handleUnsubscribe = async () => {
    setBusy(true);
    setErrorMsg('');
    try {
      await confirmUnsubscribe({ email, token });
      setState(STATES.DONE);
    } catch (e) {
      const reason = e?.message;
      if (reason === 'invalid' || reason === 'malformed' || reason === 'missing') {
        setState(STATES.INVALID);
        setErrorMsg('We could not verify this unsubscribe link. If you keep seeing this, contact support instead.');
      } else {
        // Network/backend failure — stay on the confirm screen and show a
        // clear error. Never advance to the "done" state without an
        // explicit success response from the server.
        setErrorMsg(reason === 'server_error'
          ? 'We could not update your preference just now. Please try again.'
          : (e?.message || 'Could not reach the server. Check your connection and try again.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main-content" style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', background: 'var(--bg-secondary)',
    }}>
      <div style={{
        background: 'var(--surface)', borderRadius: 16, padding: '36px 32px', maxWidth: 440,
        width: '100%', textAlign: 'center', boxShadow: 'var(--shadow-lg)',
      }}>
        <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'center' }}>
          <BrandLockup size={28} />
        </div>

        {state === STATES.LOADING && (
          <>
            <Loader size={32} className="spin" style={{ color: 'var(--text-secondary)', margin: '0 auto 12px', animation: 'spin 1s linear infinite' }} />
            <p style={{ color: 'var(--text-secondary)' }}>Checking your link…</p>
          </>
        )}

        {state === STATES.CONFIRM && (
          <>
            <MailX size={36} style={{ color: 'var(--success-text)', margin: '0 auto 12px' }} />
            <h1 style={{ fontSize: '1.25rem', margin: '0 0 8px', color: 'var(--text)' }}>Unsubscribe from announcement emails?</h1>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 4px' }}>
              This will stop CargoExpress PH announcement and promo emails for
            </p>
            <p style={{ color: 'var(--text)', fontWeight: 600, margin: '0 0 16px', wordBreak: 'break-word' }}>{maskEmail(email)}</p>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '.85rem', lineHeight: 1.5, margin: '0 0 20px' }}>
              Essential booking, payment, and shipment updates for any existing orders are not affected.
            </p>
            {errorMsg && (
              <p role="alert" style={{ color: 'var(--error-text)', background: 'var(--error-bg)', borderRadius: 8, padding: '10px 12px', fontSize: '.85rem', margin: '0 0 16px' }}>
                {errorMsg}
              </p>
            )}
            <button type="button" onClick={handleUnsubscribe} disabled={busy} className="btn btn-primary" style={{ width: '100%' }}>
              {busy ? 'Unsubscribing…' : 'Unsubscribe'}
            </button>
          </>
        )}

        {state === STATES.ALREADY && (
          <>
            <CheckCircle2 size={36} style={{ color: 'var(--success-text)', margin: '0 auto 12px' }} />
            <h1 style={{ fontSize: '1.25rem', margin: '0 0 8px', color: 'var(--text)' }}>Already unsubscribed</h1>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
              {maskEmail(email)} is not receiving CargoExpress PH announcement emails. No action is needed.
            </p>
          </>
        )}

        {state === STATES.DONE && (
          <>
            <CheckCircle2 size={36} style={{ color: 'var(--success-text)', margin: '0 auto 12px' }} />
            <h1 style={{ fontSize: '1.25rem', margin: '0 0 8px', color: 'var(--text)' }}>You're unsubscribed</h1>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 8px' }}>
              {maskEmail(email)} will no longer receive CargoExpress PH announcement or promo emails.
            </p>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '.85rem', lineHeight: 1.5, margin: 0 }}>
              Essential booking, payment, and shipment notifications for any existing orders will still be sent.
              You can re-enable announcement emails anytime from your Profile if you have an account.
            </p>
          </>
        )}

        {state === STATES.INVALID && (
          <>
            <ShieldAlert size={36} style={{ color: 'var(--error-text)', margin: '0 auto 12px' }} />
            <h1 style={{ fontSize: '1.25rem', margin: '0 0 8px', color: 'var(--text)' }}>Link not valid</h1>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>{errorMsg}</p>
          </>
        )}

        {state === STATES.ERROR && (
          <>
            <AlertTriangle size={36} style={{ color: 'var(--warning-text)', margin: '0 auto 12px' }} />
            <h1 style={{ fontSize: '1.25rem', margin: '0 0 8px', color: 'var(--text)' }}>Something went wrong</h1>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 16px' }}>{errorMsg}</p>
            <button type="button" onClick={runCheck} className="btn btn-outline" style={{ width: '100%' }}>Try again</button>
          </>
        )}

        <p style={{ marginTop: 24 }}>
          <Link to="/" style={{ color: 'var(--text-tertiary)', fontSize: '.85rem', textDecoration: 'underline' }}>Back to CargoExpress PH</Link>
        </p>
      </div>
    </main>
  );
};

export default UnsubscribePage;
