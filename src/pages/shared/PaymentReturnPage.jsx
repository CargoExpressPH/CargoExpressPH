import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import {
  clearPaymentReturnContext,
  getPaymentReturnContext,
} from '../../lib/paymentReturnContext';
import usePageTitle from '../../hooks/usePageTitle';

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

  if (phase === 'confirmed') {
    return (
      <main className="loading-screen" aria-live="polite" style={{ padding: 24, textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--text-24)' }}>Thank you for your payment!</h1>
        <p className="text-secondary" style={{ maxWidth: 360, margin: '12px auto 0' }}>
          Your payment has been successfully confirmed.
        </p>
        <button
          type="button"
          onClick={handleClose}
          style={{
            marginTop: 20,
            padding: '10px 24px',
            background: 'var(--primary)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          {originatingReturnTo ? 'Return to CargoExpress' : 'Close'}
        </button>
        {closeFallbackVisible && !originatingReturnTo && (
          <p className="text-secondary" style={{ maxWidth: 360, margin: '12px auto 0' }}>
            You may now close this tab and return to the device where you started your payment.
          </p>
        )}
      </main>
    );
  }

  if (phase === 'verifying') {
    return (
      <main className="loading-screen" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <p>Verifying your payment…</p>
      </main>
    );
  }

  const copy = {
    processing: 'We are still confirming your payment. Please check again in a few seconds.',
    failed: 'Your payment could not be confirmed. You may close this page.',
    invalid: 'This payment confirmation link is invalid or expired.',
    unavailable: 'Payment verification is temporarily unavailable. Please try again.',
  };
  const canRetry = phase === 'processing' || phase === 'unavailable';

  return (
    <main className="loading-screen" aria-live="polite" style={{ padding: 24, textAlign: 'center' }}>
      <h1 style={{ margin: 0, fontSize: 'var(--text-24)' }}>
        {phase === 'failed' ? 'Payment not confirmed' : phase === 'invalid' ? 'Payment link unavailable' : 'Payment verification'}
      </h1>
      <p className="text-secondary" style={{ maxWidth: 360, margin: '12px auto 0' }}>
        {copy[phase] || copy.unavailable}
      </p>
      {canRetry && (
        <button
          type="button"
          onClick={checkAgain}
          disabled={checking}
          style={{
            marginTop: 20,
            padding: '10px 22px',
            background: 'var(--primary)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 16,
            cursor: checking ? 'wait' : 'pointer',
            opacity: checking ? 0.7 : 1,
          }}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      )}
    </main>
  );
};

export default PaymentReturnPage;
