import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getOrderById, cancelOwnOrder, createNotification, getPaymentTransactions, submitFeedback, checkIfFeedbackExists } from '../../lib/database';
import { resolvePhotoUrls } from '../../lib/storage';
import { useAuth } from '../../contexts/AuthContext';
import StatusBadge from '../../components/ui/StatusBadge';
import TrackingTimeline from '../../components/ui/TrackingTimeline';
import ConfirmModal from '../../components/ui/ConfirmModal';
import FocusTrap from '../../components/ui/FocusTrap';
import ImageLightbox from '../../components/ui/ImageLightbox';
import { SkeletonOrderCard, SkeletonText } from '../../components/ui/SkeletonLoader';
import { ArrowLeft, MapPin, User, Phone, Package, CreditCard, Truck, Camera, Image, XCircle, Loader, AlertTriangle, Check } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';

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
  usePageTitle('Order Details');
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
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
  
  // Feedback state
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState(5);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [hasFeedback, setHasFeedback] = useState(false);

  // Timeout ref — cleared if data arrives before LOAD_TIMEOUT_MS
  const timeoutRef = useRef(null);
  const isMountedRef = useRef(true);

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
      try {
        pmts = await getPaymentTransactions(id);
      } catch (err) {
        console.warn('Failed to fetch payment history', err);
      }
      clearLoadTimeout();
      if (isMountedRef.current) {
        setOrder(data);
        setPaymentTransactions(pmts);
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

  const handleCancel = async () => {
    setShowCancelModal(false);
    if (!user) {
      toast.error('Your session has expired. Please log in again.');
      navigate('/login');
      return;
    }
    setCancelling(true);
    try {
      await cancelOwnOrder(id);
      // createNotification is non-critical — don't let it block the UI
      try {
        await createNotification(
          user.id,
          'Order Cancelled',
          `Your order ${order.tracking_number} has been cancelled`,
          'order_update',
          order.id
        );
      } catch {
        // Notification failure is non-critical
      }
      await loadOrder();
      toast.warning('Your booking has been cancelled.');
    } catch (err) {
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

  // ── Loading State ──────────────────────────────────────────────────────────
  if (loading) return (
    <div className="page-transition customer-order-detail-page">
      <div className="stagger-item mb-16" style={{ animationDelay: '0ms' }}>
        <div className="skeleton skeleton-text" style={{ width: '30%', height: 20 }} />
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
        <h3 className="mb-8" style={{ color: 'var(--error-dark)' }}>Unable to Load Order</h3>
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
        <h3 className="mb-8">Order Not Found</h3>
        <p className="text-secondary text-sm mb-20">This order does not exist or you don't have permission to view it.</p>
        <button className="btn btn-primary" onClick={() => navigate('/customer/orders')}>Back to Orders</button>
      </div>
    </div>
  );

  const isCancelled = order.status === 'Cancelled';
  const canCancel = order.status === 'Pending';
  const hasPhotos = resolvedPickupPhotos.length > 0;

  return (
    <div className="page-transition customer-order-detail-screen">
      <button onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>

      {/* Header */}
      <div className="customer-order-detail-header flex items-center justify-between animate-slide-up mb-20">
        <div>
          <h2 className="fw-800">{order.tracking_number}</h2>
          <p className="text-sm text-secondary">{order.origin} → {order.destination}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {/* Cancel button for Pending orders */}
      {canCancel && (
        <button className="btn btn-danger btn-sm animate-slide-up mb-16" onClick={() => setShowCancelModal(true)} disabled={cancelling}>
          {cancelling ? <Loader size={14} className="animate-spin" /> : <XCircle size={14} />}
          Cancel Booking
        </button>
      )}

      <ConfirmModal
        isOpen={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        onConfirm={handleCancel}
        title="Cancel This Booking?"
        message="Are you sure you want to cancel this booking? This action cannot be undone and your shipment slot will be released."
        confirmLabel="Yes, Cancel Booking"
        cancelLabel="Keep Booking"
        variant="danger"
        loading={cancelling}
      />

      {/* Tracking Timeline */}
      {!isCancelled && (
        <div className="customer-detail-card customer-tracking-card card stagger-item mb-16" style={{ animationDelay: '40ms' }}>
          <div className="card-body p-16">
            <h4 className="fw-700 mb-16">Tracking Timeline</h4>
            <TrackingTimeline currentStatus={order.status} compact />
          </div>
        </div>
      )}

      {/* Feedback Banner */}
      {order.status === 'Delivered' && !hasFeedback && (
        <div className="alert-banner alert-banner-success animate-scale-in mb-16" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div className="flex flex-col gap-4">
            <div className="fw-700 text-base">🎉 Delivery Complete!</div>
            <p className="text-sm m-0" style={{ opacity: 0.9 }}>How was your experience? Your feedback helps us improve.</p>
          </div>
          <button 
            className="btn btn-alert-action" 
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            onClick={() => setShowFeedbackModal(true)}
          >
            Leave Feedback
          </button>
        </div>
      )}

      {/* Cancelled status display */}
      {isCancelled && (
        <div className="alert-banner alert-banner-error animate-scale-in mb-16 text-center" style={{ padding: '20px 24px' }}>
          <div className="flex flex-col items-center gap-8">
            <XCircle size={32} />
            <div className="fw-700 text-base">Order Cancelled</div>
            <p className="text-sm m-0" style={{ opacity: 0.8 }}>This order has been cancelled and cannot be modified.</p>
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
          <h4 className="fw-700 mb-12"><Package size={16} className="inline mr-8" />Package Details</h4>
          <div className="grid grid-2 gap-12">
            <div><span className="text-xs text-tertiary">Description</span><div className="text-sm">{order.package_description || '—'}</div></div>
            <div><span className="text-xs text-tertiary">Est. Weight</span><div className="text-sm">{order.package_weight} kg</div></div>
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
          <h4 className="fw-700 mb-12"><CreditCard size={16} className="inline mr-8" />Payment Details</h4>
          <div className="customer-payment-summary mb-20">
            <div className="text-center">
              <div className="text-xs text-tertiary">Shipping Cost</div>
              <div className="text-sm font-bold text-primary">₱{parseFloat(order.shipping_cost || 0).toFixed(2)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-tertiary">Paid</div>
              <div className="text-sm font-bold text-success">₱{parseFloat(order.amount_paid || 0).toFixed(2)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-tertiary">Balance</div>
              <div className={`text-sm font-bold ${parseFloat(order.remaining_balance || 0) > 0 ? 'text-error' : 'text-success'}`}>
                ₱{parseFloat(order.remaining_balance || 0).toFixed(2)}
              </div>
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
              <AlertTriangle size={14} /> Payment due: {new Date(order.promised_payment_date).toLocaleDateString()}
            </div>
          )}

          {/* Payment History Table */}
          {paymentTransactions.length > 0 && (
            <div className="mt-20">
              <h5 className="text-xs text-tertiary font-bold mb-8">Payment History</h5>
              <div className="table-responsive customer-payment-history-table-wrap">
                <table className="table customer-payment-history-table" style={{ margin: 0 }}>
                  <caption className="sr-only">Payment history for this order</caption>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Method</th>
                      <th>Ref/Notes</th>
                      <th>Recorded By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentTransactions.map(tx => (
                      <tr key={tx.id}>
                        <td data-label="Date">
                          {new Date(tx.created_at).toLocaleDateString('en-PH')}
                          <span className="text-tertiary ml-4">{new Date(tx.created_at).toLocaleTimeString('en-PH', {hour: '2-digit', minute:'2-digit'})}</span>
                        </td>
                        <td data-label="Type">{tx.payment_type || 'Additional Payment'}</td>
                        <td data-label="Amount" className="fw-600 text-success">₱{parseFloat(tx.amount).toFixed(2)}</td>
                        <td data-label="Method" className="text-capitalize">{tx.payment_method === 'gcash' ? 'GCash' : tx.payment_method}</td>
                        <td data-label="Ref/Notes">
                          {tx.transaction_reference && <div className="text-xs">Ref: {tx.transaction_reference}</div>}
                          {tx.notes && <div className="text-xs text-tertiary">{tx.notes}</div>}
                        </td>
                        <td data-label="Recorded By">{tx.admin_name || 'System'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Timestamps */}
      <div className="customer-detail-timestamps flex justify-between mt-16 text-xs text-tertiary">
        <span>Booked: {new Date(order.created_at).toLocaleDateString()}</span>
        <span>Updated: {new Date(order.updated_at).toLocaleString()}</span>
      </div>

      {lightboxIndex >= 0 && lightboxImages.length > 0 && (
        <ImageLightbox images={lightboxImages} initialIndex={lightboxIndex} onClose={() => setLightboxIndex(-1)} />
      )}

      {/* Feedback Modal */}
      {showFeedbackModal && (
        <FocusTrap active={showFeedbackModal}>
          <div 
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-modal-title"
            onClick={() => { if (!submittingFeedback) handleFeedbackSkip(); }}
            onKeyDown={(e) => { if (e.key === 'Escape' && !submittingFeedback) handleFeedbackSkip(); }}
            style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              background: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 24
            }}
            className="animate-fade-in"
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: 'var(--surface)',
                borderRadius: 24,
                width: '100%', maxWidth: 400,
                padding: 32,
                boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
                position: 'relative'
              }}
              className="animate-scale-in"
            >
              <h3 id="feedback-modal-title" className="fw-800 text-center mb-8">How was your delivery?</h3>
              <p className="text-secondary text-center text-sm mb-24">
                We'd love to hear your feedback on order {order?.tracking_number}.
              </p>
              
              <div className="flex justify-center gap-8 mb-24">
                {[1, 2, 3, 4, 5].map(star => (
                  <button 
                    key={star}
                    type="button"
                    aria-label={`Rate ${star} star${star > 1 ? 's' : ''}`}
                    onClick={() => setFeedbackRating(star)}
                    style={{
                      background: 'none', border: 'none', padding: 4,
                      minWidth: 44, minHeight: 44,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', transition: 'transform 0.2s',
                      color: star <= feedbackRating ? 'var(--warning)' : 'var(--border)'
                    }}
                    className="hover-lift"
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
        </FocusTrap>
      )}
    </div>
  );
};

export default OrderDetailPage;
