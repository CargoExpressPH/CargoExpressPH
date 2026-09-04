import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { pollPaymentStatus } from '../../lib/paymongo';
import { useAuth } from '../../contexts/AuthContext';
import PaymentResultModal from '../../components/ui/PaymentResultModal';
import { BrandLogo } from '../../components/ui/BrandLogo';
import usePageTitle from '../../hooks/usePageTitle';

/**
 * Lightweight landing for the payer coming back from the PayMongo GCash
 * checkout (redirect URLs are built in lib/paymongo.js). Landing here instead
 * of inside the authenticated app skips the full boot — auth profile fetch,
 * order fetch, page chunk — that used to sit between the customer and their
 * result. This page paints "Verifying your payment…" immediately, verifies
 * with the same poll/realtime pattern as the order pages, shows the shared
 * PaymentResultModal, then hands off to the order page.
 *
 * The order pages keep their own `?payment=` handlers for checkout links
 * created before this route existed.
 */

const orderPagePath = (role, orderId) =>
  orderId ? `/${role}/orders/${orderId}` : `/${role}`;

// Same settled test the admin return path uses inline: an unpriced order with
// a zero balance must not read as paid just because remaining_balance <= 0.
const isOrderSettled = (row) =>
  row?.payment_status === 'paid'
  || (Number(row?.amount_paid) > 0 && Number(row?.remaining_balance) <= 0);

// Inlined from lib/database.js (getLatestPaymentAttemptByOrder): this page is
// part of the initial JS bundle, and importing database.js wholesale would
// drag every other query into the first load.
const getLatestPaymentAttempt = async (orderId) => {
  const { data, error } = await supabase
    .from('payment_attempts')
    .select('id, source_id, status, amount')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const PaymentReturnPage = () => {
  usePageTitle('Payment Status');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const paymentResult = searchParams.get('payment');
  const orderId = searchParams.get('order');
  const role = searchParams.get('role') === 'admin' ? 'admin' : 'customer';

  const [phase, setPhase] = useState(paymentResult === 'failed' ? 'failed' : 'verifying');
  const [paidAmount, setPaidAmount] = useState(null);
  const channelRef = useRef(null);
  const mountedRef = useRef(true);
  const confirmedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (channelRef.current) void supabase.removeChannel(channelRef.current);
    };
  }, []);

  const goToOrder = useCallback(() => {
    navigate(orderPagePath(role, orderId), { replace: true });
  }, [navigate, orderId, role]);

  const confirmPaid = useCallback((amount) => {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    if (channelRef.current) void supabase.removeChannel(channelRef.current);
    // Same cleanup the order page does on confirmation — a stale source id
    // left behind would otherwise be picked up by the NEXT payment return.
    if (orderId) {
      localStorage.removeItem(`pending_payment_${orderId}`);
      localStorage.removeItem(`pending_payment_amount_${orderId}`);
    }
    setPaidAmount(Number.isFinite(amount) && amount > 0 ? amount : null);
    setPhase('success');
  }, [orderId]);

  const verify = useCallback(async () => {
    if (!orderId) {
      setPhase('stuck');
      return;
    }

    // Source id, in order of availability: a same-device customer leaves it
    // in localStorage before redirecting; admins have none but CAN read
    // payment_attempts (admin-only RLS). A customer on another device can
    // read neither — for them the order row itself is the only visible
    // signal, so that becomes the verification path.
    let sourceId = localStorage.getItem(`pending_payment_${orderId}`);
    let knownAmount = Number(localStorage.getItem(`pending_payment_amount_${orderId}`) || 0) || null;

    if (!sourceId) {
      try {
        const attempt = await getLatestPaymentAttempt(orderId);
        if (!mountedRef.current || confirmedRef.current) return;
        if (attempt?.status === 'reconciled') {
          confirmPaid(Number(attempt.amount || 0));
          return;
        }
        if (attempt?.source_id) {
          sourceId = attempt.source_id;
          knownAmount = knownAmount ?? (Number(attempt.amount || 0) || null);
        }
        // Customers simply get null here (RLS-hidden table), not an error.
      } catch {
        // Transient lookup failure — the order-row checks below still
        // confirm a payment the webhook has already reconciled.
      }
    }
    if (!mountedRef.current || confirmedRef.current) return;

    // Live order updates cover the webhook landing between polls.
    channelRef.current = supabase
      .channel(`payment_return_${orderId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}`,
      }, (payload) => {
        if (isOrderSettled(payload.new)) {
          confirmPaid(knownAmount ?? (Number(payload.new.amount_paid || 0) || null));
        }
      })
      .subscribe();

    // The order row is readable by its owner under RLS and is exactly what
    // the webhook reconciliation updates — one signal every role can see.
    const checkOrderRow = async () => {
      const { data } = await supabase
        .from('orders')
        .select('payment_status, amount_paid, remaining_balance')
        .eq('id', orderId)
        .maybeSingle();
      if (isOrderSettled(data)) {
        confirmPaid(knownAmount ?? (Number(data.amount_paid || 0) || null));
        return true;
      }
      return false;
    };

    if (!sourceId) {
      // Cannot query PayMongo directly — watch the order row instead.
      for (const delay of [0, 2000, 4000, 6000, 8000]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (!mountedRef.current || confirmedRef.current) return;
        try {
          if (await checkOrderRow()) return;
        } catch {
          // A transient read error should not end verification.
        }
      }
      if (mountedRef.current && !confirmedRef.current) setPhase('stuck');
      return;
    }

    for (const delay of [0, 2000, 4000, 6000, 8000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!mountedRef.current || confirmedRef.current) return;
      try {
        const result = await pollPaymentStatus(sourceId, orderId);
        if (result.orderReconciled || result.status === 'paid') {
          confirmPaid(knownAmount ?? (Number(result.amount || 0) || null));
          return;
        }
      } catch {
        // A transient verification error should not end reconciliation.
      }
      try {
        if (await checkOrderRow()) return;
      } catch {
        // Same — the next retry or the realtime channel still confirms.
      }
    }
    if (mountedRef.current && !confirmedRef.current) setPhase('stuck');
  }, [confirmPaid, orderId]);

  useEffect(() => {
    // A failed return is already a final answer from PayMongo — verifying it
    // anyway would eventually swap "Payment Failed" for "Payment Processing".
    if (paymentResult === 'failed') {
      if (orderId) localStorage.removeItem(`pending_payment_${orderId}`);
      return;
    }
    if (authLoading || !user) return;
    void verify();
    // Runs once for this payment return; "still processing" users are sent to
    // the order page, whose own realtime subscription picks up a late webhook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  // Direct visit without PayMongo's parameters — nothing to show here.
  if (!paymentResult) return <Navigate to="/" replace />;

  // No session on this device (e.g. a customer scanned the admin's QR code):
  // the webhook still reconciles the payment server-side, so reassure and let
  // them leave instead of asking them to log in.
  if (phase === 'verifying' && !authLoading && !user) {
    return (
      <div className="loading-screen">
        <div className="loading-brand animate-scale-in">
          <BrandLogo size={44} decorative />
        </div>
        <h2 style={{ margin: '16px 0 4px' }}>Thanks for your payment!</h2>
        <p className="text-secondary" style={{ maxWidth: 320, textAlign: 'center' }}>
          We&apos;re confirming it now. You can safely close this page.
        </p>
      </div>
    );
  }

  if (phase === 'verifying') {
    return (
      <div className="loading-screen">
        <div className="loading-brand animate-scale-in">
          <BrandLogo size={44} decorative />
        </div>
        <div className="spinner" style={{ margin: '16px 0 8px' }} />
        <p>Verifying your payment…</p>
      </div>
    );
  }

  return (
    <PaymentResultModal
      isOpen
      variant={phase === 'failed' ? 'error' : phase === 'stuck' ? 'processing' : 'success'}
      amount={paidAmount ?? undefined}
      onClose={goToOrder}
    />
  );
};

export default PaymentReturnPage;
