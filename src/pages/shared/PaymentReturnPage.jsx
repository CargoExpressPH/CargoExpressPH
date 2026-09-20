import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import usePageTitle from '../../hooks/usePageTitle';

const TERMINAL_PHASES = new Set(['confirmed', 'failed', 'invalid']);
const AUTO_CHECK_DELAYS = [0, 1500, 3000, 5000, 8000, 12000];

/**
 * Public Device B landing page for a PayMongo redirect.
 *
 * It deliberately does not read auth state, localStorage, orders, or
 * payment_attempts. The only input is the high-entropy return capability in
 * the URL; the public Edge Function validates its hash server-side and returns
 * a status enum. This keeps the same experience for logged-out users, users
 * with another account, installed PWAs, and in-app browsers.
 */
const PaymentReturnPage = () => {
  usePageTitle('Payment Status');
  const [searchParams] = useSearchParams();
  const returnToken = searchParams.get('return_token')?.trim() || '';
  const timerRef = useRef(null);
  const [phase, setPhase] = useState(returnToken ? 'verifying' : 'invalid');
  const [checking, setChecking] = useState(false);

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

  if (phase === 'confirmed') {
    return (
      <main className="loading-screen" aria-live="polite" style={{ padding: 24, textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Thank you for your payment!</h1>
        <p className="text-secondary" style={{ maxWidth: 360, margin: '12px auto 0' }}>
          Your payment has been successfully confirmed. You may now close this page.
        </p>
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
      <h1 style={{ margin: 0, fontSize: '1.5rem' }}>
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
