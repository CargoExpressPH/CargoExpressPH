import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import {
  clearPaymentReturnContext,
  getPaymentReturnContext,
} from '../../lib/paymentReturnContext';
import usePageTitle from '../../hooks/usePageTitle';
import { Info } from 'lucide-react';
import BrandLockup from '../../components/ui/BrandLogo';
import ResultIcon from '../../components/ui/ResultIcon';

const TERMINAL_PHASES = new Set(['confirmed', 'failed', 'invalid']);
const AUTO_CHECK_DELAYS = [0, 1500, 3000, 5000, 8000, 12000];

/**
 * What each phase says. The page itself never learns the amount or the
 * booking (the server returns only a status), so on the paying device the
 * details come from the booking page, which this page hands off to.
 */
const SCREENS = {
  verifying: {
    tone: 'loading',
    title: 'Confirming your payment',
    text: 'This usually takes a few seconds. Please keep this page open.',
  },
  confirmed: {
    tone: 'success',
    title: 'Thank you for your payment!',
    text: 'Your payment has been successfully confirmed.',
  },
  processing: {
    tone: 'pending',
    title: 'Still confirming your payment',
    text: 'GCash hasn’t finished confirming this payment yet. Please check again in a few seconds.',
    help: 'Please don’t pay again while this is being checked.',
  },
  unavailable: {
    tone: 'pending',
    title: 'We can’t check right now',
    text: 'Payment verification is temporarily unavailable. Please try again in a moment.',
    help: 'Your payment may still have gone through, so please don’t pay again until this confirms.',
  },
  failed: {
    tone: 'error',
    title: 'Payment didn’t go through',
    text: 'Your GCash payment was not completed.',
    help: 'If GCash shows the amount was deducted, don’t pay again. Contact CargoExpress PH with your GCash reference number.',
  },
  invalid: {
    tone: 'error',
    title: 'This link has expired',
    text: 'This payment confirmation link is invalid or expired.',
  },
};

/**
 * Adds the outcome to the originating page's path (for example
 * `/customer/orders/<id>?payment=success`). That page already handles the
 * parameter: it re-checks the payment and shows its own result with the
 * amount and booking details, which are private to the paying account.
 */
const withPaymentResult = (path, result) => {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('payment', result);
  return `${pathname}?${params.toString()}`;
};

/**
 * Public Device B landing page for a PayMongo redirect.
 *
 * Payment verification does not depend on auth state or localStorage. The
 * high-entropy return capability in the URL is sent to the public Edge
 * Function, which validates its hash server-side and returns only a status
 * enum. Local storage is consulted only to decide whether this exact browser
 * may navigate back to its own originating page.
 */
const PaymentReturnPage = () => {
  usePageTitle('Payment Status');
  const [searchParams] = useSearchParams();
  const returnToken = searchParams.get('return_token')?.trim() || '';
  const timerRef = useRef(null);
  const [phase, setPhase] = useState(returnToken ? 'verifying' : 'invalid');
  const [checking, setChecking] = useState(false);
  const [returnContext, setReturnContext] = useState(null);
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
        setReturnContext({ returnTo: context.returnTo, role: context.role });
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

  // Only the device that started the payment (same browser, same account)
  // gets a way back to its booking; everyone else sees the public result.
  const originatingReturnTo = returnContext
    ? withPaymentResult(returnContext.returnTo, phase === 'failed' ? 'failed' : 'success')
    : null;

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

  const screen = SCREENS[phase] || SCREENS.unavailable;
  const tone = screen.tone === 'loading' ? 'pending' : screen.tone;
  const canRetry = phase === 'processing' || phase === 'unavailable';

  return (
    <main className={`payment-return payment-return--${tone}`} aria-live="polite">
      <div className="payment-return-card">
        <BrandLockup size={30} className="payment-return-brand" />
        <ResultIcon tone={screen.tone} className="payment-return-mark" />
        <h1 className="payment-return-title">{screen.title}</h1>
        <p className="payment-return-text">{screen.text}</p>

        {screen.help && (
          <div className={`payment-return-help payment-return-help--${tone}`}>
            <Info size={16} aria-hidden="true" />
            <p>
              {screen.help}
              {phase === 'failed' && returnContext?.role === 'customer' && (
                <> <Link to="/customer/support">Chat with us</Link></>
              )}
            </p>
          </div>
        )}

        {phase !== 'verifying' && (
          <div className="payment-return-actions">
            {phase === 'confirmed' && (
              <button type="button" className="btn btn-primary btn-block" onClick={handleClose}>
                {originatingReturnTo ? 'View booking' : 'Close'}
              </button>
            )}

            {canRetry && (
              <button type="button" className="btn btn-primary btn-block" onClick={checkAgain} disabled={checking} aria-busy={checking}>
                {checking ? 'Checking…' : 'Check again'}
              </button>
            )}

            {phase === 'failed' && originatingReturnTo && (
              <button type="button" className="btn btn-primary btn-block" onClick={handleClose}>
                Try again
              </button>
            )}

            {/* A plain link, not a session-aware one: "/" already sends a
                signed-in visitor to their dashboard and a guest to the home page. */}
            {(phase === 'invalid' || (phase === 'failed' && !originatingReturnTo)) && (
              <a className="btn btn-outline btn-block" href="/">Go to CargoExpress PH</a>
            )}
          </div>
        )}

        {phase === 'confirmed' && closeFallbackVisible && !originatingReturnTo && (
          <p className="payment-return-note">
            You may now close this tab and return to the device where you started your payment.
          </p>
        )}
      </div>
    </main>
  );
};

export default PaymentReturnPage;
