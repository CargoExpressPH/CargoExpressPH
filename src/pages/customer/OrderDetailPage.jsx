import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { getOrderById, requestOrderCancellation, getPaymentTransactions, submitFeedback, checkIfFeedbackExists, getOrderStatusEvents, getLatestPaymentAttemptByOrder } from '../../lib/database';
import { buildStatusTimestamps } from '../../utils/statusTimestamps';
import { resolvePhotoUrls } from '../../lib/storage';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { initiateGCashPayment, registerSource, pollPaymentStatus } from '../../lib/paymongo';
import StatusBadge from '../../components/ui/StatusBadge';
import TrackingTimeline from '../../components/ui/TrackingTimeline';
import ConfirmModal from '../../components/ui/ConfirmModal';
import CancelBookingModal from '../../components/ui/CancelBookingModal';
import FocusTrap from '../../components/ui/FocusTrap';
import ImageLightbox from '../../components/ui/ImageLightbox';
import { SkeletonOrderCard, SkeletonText } from '../../components/ui/SkeletonLoader';
import { ArrowLeft, MapPin, User, Phone, Package, CreditCard, Truck, Camera, Image, XCircle, Loader, AlertTriangle, Check } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDate, formatPhDateTime } from '../../utils/datetime';
import { formatMoney } from '../../utils/currencyInput';
import { outstandingBalance, getSettlementState, isOrderPriced, SETTLEMENT_STATE, ORDER_STATUS, canCancelOrder, hasPendingCancellation, timelineStatus } from '../../constants/status';
import { formatPaymentType, formatRecordedBy, getPaymentStatusDisplay, formatPaymentMethod as fmtMethod, getCustomerFriendlyNotes, getCustomerVisibleRef } from '../../utils/paymentDisplay';

// Max time (ms) to wait for data before giving up and showing an error.
const LOAD_TIMEOUT_MS = 15000;

// Translate cryptic Supabase / network errors into friendly messages.
const normalizeError = (err) => {
  const msg = err?.message || String(err || '');
  if (msg.includes('PGRST116') || msg.includes('0 rows')) return 'Order not found. It may have been deleted or you may not have access.';
  if (msg.includes('JWT') || msg.includes('auth') || msg.toLowerCase().includes('unauthorized')) return 'Your session has expired. Please log in again.';
  if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('failed to fetch')) return 'Network error. Please check your internet connection and try again.';
  if (msg.toLowerCase().includes('timeout') || msg.includes('AbortError')) return 'The request timed out. Please try again.';
  return msg || 'Failed to load order. Please try again.';
};

const OrderDetailPage = () => {
  usePageTitle('Booking Details');
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, userProfile } = useAuth();
  const toast = useToast();

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [lightboxImages, setLightboxImages] = useState([]);
  const [resolvedPickupPhotos, setResolvedPickupPhotos] = useState([]);
  const [photoLoadState, setPhotoLoadState] = useState({});
  const [resolvedDeliveryPhotos, setResolvedDeliveryPhotos] = useState([]);
  const [deliveryPhotoLoadState, setDeliveryPhotoLoadState] = useState({});
  const [paymentTransactions, setPaymentTransactions] = useState([]);
  const [statusEvents, setStatusEvents] = useState([]);

  const stepTimestamps = useMemo(
    () => buildStatusTimestamps(statusEvents, order?.created_at, order?.status),
    [statusEvents, order?.created_at, order?.status]
  );
  
  // Feedback state
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState(5);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [hasFeedback, setHasFeedback] = useState(false);

  const [processingPayment, setProcessingPayment] = useState(false);
  const [verifyingPayment, setVerifyingPayment] = useState(false);
  const [paymentVerificationPending, setPaymentVerificationPending] = useState(false);

  // Statuses where payment is allowed (cargo has been picked up and weighed)
  const PAYABLE_STATUSES = ['Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery'];

  // Timeout ref — cleared if data arrives before LOAD_TIMEOUT_MS
  const timeoutRef = useRef(null);
  const isMountedRef = useRef(true);
  const paymentSourceRef = useRef(null);
  const paymentChannelRef = useRef(null);
  const paymentConfirmedRef = useRef(false);
  const paymentVerificationInFlightRef = useRef(false);

  const clearLoadTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startLoadTimeout = useCallback(() => {
    clearLoadTimeout();
    timeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setLoading(false);
        setError('The request took too long. Please check your connection and try again.');
      }
    }, LOAD_TIMEOUT_MS);
  }, [clearLoadTimeout]);

  const loadOrder = useCallback(async () => {
    if (!id) {
      setError('No order ID provided.');
      setLoading(false);
      return;
    }

    setError(null);
    setLoading(true);
    startLoadTimeout();

    try {
      const data = await getOrderById(id);
      let pmts = [];
      let events = [];
      try {
        pmts = await getPaymentTransactions(id);
      } catch (err) {
        if (import.meta.env.DEV) console.warn('Failed to fetch payment history', err);
      }
      try {
        events = await getOrderStatusEvents(id);
      } catch (err) {
        if (import.meta.env.DEV) console.warn('Failed to fetch status events', err);
      }
      clearLoadTimeout();
      if (isMountedRef.current) {
        setOrder(data);
        setPaymentTransactions(pmts);
        setStatusEvents(events || []);
        setLoading(false);
        
        // Check if we should show feedback modal
        if (data.status === 'Delivered') {
          checkIfFeedbackExists(id).then(exists => {
            if (isMountedRef.current) {
              setHasFeedback(exists);
              if (!exists) {
                const skipped = localStorage.getItem(`feedback_skipped_${id}`);
                if (!skipped) {
                  setShowFeedbackModal(true);
                }
              }
            }
          }).catch(console.error);
        }
      }
    } catch (err) {
      clearLoadTimeout();
      if (isMountedRef.current) {
        setError(normalizeError(err));
        setLoading(false);
      }
    }
  }, [id, startLoadTimeout, clearLoadTimeout]);

  // Load order on mount and when id changes
  useEffect(() => {
    isMountedRef.current = true;
    loadOrder();
    return () => {
      isMountedRef.current = false;
      clearLoadTimeout();
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Payment Return Handler ───────────────────────────────────────────────
  // When the customer returns from PayMongo with ?payment=success,
  // poll the server to trigger reconciliation.
  useEffect(() => {
    const paymentResult = searchParams.get('payment');
    if (!paymentResult || !id) return;

    // Clean up the URL immediately
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('payment');
    setSearchParams(newParams, { replace: true });

    // The success path is handled by the resilient effect below: it combines
    // realtime order updates, fallback polling, and a manual refresh action.
    if (paymentResult === 'failed') {
      localStorage.removeItem(`pending_payment_${id}`);
      toast.error('Payment was not completed. You can try again.');
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearPaymentReconciliation = useCallback(() => {
    if (paymentChannelRef.current) {
      void supabase.removeChannel(paymentChannelRef.current);
      paymentChannelRef.current = null;
    }
  }, []);

  useEffect(() => () => clearPaymentReconciliation(), [clearPaymentReconciliation]);

  const isPaymentSettled = (row) => (
    row?.payment_status === 'paid'
    || (Number(row?.amount_paid) > 0 && Number(row?.remaining_balance) <= 0)
  );

  const markPaymentConfirmed = useCallback(async () => {
    if (paymentConfirmedRef.current) return true;
    paymentConfirmedRef.current = true;
    clearPaymentReconciliation();
    localStorage.removeItem(`pending_payment_${id}`);
    if (isMountedRef.current) {
      setPaymentVerificationPending(false);
      setVerifyingPayment(false);
      toast.success('Payment confirmed! Your order has been updated.');
      await loadOrder();
    }
    return true;
  }, [clearPaymentReconciliation, id, loadOrder, toast]);

  /**
   * Reconcile a returned PayMongo source for about 20 seconds. The webhook is
   * authoritative, but the customer needs active checks while it is in flight.
   * The realtime subscription below covers a webhook that lands between polls.
   */
  const verifyPaymentStatus = useCallback(async () => {
    const sourceId = paymentSourceRef.current;
    if (!sourceId || !id || paymentVerificationInFlightRef.current) return false;

    paymentVerificationInFlightRef.current = true;
    if (isMountedRef.current) {
      setVerifyingPayment(true);
      setPaymentVerificationPending(false);
    }

    const retryDelays = [0, 2000, 4000, 6000, 8000];
    try {
      for (const delay of retryDelays) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (!isMountedRef.current || paymentConfirmedRef.current) return paymentConfirmedRef.current;

        try {
          const result = await pollPaymentStatus(sourceId, id);
          if (result.orderReconciled || result.status === 'paid') {
            return await markPaymentConfirmed();
          }
        } catch {
          // A transient verification error should not end reconciliation.
        }

        try {
          const freshOrder = await getOrderById(id);
          if (isPaymentSettled(freshOrder)) return await markPaymentConfirmed();
        } catch {
          // Keep the next retry alive; the normal page loader handles a
          // persistent access or network failure.
        }
      }

      if (isMountedRef.current && !paymentConfirmedRef.current) {
        setVerifyingPayment(false);
        setPaymentVerificationPending(true);
        toast.info('Payment is still being confirmed. Refresh status in a moment.');
      }
      return false;
    } finally {
      paymentVerificationInFlightRef.current = false;
    }
  }, [id, markPaymentConfirmed, toast]);

  const handleRefreshPaymentStatus = useCallback(async () => {
    if (paymentSourceRef.current) {
      await verifyPaymentStatus();
      return;
    }

    try {
      const attempt = await getLatestPaymentAttemptByOrder(id);
      if (attempt?.status === 'reconciled') {
        // markPaymentConfirmed clears the pending banner, removes the stored
        // source, toasts and reloads — reloading alone left the "still being
        // confirmed" notice on screen even though the payment had landed.
        await markPaymentConfirmed();
        return;
      }
      if (attempt?.source_id) {
        paymentSourceRef.current = attempt.source_id;
        setPaymentVerificationPending(false);
        await verifyPaymentStatus();
        return;
      }
    } catch {
      // Fall through to a normal order refresh if the attempt lookup fails.
    }
    await loadOrder();
  }, [id, loadOrder, markPaymentConfirmed, verifyPaymentStatus]);

  // A successful return gets a realtime listener plus bounded backoff polling.
  useEffect(() => {
    if (searchParams.get('payment') !== 'success' || !id) return;

    paymentConfirmedRef.current = false;
    let sourceId = localStorage.getItem(`pending_payment_${id}`);

    const beginVerification = async () => {
      if (!sourceId) {
        try {
          const attempt = await getLatestPaymentAttemptByOrder(id);
          if (attempt?.status === 'reconciled') {
            localStorage.removeItem(`pending_payment_${id}`);
            toast.success('Payment confirmed! Your order has been updated.');
            await loadOrder();
            return;
          }
          sourceId = attempt?.source_id || null;
        } catch {
          sourceId = null;
        }
      }

      if (!sourceId) {
        setVerifyingPayment(false);
        setPaymentVerificationPending(true);
        toast.info('Payment is being verified. Refresh status in a moment.');
        return;
      }

      paymentSourceRef.current = sourceId;
      setPaymentVerificationPending(false);
      toast.info('Verifying your payment...');

      paymentChannelRef.current = supabase
        .channel(`customer_payment_${id}`)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `id=eq.${id}`,
        }, (payload) => {
          if (isPaymentSettled(payload.new)) void markPaymentConfirmed();
        })
        .subscribe();

      await verifyPaymentStatus();
    };

    void beginVerification();
    // The URL is cleaned by the preceding effect. This effect intentionally
    // starts once for this booking-return event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Resolve photo URLs when order changes
  useEffect(() => {
    const photos = Array.isArray(order?.pickup_photos) ? order.pickup_photos : [];
    if (photos.length === 0) {
      setResolvedPickupPhotos([]);
      return;
    }
    let cancelled = false;
    resolvePhotoUrls(photos)
      .then(urls => { if (!cancelled) setResolvedPickupPhotos(urls); })
      .catch(() => { if (!cancelled) setResolvedPickupPhotos([]); });
    return () => { cancelled = true; };
  }, [order?.pickup_photos]);

  // Preload photo images to detect load/fail state
  useEffect(() => {
    let cancelled = false;
    setPhotoLoadState({});
    resolvedPickupPhotos.forEach((url, index) => {
      const preview = new window.Image();
      preview.onload  = () => { if (!cancelled) setPhotoLoadState(prev => ({ ...prev, [index]: 'loaded' })); };
      preview.onerror = () => { if (!cancelled) setPhotoLoadState(prev => ({ ...prev, [index]: 'failed' })); };
      preview.src = url;
    });
    return () => { cancelled = true; };
  }, [resolvedPickupPhotos]);

  useEffect(() => {
    let cancelled = false;
    const photos = Array.isArray(order?.delivery_photos) ? order.delivery_photos : [];
    if (photos.length === 0) {
      setResolvedDeliveryPhotos([]);
      return;
    }
    resolvePhotoUrls(photos)
      .then(urls => { if (!cancelled) setResolvedDeliveryPhotos(urls); })
      .catch(() => { if (!cancelled) setResolvedDeliveryPhotos([]); });
    return () => { cancelled = true; };
  }, [order?.delivery_photos]);

  useEffect(() => {
    let cancelled = false;
    setDeliveryPhotoLoadState({});
    resolvedDeliveryPhotos.forEach((url, index) => {
      const preview = new window.Image();
      preview.onload  = () => { if (!cancelled) setDeliveryPhotoLoadState(prev => ({ ...prev, [index]: 'loaded' })); };
      preview.onerror = () => { if (!cancelled) setDeliveryPhotoLoadState(prev => ({ ...prev, [index]: 'failed' })); };
      preview.src = url;
    });
    return () => { cancelled = true; };
  }, [resolvedDeliveryPhotos]);

  // Submits a cancellation REQUEST with the customer's stated reason. Nothing
  // is cancelled here — the RPC moves the order to 'Pending Cancellation',
  // notifies every admin and writes the activity log in one transaction, so
  // there is no client-side follow-up write that could be lost mid-flight.
  const handleCancel = async (reason) => {
    if (!user) {
      setShowCancelModal(false);
      toast.error('Your session has expired. Please log in again.');
      navigate('/login');
      return;
    }
    setCancelling(true);
    try {
      await requestOrderCancellation(id, reason);
      setShowCancelModal(false);
      await loadOrder();
      toast.success('Cancellation request sent. We will let you know once it has been reviewed.');
    } catch (err) {
      // The modal stays open so the typed reason is not lost on a failure.
      toast.error(normalizeError(err));
    } finally {
      setCancelling(false);
    }
  };

  const handleFeedbackSkip = () => {
    localStorage.setItem(`feedback_skipped_${id}`, 'true');
    setShowFeedbackModal(false);
  };

  const handleFeedbackSubmit = async () => {
    if (!feedbackMessage.trim()) {
      toast.error('Please provide a message for your feedback.');
      return;
    }
    setSubmittingFeedback(true);
    try {
      await submitFeedback({
        orderId: id,
        customerId: user.id,
        rating: feedbackRating,
        message: feedbackMessage.trim()
      });
      toast.success('Thank you! Your feedback has been submitted.');
      setHasFeedback(true);
      setShowFeedbackModal(false);
    } catch (err) {
      toast.error('Failed to submit feedback. Please try again later.');
    } finally {
      setSubmittingFeedback(false);
    }
  };

  const handlePayNow = async () => {
    if (processingPayment) return;
    const balance = outstandingBalance(order);
    if (balance <= 0) return;

    setProcessingPayment(true);
    try {
      const customer = {
        name: userProfile?.name || order.sender_name,
        phone: userProfile?.phone || order.sender_phone,
      };
      
      const { sourceId, checkoutUrl } = await initiateGCashPayment(balance, order.tracking_number, customer, false, order.id);
      
      await registerSource(sourceId, balance, { orderId: order.id });
      
      // Save sourceId so we can reconcile when the customer returns
      localStorage.setItem(`pending_payment_${order.id}`, sourceId);
      
      toast.success('Redirecting to PayMongo...');
      
      // Redirect to GCash checkout in the same tab ONLY AFTER registerSource is complete
      window.location.href = checkoutUrl;
    } catch (err) {
      toast.error(err.message || 'Failed to initiate payment.');
      setProcessingPayment(false);
    } finally {
      setProcessingPayment(false);
    }
  };

  // ── Loading State ──────────────────────────────────────────────────────────
  if (loading) return (
    <div className="page-transition customer-order-detail-page">
      <div className="stagger-item mb-16" style={{ animationDelay: '0ms' }}>
        <div className="skeleton skeleton-text h-20" style={{ width: '30%',}} />
      </div>
      <div className="stagger-item mb-16" style={{ animationDelay: '60ms' }}><SkeletonOrderCard /></div>
      <div className="stagger-item mb-16" style={{ animationDelay: '120ms' }}><SkeletonText lines={4} /></div>
      <div className="stagger-item" style={{ animationDelay: '180ms' }}><SkeletonOrderCard /></div>
    </div>
  );

  // ── Error State ────────────────────────────────────────────────────────────
  if (error) return (
    <div className="page-transition customer-order-detail-page">
      <button onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>
      <div className="card animate-scale-in text-center" role="alert" style={{ padding: 40 }}>
        <div className="flex items-center justify-center mx-auto mb-16" style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--error-bg)' }}>
          <AlertTriangle size={28} color="var(--error)" aria-hidden="true" />
        </div>
        <h3 className="mb-8" style={{ color: 'var(--error-dark)' }}>Unable to Load Booking</h3>
        <p className="text-secondary text-sm mb-20">{error}</p>
        <div className="flex gap-12 justify-center flex-wrap">
          <button className="btn btn-primary" onClick={loadOrder}>Try Again</button>
          <button className="btn btn-ghost" onClick={() => navigate('/customer/orders')}>Back to Orders</button>
        </div>
      </div>
    </div>
  );

  // ── Not Found ──────────────────────────────────────────────────────────────
  if (!order) return (
    <div className="page-transition customer-order-detail-page">
      <button onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>
      <div className="card animate-scale-in text-center" style={{ padding: 40 }}>
        <Package size={40} style={{ opacity: 0.3, margin: '0 auto 16px' }} />
        <h3 className="mb-8">Booking Not Found</h3>
        <p className="text-secondary text-sm mb-20">This booking does not exist or you don't have permission to view it.</p>
        <button className="btn btn-primary" onClick={() => navigate('/customer/orders')}>Back to Orders</button>
      </div>
    </div>
  );

  const isCancelled = order.status === ORDER_STATUS.CANCELLED;
  const awaitingCancellation = hasPendingCancellation(order);
  // Was `order.status === 'Pending'`, which hid the button the moment an admin
  // put the booking on a trip — the exact point at which a customer is most
  // likely to want out. canCancelOrder() is the shared rule: anything not yet
  // loaded onto a vehicle, and not already under review.
  const canCancel = canCancelOrder(order);
  const hasPhotos = resolvedPickupPhotos.length > 0;
  const balance = outstandingBalance(order);
  const settlementState = getSettlementState(order);

  return (
    <div className="page-transition customer-order-detail-screen">
      <button onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>

      {/* Header */}
      <div className="customer-order-detail-header flex items-center justify-between animate-slide-up mb-20">
        <div>
          <h1 className="fw-800">{order.tracking_number}</h1>
          <div className="flex items-center gap-8 mt-4 text-sm">
            <span className="fw-800" style={{ color: 'var(--text)' }}>{order.origin}</span>
            <span className="fw-700" style={{ color: 'var(--primary-text)' }}>➔</span>
            <span className="fw-800 text-secondary">{order.destination}</span>
          </div>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {/* Cancellation request awaiting review — states plainly that nothing
          has been cancelled yet, and shows back the reason that was given so
          the customer can see what the admin is reading. */}
      {awaitingCancellation && (
        <div className="alert-banner alert-banner-warning animate-slide-up mb-16" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <div className="flex flex-col gap-4">
            <span className="fw-700">Cancellation requested — awaiting review</span>
            <span className="text-sm">
              This booking is still active while our team reviews your request. You will be
              notified once it is approved or declined.
            </span>
            {order.cancellation_details?.reason && (
              <span className="text-sm" style={{ opacity: 0.9 }}>
                Your reason: “{order.cancellation_details?.reason}”
              </span>
            )}
          </div>
        </div>
      )}

      {/* Declined request — the order carried on, and the note says why. */}
      {!awaitingCancellation && !isCancelled && order.cancellation_details?.reviewed_at && order.cancellation_details?.reason && (
        <div className="alert-banner alert-banner-info animate-slide-up mb-16" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <div className="flex flex-col gap-4">
            <span className="fw-700">Your cancellation request was declined</span>
            <span className="text-sm">
              This booking is still going ahead.
              {order.cancellation_details?.review_notes ? ` Note from our team: ${order.cancellation_details?.review_notes}` : ''}
            </span>
          </div>
        </div>
      )}

      {canCancel && (
        <button className="btn btn-danger btn-sm animate-slide-up mb-16" onClick={() => setShowCancelModal(true)} disabled={cancelling}>
          {cancelling ? <Loader size={14} className="animate-spin" /> : <XCircle size={14} />}
          Request Cancellation
        </button>
      )}

      <CancelBookingModal
        isOpen={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        onConfirm={handleCancel}
        loading={cancelling}
        trackingNumber={order.tracking_number}
      />

      {/* Tracking Timeline */}
      {!isCancelled && (
        <div className="customer-detail-card customer-tracking-card card stagger-item mb-16" style={{ animationDelay: '40ms' }}>
          <div className="card-body p-16">
            <h4 className="fw-700 mb-16">Tracking Timeline</h4>
            <TrackingTimeline currentStatus={timelineStatus(order)} compact stepTimestamps={stepTimestamps} />
          </div>
        </div>
      )}

      {/* Feedback Banner */}
      {order.status === 'Delivered' && !hasFeedback && (
        <div className="alert-banner alert-banner-success animate-scale-in mb-16 flex justify-between items-center" style={{ padding: '16px 20px', gap: 16 }}>
          <div className="flex flex-col gap-4">
            <div className="fw-700 text-base">🎉 Delivery Complete!</div>
            <p className="text-sm m-0" style={{ opacity: 0.9 }}>How was your experience? Your feedback helps us improve.</p>
          </div>
          <button
            className="btn btn-alert-action shrink-0"
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => setShowFeedbackModal(true)}
          >
            Leave Feedback
          </button>
        </div>
      )}

      {/* Cancelled status display */}
      {/* Cancellation details. The banner used to say only "this booking has
          been cancelled", which is the one thing the status badge above already
          says — the questions a customer opens a cancelled booking to answer
          are "what reason did I give?" and "what did they say?". Both are on
          the row; neither was being shown.

          `cancellation_requested_at` is what separates the two routes in: a
          request this customer made, or a cancellation the team made without
          one. Labelling an admin's reason as "your reason" would be a small
          lie that reads as the app losing track of who did what. */}
      {isCancelled && (
        <div className="alert-banner alert-banner-error animate-scale-in mb-16" style={{ padding: '20px 24px' }}>
          <div className="flex flex-col gap-8" style={{ width: '100%' }}>
            <div className="flex items-center gap-8">
              <XCircle size={20} aria-hidden="true" />
              <span className="fw-700 text-base">Booking Cancelled</span>
            </div>
            <p className="text-sm m-0" style={{ opacity: 0.8 }}>
              {order.cancellation_details?.requested_at
                ? 'This booking was cancelled at your request and cannot be modified.'
                : 'This booking was cancelled by our team and cannot be modified.'}
            </p>

            {order.cancellation_details?.reason && (
              <div className="text-sm">
                <div className="fw-700">
                  {order.cancellation_details?.requested_at ? 'Your reason' : 'Reason'}
                </div>
                <p className="m-0" style={{ opacity: 0.9 }}>“{order.cancellation_details?.reason}”</p>
              </div>
            )}

            {order.cancellation_details?.requested_at && order.cancellation_details?.review_notes && (
              <div className="text-sm">
                <div className="fw-700">Note from our team</div>
                <p className="m-0" style={{ opacity: 0.9 }}>“{order.cancellation_details?.review_notes}”</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Trip Info */}
      {order.trip_id && order.trips && (
        <div className="customer-detail-card customer-detail-trip-card card stagger-item mb-16" style={{ animationDelay: '60ms' }}>
          <div className="card-body flex items-center gap-12" style={{ padding: 14 }}>
            <div className="w-40 h-40 flex items-center justify-center flex-shrink-0" style={{ borderRadius: 10, background: 'linear-gradient(135deg, var(--accent), var(--accent-light))', color: 'white' }}>
              <Truck size={20} />
            </div>
            <div>
              <div className="text-sm font-bold">Trip: {order.trips.trip_number}</div>
              <div className="text-xs text-secondary">{order.trips.origin} → {order.trips.destination}</div>
            </div>
          </div>
        </div>
      )}

      {/* Sender & Receiver */}
      <div className="customer-contact-grid stagger-item mb-16" style={{ animationDelay: '120ms' }}>
        <div className="customer-detail-card customer-contact-card card"><div className="card-body p-16">
          <div className="text-xs text-tertiary font-bold text-uppercase flex items-center gap-4 mb-8"><User size={12} /> Sender</div>
          <div className="text-sm font-bold" style={{ marginBottom: 2 }}>{order.sender_name}</div>
          <div className="text-sm text-secondary flex items-center gap-4" style={{ marginBottom: 2 }}><Phone size={12} /> {order.sender_phone}</div>
          <div className="text-xs text-secondary"><MapPin size={12} className="inline mr-4" />{order.sender_address}</div>
        </div></div>
        <div className="customer-detail-card customer-contact-card card"><div className="card-body p-16">
          <div className="text-xs text-tertiary font-bold text-uppercase flex items-center gap-4 mb-8"><User size={12} /> Receiver</div>
          <div className="text-sm font-bold" style={{ marginBottom: 2 }}>{order.receiver_name}</div>
          <div className="text-sm text-secondary flex items-center gap-4" style={{ marginBottom: 2 }}><Phone size={12} /> {order.receiver_phone}</div>
          <div className="text-xs text-secondary"><MapPin size={12} className="inline mr-4" />{order.receiver_address}</div>
        </div></div>
      </div>

      {/* Package Details */}
      <div className="customer-detail-card customer-package-card card stagger-item mb-16" style={{ animationDelay: '180ms' }}>
        <div className="card-body p-16">
          <h4 className="fw-700 mb-12 flex items-center gap-8"><Package size={16} aria-hidden="true" />Package Details</h4>
          <div className="grid grid-2 gap-12">
            <div><span className="text-xs text-tertiary">Description</span><div className="text-sm">{order.package_description || '—'}</div></div>

            {order.actual_weight && <div><span className="text-xs text-tertiary">Actual Weight</span><div className="text-sm font-bold text-success">{order.actual_weight} kg</div></div>}
            <div><span className="text-xs text-tertiary">Dimensions</span><div className="text-sm">{order.package_dimensions || '—'}</div></div>
          </div>
          {order.notes && (
            <div className="mt-12 pt-12" style={{ borderTop: '1px dashed var(--customer-line, #E2E8F0)' }}>
              <span className="text-xs text-tertiary">Special Instructions / Notes</span>
              <div className="text-sm mt-4 text-secondary" style={{ whiteSpace: 'pre-wrap' }}>{order.notes}</div>
            </div>
          )}
        </div>
      </div>

      {/* Shipment Proofs */}
      {(resolvedPickupPhotos.length > 0 || resolvedDeliveryPhotos.length > 0) && (
        <div className="customer-detail-card customer-proof-card card stagger-item mb-16" style={{ animationDelay: '240ms' }}>
          <div className="card-body p-16">
            <h4 className="fw-700 mb-12 flex items-center gap-8"><Camera size={16} />Shipment Proofs</h4>
            
            {resolvedPickupPhotos.length > 0 && (
              <div className="mb-20">
                <h5 className="text-xs text-tertiary mb-8 flex items-center gap-4"><Package size={12} /> Pickup</h5>
                <div className="flex gap-10 flex-wrap">
                  {resolvedPickupPhotos.map((url, i) => {
                    const loadState = photoLoadState[i] || 'loading';
                    const canOpen = loadState === 'loaded';
                    return (
                      <button key={`pickup-${i}`} onClick={() => { canOpen && setLightboxImages(resolvedPickupPhotos); setLightboxIndex(i); }} type="button" className="customer-proof-photo-btn" disabled={!canOpen}>
                        <div className="customer-proof-photo-fallback">
                          <Image size={20} />
                          <span>{loadState === 'failed' ? 'Unavailable' : `Photo ${i + 1}`}</span>
                        </div>
                        {canOpen && <div className="customer-proof-photo-preview" style={{ backgroundImage: `url("${url}")` }} />}
                        {canOpen && <div className="customer-proof-photo-overlay"><Image size={12} color="white" /></div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {resolvedDeliveryPhotos.length > 0 && (
              <div>
                <h5 className="text-xs text-tertiary mb-8 flex items-center gap-4"><Check size={12} className="text-success" /> Delivery</h5>
                <div className="flex gap-10 flex-wrap">
                  {resolvedDeliveryPhotos.map((url, i) => {
                    const loadState = deliveryPhotoLoadState[i] || 'loading';
                    const canOpen = loadState === 'loaded';
                    return (
                      <button key={`delivery-${i}`} onClick={() => { canOpen && setLightboxImages(resolvedDeliveryPhotos); setLightboxIndex(i); }} type="button" className="customer-proof-photo-btn" disabled={!canOpen}>
                        <div className="customer-proof-photo-fallback">
                          <Image size={20} />
                          <span>{loadState === 'failed' ? 'Unavailable' : `Photo ${i + 1}`}</span>
                        </div>
                        {canOpen && <div className="customer-proof-photo-preview" style={{ backgroundImage: `url("${url}")` }} />}
                        {canOpen && <div className="customer-proof-photo-overlay"><Image size={12} color="white" /></div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* Payment */}
      <div className="customer-detail-card customer-payment-card card stagger-item" style={{ animationDelay: '300ms' }}>
        <div className="card-body p-16">
          <h4 className="fw-700 mb-12 flex items-center gap-8"><CreditCard size={16} aria-hidden="true" />Payment Details</h4>
          <div className="customer-payment-summary mb-20">
            <div className="text-center">
              <div className="text-xs text-tertiary">Shipping Cost</div>
              <div className="text-sm font-bold text-primary">{isOrderPriced(order) ? formatMoney(parseFloat(order.shipping_cost || 0)) : '—'}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-tertiary">Paid</div>
              <div className="text-sm font-bold text-success">{formatMoney(parseFloat(order.amount_paid || 0))}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-tertiary">Balance</div>
              {settlementState === SETTLEMENT_STATE.UNPRICED ? (
                <div className="text-sm font-bold text-tertiary">—</div>
              ) : (
                <div className={`text-sm font-bold ${settlementState === SETTLEMENT_STATE.OWING ? 'text-error' : 'text-success'}`}>
                  {formatMoney(balance)}
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-2 gap-8">
            <div>
              <span className="text-xs text-tertiary">Method</span>
              <div className="text-sm text-capitalize">
                {order.payment_method === 'gcash' ? 'GCash' : order.payment_method === 'paylater' ? 'Pay Later' : order.payment_method || '—'}
              </div>
            </div>
            <div>
              <span className="text-xs text-tertiary">Status</span>
              <div className="text-sm">
                <span className={`badge ${order.payment_status === 'paid' ? 'badge-success' : order.payment_status === 'partial' ? 'badge-warning' : 'badge-error text-capitalize'}`}>
                  {order.payment_status || 'unpaid'}
                </span>
              </div>
            </div>
          </div>
          {order.promised_payment_date && (
            <div className="alert-banner alert-banner-warning mt-12 py-8 px-12" style={{ fontSize: '0.8125rem' }}>
              <AlertTriangle size={14} /> Payment due: {formatPhDate(order.promised_payment_date)}
            </div>
          )}

          {/* Payment Button — Business Logic Enforcement */}
          {(() => {
            const hasWeight = parseFloat(order.actual_weight || 0) > 0;
            const isPayableStatus = PAYABLE_STATUSES.includes(order.status);
            const canPay = balance > 0 && !isCancelled && isPayableStatus && hasWeight;
            const isEarlyStatus = ['Pending', 'Assigned'].includes(order.status);

            if (verifyingPayment) {
              return (
                <div className="mt-16 text-center">
                  <div className="btn btn-primary w-full justify-center pointer-events-none" style={{ opacity: 0.7,}}>
                    <Loader size={16} className="animate-spin mr-8" />
                    Verifying payment...
                  </div>
                </div>
              );
            }

            if (paymentVerificationPending) {
              return (
                <div className="mt-16 text-center" role="status" aria-live="polite">
                  <div className="alert-banner alert-banner-info py-10 px-12 br-8" style={{ fontSize: '0.8125rem' }}>
                    <Loader size={14} className="animate-spin" aria-hidden="true" />
                    <span>Your payment is still being confirmed. Your balance will change automatically when PayMongo finishes processing.</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-outline w-full justify-center mt-8"
                    onClick={handleRefreshPaymentStatus}
                  >
                    Refresh payment status
                  </button>
                </div>
              );
            }

            if (canPay) {
              return (
                <div className="mt-16 text-center">
                  <button 
                    className="btn btn-primary w-full justify-center" 
                    onClick={handlePayNow}
                    disabled={processingPayment}
                  >
                    {processingPayment ? <Loader size={16} className="animate-spin mr-8" /> : null}
                    {processingPayment ? 'Processing...' : 'Pay Now with GCash'}
                  </button>
                </div>
              );
            }

            if ((balance > 0 || !isOrderPriced(order)) && !isCancelled && isEarlyStatus) {
              return (
                <div className="mt-16">
                  <div className="alert-banner alert-banner-info py-10 px-12 br-8" style={{ fontSize: '0.8125rem' }}>
                    <Package size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>Payment will become available once your shipment has been picked up and the final shipping weight has been confirmed.</span>
                  </div>
                </div>
              );
            }

            return null;
          })()}

          {/* Payment History Table */}
          {paymentTransactions.length > 0 && (
            <div className="mt-20">
              <h5 className="text-xs text-tertiary font-bold mb-8">Payment History</h5>
              <div className="table-responsive customer-payment-history-table-wrap">
                <table className="table customer-payment-history-table m-0">
                  <caption className="sr-only">Payment history for this booking</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Type</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Method</th>
                      <th scope="col">Status</th>
                      <th scope="col">Recorded By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentTransactions.map(tx => {
                      const statusInfo = getPaymentStatusDisplay(tx.payment_status);
                      const friendlyNotes = getCustomerFriendlyNotes(tx.notes, tx.admin_name);
                      const customerRef = getCustomerVisibleRef(tx.transaction_reference);
                      return (
                        <tr key={tx.id}>
                          <td data-label="Date">
                            <div className="cell-stack">
                              <span>{new Date(tx.created_at).toLocaleDateString('en-PH')}</span>
                              <span className="text-tertiary" style={{ fontSize: '0.6875rem' }}>{new Date(tx.created_at).toLocaleTimeString('en-PH', {hour: '2-digit', minute:'2-digit'})}</span>
                            </div>
                          </td>
                          <td data-label="Type">{formatPaymentType(tx.payment_type)}</td>
                          <td data-label="Amount" className="fw-600 text-success">{formatMoney(parseFloat(tx.amount))}</td>
                          <td data-label="Method">
                            <div className="cell-stack">
                              <span>{fmtMethod(tx.payment_method)}</span>
                              {customerRef && <span className="text-tertiary" style={{ fontSize: '0.6875rem', wordBreak: 'break-all' }}>Ref: {customerRef}</span>}
                              {tx.receipt_url && (
                                <a href={tx.receipt_url} target="_blank" rel="noreferrer" className="text-xs text-primary flex items-center gap-4 mt-2">
                                  <Image size={12} /> View Receipt
                                </a>
                              )}
                            </div>
                          </td>
                          <td data-label="Status">
                            <span className={`badge badge-${statusInfo.tone} badge-sm`}>{statusInfo.label}</span>
                          </td>
                          <td data-label="Recorded By">
                            <div className="cell-stack">
                              <span>{formatRecordedBy(tx.admin_name, 'customer')}</span>
                              {friendlyNotes && <span className="text-tertiary" style={{ fontSize: '0.6875rem' }}>{friendlyNotes}</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Timestamps */}
      <div className="customer-detail-timestamps flex justify-between mt-16 text-xs text-tertiary">
        <span>Booked: {formatPhDate(order.created_at)}</span>
        <span>Updated: {formatPhDateTime(order.updated_at)}</span>
      </div>

      {lightboxIndex >= 0 && lightboxImages.length > 0 && (
        <ImageLightbox images={lightboxImages} initialIndex={lightboxIndex} onClose={() => setLightboxIndex(-1)} />
      )}

      {/* Feedback Modal — portalled to <body>. In place it renders inside
          <PageTransition>, whose framer-motion transform creates a stacking
          context, trapping the fixed overlay beneath the bottom tab bar. */}
      {showFeedbackModal && createPortal(
        <FocusTrap active={showFeedbackModal}>
          <div 
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-modal-title"
            onClick={() => { if (!submittingFeedback) handleFeedbackSkip(); }}
            onKeyDown={(e) => { if (e.key === 'Escape' && !submittingFeedback) handleFeedbackSkip(); }}
            className="feedback-modal-overlay animate-fade-in"
          >
            <div
              onClick={e => e.stopPropagation()}
              className="feedback-modal-card animate-scale-in"
            >
              <h3 id="feedback-modal-title" className="fw-800 text-center mb-8">How was your delivery?</h3>
              <p className="text-secondary text-center text-sm mb-24">
                We'd love to hear your feedback on booking {order?.tracking_number}.
              </p>
              
              <div className="flex justify-center gap-8 mb-24">
                {[1, 2, 3, 4, 5].map(star => (
                  <button 
                    key={star}
                    type="button"
                    aria-label={`Rate ${star} star${star > 1 ? 's' : ''}`}
                    onClick={() => setFeedbackRating(star)}
                    className={`feedback-star-btn hover-lift ${star <= feedbackRating ? 'active' : ''}`}
                  >
                    <svg width="36" height="36" viewBox="0 0 24 24" fill={star <= feedbackRating ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                  </button>
                ))}
              </div>

              <div className="form-group mb-24">
                <label className="form-label text-sm fw-600" htmlFor="feedback-message">Message</label>
                <textarea 
                  id="feedback-message"
                  className="form-textarea"
                  rows={4}
                  value={feedbackMessage}
                  onChange={e => setFeedbackMessage(e.target.value)}
                  placeholder="Tell us about your experience..."
                  disabled={submittingFeedback}
                />
              </div>

              <div className="flex flex-col gap-12">
                <button 
                  className="btn btn-primary" 
                  onClick={handleFeedbackSubmit}
                  disabled={submittingFeedback || !feedbackMessage.trim()}
                >
                  {submittingFeedback ? <Loader size={16} className="animate-spin" /> : 'Submit Feedback'}
                </button>
                <button 
                  className="btn btn-ghost" 
                  onClick={handleFeedbackSkip}
                  disabled={submittingFeedback}
                >
                  Skip for Now
                </button>
              </div>
            </div>
          </div>
        </FocusTrap>,
        document.body
      )}
    </div>
  );
};

export default OrderDetailPage;
