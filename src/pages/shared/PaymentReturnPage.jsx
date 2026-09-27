import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import {
  clearPaymentReturnContext,
  getPaymentReturnContext,
} from '../../lib/paymentReturnContext';
import usePageTitle from '../../hooks/usePageTitle';
import { CircleAlert, CircleCheck, Clock } from 'lucide-react';
import BrandLockup from '../../components/ui/BrandLogo';

const TERMINAL_PHASES = new Set(['confirmed', 'failed', 'invalid']);
const AUTO_CHECK_DELAYS = [0, 1500, 3000, 5000, 8000, 12000];

/**
 * Public Device B landing page for a PayMongo redirect.
 *
 * Payment verification does not depend on auth state or localStorage. The
 * high-entropy return capability in the URL is sent to the public Edge
 * Function, which validates its hash server-side and returns only a status
 * enum. Local storage is consulted only after confirmation to decide whether
 * this exact browser may navigate back to its own originating page.
 */
const PaymentReturnPage = () => {
  usePageTitle('Payment Status');
  const [searchParams] = useSearchParams();
  const returnToken = searchParams.get('return_token')?.trim() || '';
  const timerRef = useRef(null);
  const [phase, setPhase] = useState(returnToken ? 'verifying' : 'invalid');
  const [checking, setChecking] = useState(false);
  const [originatingReturnTo, setOriginatingReturnTo] = useState(null);
  const [closeFallbackVisible, setCloseFallbackVisible] = useState(false);

  // This is intentionally only a same-browser navigation convenience. The
  // server verification below never depends on auth or localStorage. Requiring
  // both the local capability and the same authenticated user prevents a
  // different logged-in account on Device B from being sent to a private page.
  useEffect(() => {
    let cancelled = false;
    const context = getPaymentReturnContext(returnToken);
    if (!context) return undefined;

    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled && data?.session?.user?.id === context.userId) {
        setOriginatingReturnTo(context.returnTo);
      }
    }).catch(() => {
      // A session read failure keeps the public fallback available.
    });

    return () => { cancelled = true; };
  }, [returnToken]);

  const verifyOnce = useCallback(async () => {
    if (!returnToken) {
      setPhase('invalid');
      return 'invalid';
    }

    setChecking(true);
    try {
      const { data, error } = await supabase.functions.invoke('verify-payment-return', {
        body: { returnToken },
      });

      if (error || !data?.status) {
        setPhase('unavailable');
        return 'unavailable';
      }

      const status = ['confirmed', 'processing', 'failed', 'invalid', 'unavailable'].includes(data.status)
        ? data.status
        : 'unavailable';
      setPhase(status);
      if (TERMINAL_PHASES.has(status) && timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return status;
    } catch {
      setPhase('unavailable');
      return 'unavailable';
    } finally {
      setChecking(false);
    }
  }, [returnToken]);

  useEffect(() => {
    let cancelled = false;
    let sawUnavailable = false;

    const wait = (delay) => new Promise((resolve) => {
      if (cancelled) {
        resolve();
        return;
      }
      timerRef.current = window.setTimeout(resolve, delay);
    });

    const verifyWithBoundedPolling = async () => {
      for (const delay of AUTO_CHECK_DELAYS) {
        if (delay) await wait(delay);
        if (cancelled) return;

        const status = await verifyOnce();
        if (status === 'unavailable') sawUnavailable = true;
        if (TERMINAL_PHASES.has(status)) return;
      }

      if (!cancelled) setPhase(sawUnavailable ? 'unavailable' : 'processing');
    };

    void verifyWithBoundedPolling();

    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [verifyOnce]);

  const checkAgain = async () => {
    if (checking) return;
    await verifyOnce();
  };

  const handleClose = () => {
    if (originatingReturnTo) {
      clearPaymentReturnContext(returnToken);
      // replace() prevents Back from reopening the checkout/return flow.
      window.location.replace(originatingReturnTo);
      return;
    }

    // Browsers only honor window.close() for tabs/windows opened by script.
    // Always render the fallback after attempting it so the user is never
    // trapped waiting for a programmatic close that the browser rejects.
    try {
      window.close();
    } catch {
      // Some embedded browsers throw instead of silently ignoring close().
    } finally {
      setCloseFallbackVisible(true);
    }
  };

  if (phase === 'verifying') {
    return (
      <main className="loading-screen" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <p>Verifying your payment…</p>
      </main>
    );
  }

  const copy = {
    confirmed: 'Your payment has been successfully confirmed.',
    processing: 'We are still confirming your payment. Please check again in a few seconds.',
    failed: 'Your payment could not be confirmed. You may close this page.',
    invalid: 'This payment confirmation link is invalid or expired.',
    unavailable: 'Payment verification is temporarily unavailable. Please try again.',
  };
  const title = {
    confirmed: 'Thank you for your payment!',
    failed: 'Payment not confirmed',
    invalid: 'Payment link unavailable',
  }[phase] || 'Payment verification';
  const tone = phase === 'confirmed' ? 'success' : phase === 'failed' || phase === 'invalid' ? 'error' : 'pending';
  const StatusIcon = tone === 'success' ? CircleCheck : tone === 'error' ? CircleAlert : Clock;
  const canRetry = phase === 'processing' || phase === 'unavailable';

  return (
    <main className="payment-return" aria-live="polite">
      <div className="payment-return-card">
        <BrandLockup size={32} className="payment-return-brand" />
        <span className={`payment-return-icon payment-return-icon--${tone}`} aria-hidden="true">
          <StatusIcon size={30} />
        </span>
        <h1 className="payment-return-title">{title}</h1>
        <p className="payment-return-text">{copy[phase] || copy.unavailable}</p>

        {phase === 'confirmed' && (
          <button type="button" className="btn btn-primary btn-block" onClick={handleClose}>
            {originatingReturnTo ? 'Return to CargoExpress' : 'Close'}
          </button>
        )}
        {phase === 'confirmed' && closeFallbackVisible && !originatingReturnTo && (
          <p className="payment-return-note">
            You may now close this tab and return to the device where you started your payment.
          </p>
        )}

        {canRetry && (
          <button type="button" className="btn btn-primary btn-block" onClick={checkAgain} disabled={checking} aria-busy={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        )}

        {/* A plain link, not a session-aware one: "/" already sends a
            signed-in visitor to their dashboard and a guest to the home page. */}
        {(phase === 'failed' || phase === 'invalid') && (
          <a className="btn btn-outline btn-block" href="/">Go to CargoExpress PH</a>
        )}
      </div>
    </main>
  );
};

export default PaymentReturnPage;
