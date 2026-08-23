import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { getOrderById, updateOrder, createNotification, getTripReassignments, reassignTrip, getActivityLogsByRecord, getPaymentTransactions, recordAdditionalPayment, recordPickupPayment, recordDeliveryPayment, getOrderStatusEvents, reviewOrderCancellation, cancelOrderAsAdmin, getLatestPaymentAttemptByOrder, clearPaymentReceiptUrls } from '../../lib/database';
import { pollPaymentStatus } from '../../lib/paymongo';
import { logOrder, logPayment } from '../../lib/activityLog';
import { buildStatusTimestamps } from '../../utils/statusTimestamps';
import { resolvePhotoUrls, deletePhoto } from '../../lib/storage';
import { supabase } from '../../lib/supabase';
import StatusBadge from '../../components/ui/StatusBadge';
import TrackingTimeline from '../../components/ui/TrackingTimeline';
import PickupModal from '../../components/ui/PickupModal';
import TripAssignModal from '../../components/ui/TripAssignModal';
import TripReassignModal from '../../components/ui/TripReassignModal';
import AdditionalPaymentModal from '../../components/ui/AdditionalPaymentModal';
import DeliveryModal from '../../components/ui/DeliveryModal';
import ConfirmModal from '../../components/ui/ConfirmModal';
import ImageLightbox from '../../components/ui/ImageLightbox';
import Breadcrumb from '../../components/ui/Breadcrumb';
import FocusTrap from '../../components/ui/FocusTrap';
import { SkeletonText } from '../../components/ui/SkeletonLoader';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';
import CustomSelect from '../../components/ui/CustomSelect';
import MessageCustomerButton from '../../components/ui/MessageCustomerButton';
import {
  STATUS_FLOW, STATUS_TIMELINE, validateStatusTransition,
  getSettlementState, SETTLEMENT_STATE, outstandingBalance,
  PAYMENT_METHODS, PAYMENT_STATUSES, ORDER_STATUS,
  isTripControlledAdvance, canCancelOrder, hasPendingCancellation, timelineStatus
} from '../../constants/status';
import {
  ArrowLeft, Check, Package, CreditCard, User, Phone, MapPin,
  Truck, Loader, Save, Camera, AlertTriangle, X, Image, Clock, Trash2, Star
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDate, formatPhDateTime } from '../../utils/datetime';
import { formatMoney } from '../../utils/currencyInput';
import { truncateRef, isSystemGenerated, getPaymentStatusDisplay, formatRecordedBy as fmtRecordedBy } from '../../utils/paymentDisplay';

const safeFormatDate = (dateStr, options) => {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '—';
    return options ? formatPhDate(d, options) : formatPhDate(d);
  } catch {
    try {
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? '—' : formatPhDate(d);
    } catch {
      return '—';
    }
  }
};

const safeFormatTime = (dateStr, options) => {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    // PH-pinned wall clock — en-PH locale alone would still render in the
    // viewer's zone.
    return d.toLocaleTimeString('en-PH', { ...(options || {}), timeZone: 'Asia/Manila' });
  } catch {
    try {
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila' });
    } catch {
      return '';
    }
  }
};

const safeFormatDateTime = (dateStr) => {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '—';
    return formatPhDateTime(d);
  } catch {
    try {
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? '—' : formatPhDateTime(d);
    } catch {
      return '—';
    }
  }
};

/** 'gcash' → 'GCash', 'paylater' → 'Pay Later', anything else title-cased. */
const formatPaymentMethod = (method) => {
  if (!method) return '';
  const key = String(method).toLowerCase();
  if (key === 'gcash') return 'GCash';
  if (key === 'paylater') return 'Pay Later';
  if (key === 'cash') return 'Cash';
  return key.charAt(0).toUpperCase() + key.slice(1);
};

const AdminOrderDetailPage = () => {
  usePageTitle('Order Details');
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showPickupModal, setShowPickupModal] = useState(false);
  const [showTripModal, setShowTripModal] = useState(false);
  const [showReassignModal, setShowReassignModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showDeclineCancelModal, setShowDeclineCancelModal] = useState(false);
  const [showApproveCancellationModal, setShowApproveCancellationModal] = useState(false);
  const [reviewingCancellation, setReviewingCancellation] = useState(false);
  const [tripHistory, setTripHistory] = useState([]);
  const [activityHistory, setActivityHistory] = useState([]);
  const [statusEvents, setStatusEvents] = useState([]);
  const [paymentTransactions, setPaymentTransactions] = useState([]);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [lightboxImages, setLightboxImages] = useState([]);
  const [resolvedPickupPhotos, setResolvedPickupPhotos] = useState([]);
  const [photoLoadState, setPhotoLoadState] = useState({});
  const [resolvedDeliveryPhotos, setResolvedDeliveryPhotos] = useState([]);
  const [deliveryPhotoLoadState, setDeliveryPhotoLoadState] = useState({});

  // Feature state
  const [featureForm, setFeatureForm] = useState({
    featured_on_website: false,
    featured_title: '',
    featured_caption: '',
    featured_image_type: 'pickup'
  });
  const [savingFeature, setSavingFeature] = useState(false);

  /**
   * How this order was ACTUALLY paid, from the ledger.
   *
   * `orders.payment_method` holds the method of the most recent payment event
   * only, so a GCash pickup later settled in cash at the door rendered a bare
   * "Cash" badge — the same conflation that made the sales report file every
   * peso under whichever method landed last. The ledger is the sole writer of
   * `amount_paid`, so it is also the only honest source for this badge.
   *
   * Filtered to `paid`/`partial` — the predicate update_order_payment_totals
   * uses — so a failed or pending attempt never claims to be a method used.
   */
  const paidMethods = useMemo(() => {
    const methods = paymentTransactions
      .filter(tx => tx.status === 'paid' || tx.status === 'partial')
      .map(tx => tx.payment_method)
      .filter(Boolean);
    return [...new Set(methods)];
  }, [paymentTransactions]);

  // Per-step timestamps for tracking timeline
  const stepTimestamps = useMemo(
    () => buildStatusTimestamps(statusEvents, order?.created_at, order?.status),
    [statusEvents, order?.created_at, order?.status]
  );

  useEffect(() => {
    let isMounted = true;
    loadOrder(isMounted);
    return () => { isMounted = false; };
  }, [id]);

  /**
   * The GCash return path. PayMongo redirects the admin back to
   * `/admin/orders/:id?payment=success` (or `failed`) after the customer
   * authorizes. Same-window navigation is used everywhere — browser, desktop
   * and installed PWA alike — so this is where the payment gets reconciled.
   */
  const [searchParams] = useSearchParams();
  const checkedReturnRef = useRef(false);
  useEffect(() => {
    const paymentResult = searchParams.get('payment');
    if (!paymentResult || checkedReturnRef.current) return;
    checkedReturnRef.current = true;
    navigate(`/admin/orders/${id}`, { replace: true });

    if (paymentResult === 'failed') {
      toast.error('GCash payment was not completed. You can try again.');
      return;
    }

    const verify = async () => {
      let channel = null;
      let confirmed = false;
      let attempt = null;
      const finish = async (sourceAlreadyVerified = false) => {
        if (confirmed) return;
        if (!sourceAlreadyVerified) {
          try {
            const result = await pollPaymentStatus(attempt.source_id, id);
            if (!(result.orderReconciled || result.status === 'paid')) return;
          } catch {
            return;
          }
        }
        confirmed = true;
        if (channel) void supabase.removeChannel(channel);
        toast.success('GCash payment received — recorded automatically.');
        await loadOrder();
      };

      try {
        attempt = await getLatestPaymentAttemptByOrder(id);
        if (!attempt?.source_id) {
          await loadOrder();
          return;
        }
        if (attempt.status === 'reconciled') {
          await loadOrder();
          return;
        }

        channel = supabase
          .channel(`admin_payment_return_${id}`)
          .on('postgres_changes', {
            event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${id}`,
          }, (payload) => {
            // Mirror the customer page's settled test: a ₱0-balance unpriced
            // order must not look paid just because remaining_balance <= 0.
            if (
              payload.new?.payment_status === 'paid'
              || (Number(payload.new?.amount_paid) > 0 && Number(payload.new?.remaining_balance) <= 0)
            ) {
              void finish(false);
            }
          })
          .subscribe();

        for (const delay of [0, 2000, 4000, 6000, 8000]) {
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          if (confirmed) return;
          try {
            const result = await pollPaymentStatus(attempt.source_id, id);
            if (result.orderReconciled || result.status === 'paid') {
              await finish(true);
              return;
            }
          } catch {
            // The webhook/realtime path may still complete the payment.
          }
        }
        if (!confirmed) {
          toast.info('GCash payment is still processing. Check the order again in a moment.');
          await loadOrder();
          setTimeout(() => { if (channel && !confirmed) void supabase.removeChannel(channel); }, 30000);
        }
      } catch {
        await loadOrder();
      }
    };
    verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    let isMounted = true;
    const photos = Array.isArray(order?.pickup_photos) ? order.pickup_photos : [];
    if (photos.length === 0) { setResolvedPickupPhotos([]); return () => { isMounted = false; }; }
    resolvePhotoUrls(photos)
      .then(urls => { if (isMounted) setResolvedPickupPhotos(urls); })
      .catch(() => { if (isMounted) setResolvedPickupPhotos([]); });
    return () => { isMounted = false; };
  }, [order?.pickup_photos]);

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
    let isMounted = true;
    const photos = Array.isArray(order?.delivery_photos) ? order.delivery_photos : [];
    if (photos.length === 0) { setResolvedDeliveryPhotos([]); return () => { isMounted = false; }; }
    resolvePhotoUrls(photos)
      .then(urls => { if (isMounted) setResolvedDeliveryPhotos(urls); })
      .catch(() => { if (isMounted) setResolvedDeliveryPhotos([]); });
    return () => { isMounted = false; };
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

  const loadOrder = async (isMounted = true) => {
    setError(null); setLoading(true);
    try {
      const data = await getOrderById(id);
      if (!isMounted) return;
      setOrder(data);
      setFeatureForm({
        featured_on_website: data.featured_on_website || false,
        featured_title: data.featured_title || '',
        featured_caption: data.featured_caption || '',
        featured_image_type: data.featured_image_type || 'pickup'
      });
      const history = await getTripReassignments(id);
      if (isMounted) setTripHistory(history);
      const actLogs = await getActivityLogsByRecord(id);
      if (isMounted) setActivityHistory(actLogs);
      const events = await getOrderStatusEvents(id);
      if (isMounted) setStatusEvents(events);
      const pmts = await getPaymentTransactions(id);
      if (isMounted) setPaymentTransactions(pmts);
    } catch (e) {
      if (isMounted) setError(e.message || 'Failed to load order.');
    } finally {
      if (isMounted) setLoading(false);
    }
  };

  const handleStatusAdvance = async () => {
    const next = STATUS_FLOW[order.status];
    if (!next) return;
    // The button is hidden for these, but a hidden button is a hint and this is
    // the enforcement point — realtime can land a trip cascade between render
    // and click.
    if (isTripControlledAdvance(order)) {
      toast.error(`"${next}" is set by the trip for every order aboard. Update the trip instead.`);
      return;
    }
    // "Assigned" means assigned to a *trip*. Without one the status is a claim
    // about nothing, so the click is redirected to the thing that has to happen
    // first rather than refused — the admin wanted to move this order forward,
    // and picking the trip is how that is done. Assigning writes the status
    // itself (handleTripAssign), so there is no second step afterwards.
    if (next === ORDER_STATUS.ASSIGNED && !order.trip_id) {
      setShowTripModal(true);
      return;
    }
    if (next === ORDER_STATUS.PICKED_UP) {
      if (!order.trip_id) {
        toast.error("This booking must be assigned to a trip before pickup can be processed.");
        return;
      }
      setShowPickupModal(true); 
      return; 
    }
    if (next === ORDER_STATUS.DELIVERED) {
      setShowDeliveryModal(true);
      return;
    }
    const validation = validateStatusTransition(order.status, next, order.trip_id, order);
    if (!validation.valid) { toast.error(validation.error); return; }
    setSaving(true);
    try {
      await updateOrder(id, { status: next });
      logOrder(`Status Changed to ${next}`, id, order.tracking_number, { previousValue: { status: order.status }, newValue: { status: next }, details: `Status advanced from ${order.status} to ${next}` });
      await createNotification(order.user_id, 'Order Updated', `Order ${order.tracking_number}: ${next}`, 'order_update', order.id);
      await loadOrder();
      toast.success(`Status updated to "${next}"`);
    } catch (e) { toast.error(e.message || 'Failed to update status'); }
    finally { setSaving(false); }
  };

  const handlePickupSave = async (pickupData) => {
    try {
      // Single transaction: order metadata UPDATE + ledger INSERT. The RPC
      // never writes amount_paid/payment_status — update_order_payment_totals
      // derives them from the ledger. See P0-1 in the architecture review.
      await recordPickupPayment(id, pickupData);

      // pickupData.payment is null when a PayMongo QR is still pending — the
      // webhook records that payment into the ledger, not this save.
      const collected = pickupData.payment
        ? `₱${pickupData.payment.amount}`
        : 'pending PayMongo confirmation';
      logOrder('Pickup Processed', id, order.tracking_number, { details: `Pickup processed. Weight: ${pickupData.actual_weight}kg, Payment: ${pickupData.payment_method}, Amount: ${collected}` });

      await createNotification(order.user_id, 'Pickup Complete', `Order ${order.tracking_number} has been picked up`, 'order_update', order.id);
      setShowPickupModal(false);
      await loadOrder();
      toast.success('Pickup processed successfully!');
    } catch (e) { throw e; }
  };

  const handleDeliverySave = async (deliveryData) => {
    try {
      await recordDeliveryPayment(id, deliveryData);

      logOrder('Delivery Proof Uploaded', id, order.tracking_number, { details: `Delivery processed. Photos uploaded: ${deliveryData.delivery_photos.length}` });
      await createNotification(order.user_id, 'Delivery Complete', `Order ${order.tracking_number} has been delivered`, 'order_update', order.id);
      setShowDeliveryModal(false);
      await loadOrder();
      toast.success('Delivery processed successfully!');
    } catch (e) { throw e; }
  };

  const handleTripAssign = async (tripId) => {
    try {
      await updateOrder(id, { trip_id: tripId, status: 'Assigned' });
      logOrder('Assigned to Trip', id, order.tracking_number, { details: `Booking assigned to trip ID ${tripId}` });
      await createNotification(order.user_id, 'Order Assigned', `Order ${order.tracking_number} assigned to a trip`, 'order_update', order.id);
      setShowTripModal(false);
      await loadOrder();
      toast.success('Order assigned to trip!');
    } catch (e) { toast.error(e.message || 'Failed to assign trip'); }
  };

  const handleTripReassign = async (newTripId, reason) => {
    try {
      await reassignTrip(id, newTripId, reason);
      logOrder('Trip Reassigned', id, order.tracking_number, { previousValue: { trip_id: order.trip_id, trip_number: order.trips?.trip_number }, newValue: { trip_id: newTripId }, details: `Reason: ${reason}` });
      await createNotification(order.user_id, 'Trip Reassigned', `Order ${order.tracking_number} has been moved to a new trip`, 'order_update', order.id);
      setShowReassignModal(false);
      await loadOrder();
      toast.success('Trip changed successfully!');
    } catch (e) { toast.error(e.message || 'Failed to change trip'); }
  };

  // Cancelling used to be a bare yes/no. The row then said 'Cancelled' with
  // nothing beside it, and the only way to answer "why was this cancelled?"
  // weeks later was to ask whoever clicked. The reason is now mandatory, stored
  // on the order, written into the activity log, and told to the customer —
  // who is otherwise the last person to learn their booking is gone.
  const handleCancel = async (reason) => {
    if (!canCancelOrder(order)) {
      setShowCancelConfirm(false);
      toast.error(`An order that is "${order.status}" is already in the network and cannot be cancelled.`);
      return;
    }
    setSaving(true);
    try {
      await cancelOrderAsAdmin(id, reason);
      logOrder('Order Cancelled', id, order.tracking_number, {
        previousValue: { status: order.status },
        newValue: { status: 'Cancelled', cancellation_reason: reason },
        details: `Cancelled by admin. Reason: ${reason}`,
      });
      await createNotification(order.user_id, 'Order Cancelled', `Order ${order.tracking_number} has been cancelled. Reason: ${reason}`, 'order_update', order.id);
      setShowCancelConfirm(false);
      await loadOrder();
      toast.success('Order cancelled.');
    } catch (e) {
      toast.error(e.message || 'Failed to cancel this order.');
    } finally {
      setSaving(false);
    }
  };

  // Approve or decline the customer's cancellation request.
  //
  // No logOrder() here on purpose: review_order_cancellation() writes the
  // activity log and the customer's notification inside the same transaction
  // as the status change. An audit entry that can be lost because the tab was
  // closed between two round trips is not an audit entry.
  const handleReviewCancellation = async (approve, notes = null) => {
    setReviewingCancellation(true);
    try {
      await reviewOrderCancellation(id, approve, notes);
      setShowDeclineCancelModal(false);
      setShowApproveCancellationModal(false);
      await loadOrder();
      toast.success(approve
        ? 'Cancellation approved. The order is now cancelled and the customer has been notified.'
        : 'Cancellation declined. The order is back where it was and the customer has been notified.');
    } catch (e) {
      toast.error(e.message || 'Failed to record the cancellation decision.');
    } finally {
      setReviewingCancellation(false);
    }
  };

  const handleAdditionalPayment = async (amount, method, ref, notes, date, receiptUrl, skipInsert = false) => {
    try {
      await recordAdditionalPayment(id, amount, method, ref, notes, date, receiptUrl, skipInsert);
      setShowPaymentModal(false);
      await loadOrder();
      toast.success('Payment recorded successfully.');
    } catch (err) {
      throw err;
    }
  };

  const handleApproveReview = async () => {
    setSaving(true);
    try {
      await updateOrder(id, { status: 'Pending', service_area_status: 'approved' });
      logOrder('Out-of-Coverage Request Approved', id, order.tracking_number, { details: 'Admin approved the special pickup request.' });
      await createNotification(order.user_id, 'Pickup Request Approved', `Your special pickup request for Order ${order.tracking_number} has been approved.`, 'order_update', order.id);
      await loadOrder();
      toast.success('Pickup request approved.');
    } catch (e) {
      toast.error(e.message || 'Failed to approve request.');
    } finally {
      setSaving(false);
    }
  };

  const handleRejectReview = async (reason) => {
    setSaving(true);
    try {
      await updateOrder(id, { status: 'Cancelled', service_area_status: 'rejected', service_area_remarks: reason });
      logOrder('Out-of-Coverage Request Rejected', id, order.tracking_number, { details: `Reason: ${reason}` });
      await createNotification(order.user_id, 'Pickup Request Rejected', `Your special pickup request for Order ${order.tracking_number} could not be accommodated. Reason: ${reason}`, 'order_update', order.id);
      await loadOrder();
      toast.success('Pickup request rejected.');
    } catch (e) {
      toast.error(e.message || 'Failed to reject request.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveFeature = async () => {
    if (featureForm.featured_on_website && !featureForm.featured_title) {
      toast.error('Highlight title is required when featuring.');
      return;
    }
    setSavingFeature(true);
    try {
      const dataToSave = {
        featured_on_website: featureForm.featured_on_website,
        featured_title: featureForm.featured_title || null,
        featured_caption: featureForm.featured_caption || null,
        featured_image_type: featureForm.featured_image_type,
        featured_at: featureForm.featured_on_website ? (order.featured_at || new Date().toISOString()) : null
      };
      await updateOrder(id, dataToSave);
      logOrder(
        dataToSave.featured_on_website ? 'Featured on Website' : 'Removed from Website Feature',
        id,
        order.tracking_number,
        {
          previousValue: { featured_on_website: order.featured_on_website, featured_title: order.featured_title },
          newValue: { featured_on_website: dataToSave.featured_on_website, featured_title: dataToSave.featured_title },
          details: dataToSave.featured_on_website
            ? `Published this delivery to the public website as "${dataToSave.featured_title}".`
            : 'Removed this delivery from the public website.',
        }
      );
      toast.success('Website feature updated.');
      await loadOrder();
    } catch (err) {
      toast.error('Failed to update website feature.');
    } finally {
      setSavingFeature(false);
    }
  };

  const handleManualCleanup = async () => {
    setShowCleanupConfirm(false);
    setSaving(true);
    try {
      // 1. Delete Pickup Photos
      if (order.pickup_photos && order.pickup_photos.length > 0) {
        for (const photo of order.pickup_photos) {
          try { await deletePhoto(photo); } catch(e) { console.error('Failed to delete pickup photo', photo, e); }
        }
      }
      
      // 2. Delete Delivery Photos
      if (order.delivery_photos && order.delivery_photos.length > 0) {
        for (const photo of order.delivery_photos) {
          try { await deletePhoto(photo); } catch(e) { console.error('Failed to delete delivery photo', photo, e); }
        }
      }

      // 3. Delete Receipts
      for (const tx of paymentTransactions) {
        if (tx.receipt_url) {
          try { await deletePhoto(tx.receipt_url); } catch(e) { console.error('Failed to delete receipt photo', tx.receipt_url, e); }
        }
      }

      // 4. Update DB
      await updateOrder(id, { pickup_photos: [], delivery_photos: [] });
      
      if (paymentTransactions.length > 0) {
        await clearPaymentReceiptUrls(id);
      }

      logOrder('Evidence Cleaned Up', id, order.tracking_number, { details: 'Admin manually deleted all evidence photos from storage to conserve space.' });
      await loadOrder();
      toast.success('Evidence photos deleted from storage.');
    } catch (e) {
      toast.error('Failed to cleanup evidence: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="page-transition">
      <div className="skeleton skeleton-text w-80 mb-16" />
      <div className="skeleton skeleton-text mb-8" style={{ width: '200px', height: 28 }} />
      <div className="skeleton skeleton-text mb-20" style={{ width: '300px' }} />
      <div className="card mb-16"><div className="card-body"><SkeletonText lines={3} /></div></div>
      <div className="card mb-16"><div className="card-body"><SkeletonText lines={4} /></div></div>
    </div>
  );
  if (error) return (
    <div className="page-transition">
      <div className="card text-center text-error" role="alert" style={{ padding: 40 }}>
        <h3>Error Loading Order</h3>
        <p className="mt-8 mb-20">{error}</p>
        <button type="button" className="btn btn-primary" onClick={() => loadOrder()}>Retry</button>
      </div>
    </div>
  );
  if (!order) return <div className="empty-state"><h3>Order not found</h3></div>;

  const nextStatus = STATUS_FLOW[order.status];
  const isTerminal = order.status === 'Delivered' || order.status === 'Cancelled';

  // ── Who owns the next move ───────────────────────────────────────────────
  // Once an order is on a trip, "departed" and "arrived at the hub" are facts
  // about the vehicle, and TripDetailPage writes them to every order aboard at
  // once. Offering the same step here per order let one parcel be marched ahead
  // of the truck it is sitting in, and the trip's later bulk update then wrote
  // over it. The trip is the single writer for those two steps.
  //
  // This generalises the hand-written "Picked Up → In Transit" exclusion that
  // used to sit inline in the JSX; "In Transit → Arrived at Hub" was the case
  // it missed.
  const tripOwnsNextStep = isTripControlledAdvance(order);
  // Out for Delivery and Delivered stay manual — they are last-mile events for
  // one parcel at one door, and Out for Delivery carries the settlement gate.
  const needsTrip = order.status === 'Pending' && !order.trip_id;
  // While a trip is missing, "Assign to Trip" IS the advance step — assigning
  // sets the status. Two buttons for one action invited the click that produced
  // an Assigned order with no trip.
  const showAdvanceButton = Boolean(nextStatus) && !tripOwnsNextStep && !needsTrip;
  const showCancelButton = canCancelOrder(order);
  const awaitingCancellationReview = hasPendingCancellation(order);
  const hasPhotos = resolvedPickupPhotos.length > 0;
  const canReassignTrip = order.trip_id && [ORDER_STATUS.PENDING, ORDER_STATUS.ASSIGNED].includes(order.status);

  // Back out the rate from a weighed order; otherwise fall back to the
  // default. There is no declared weight to divide by any more.
  const ratePerKg = parseFloat(order.trips?.price_per_kg || 0) > 0
    ? parseFloat(order.trips.price_per_kg)
    : parseFloat(order.actual_weight || 0) > 0
      ? parseFloat(order.shipping_cost || 0) / parseFloat(order.actual_weight)
      : 70;

  const currentWeight = parseFloat(order.actual_weight) || 0;
  const computedShippingCost = currentWeight * ratePerKg;
  const computedAmountPaid = parseFloat(order.amount_paid || 0);
  const computedRemainingBalance = computedShippingCost - computedAmountPaid;
  const isOverpaid = computedRemainingBalance < 0;
  const pickupPricePerKilo = ratePerKg;

  // 'unpriced' | 'settled' | 'owing'. Read from the shared helper so this page,
  // the dispatch gate, and the Unsettled list all answer the money question the
  // same way — an unweighed parcel is none of paid, unpaid, or settled.
  const settlementState = getSettlementState(order);

  return (
    <div className="page-transition">
      <Breadcrumb items={[
        { label: 'Dashboard', to: '/admin' },
        { label: 'Orders', to: '/admin/orders' },
        { label: order.tracking_number },
      ]} />

      <ErrorBoundarySection message="Order info failed to load.">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="fw-800 text-2xl">{order.tracking_number}</h1>
        <div className="flex items-center">
            <StatusBadge status={order.status} />
            {order.status === 'Delivered' && computedRemainingBalance > 0 && (
              <span className="badge badge-error ml-8 flex items-center gap-4" style={{ height: 28 }}>
                <AlertTriangle size={14} /> Outstanding Balance: {formatMoney(computedRemainingBalance)}
              </span>
            )}
        </div>
      </div>
      <div className="flex items-center gap-8 text-sm mb-20 flex-wrap">
        <span className="fw-800 text-secondary">{order.origin}</span>
        <span className="fw-700" style={{ color: 'var(--primary-text)' }}>➔</span>
        <span className="fw-800 text-secondary">{order.destination}</span>
        <span className="text-secondary opacity-50">•</span>
        <span className="text-secondary">{order.profiles?.name}</span>
        {/* The customer who booked this — `orders.user_id`; there is no
            customer_id column. Labelled here because this row has the space
            and it is the entry point an admin reaches for most often. */}
        <MessageCustomerButton
          customerId={order.user_id}
          customerName={order.profiles?.name}
          showLabel
        />
      </div>

      {/* Why this booking is cancelled — shown on the order itself, not only in
          the activity log, because "why?" is the first question anyone opening
          a cancelled order has. Covers both routes in: an approved customer
          request (which carries cancellation_requested_at) and an admin
          cancelling outright (which does not). */}
      {order.status === 'Cancelled' && order.cancellation_reason && (
        <div className="card admin-section-card stagger-item mb-16" style={{ animationDelay: '40ms' }}>
          <div className="card-body">
            <h3 className="flex items-center gap-8 text-sm fw-700 mb-8">
              <AlertTriangle size={16} aria-hidden="true" /> Cancellation Reason
            </h3>
            <p className="text-xs text-secondary mb-8">
              {order.cancellation_requested_at
                ? `Requested by ${order.profiles?.name || 'the customer'}`
                : 'Cancelled by an admin'}
              {order.cancellation_reviewed_at
                ? ` • ${safeFormatDate(order.cancellation_reviewed_at, { month: 'short', day: 'numeric', year: 'numeric' })}`
                : ''}
            </p>
            <blockquote
              className="text-sm m-0"
              style={{ borderLeft: '3px solid var(--border)', paddingLeft: 12 }}
            >
              {order.cancellation_reason}
            </blockquote>
          </div>
        </div>
      )}

      {/* Cancellation Request Review Action Bar.
          Sits above the out-of-coverage bar because it is the more urgent of
          the two: the booking is frozen and a customer is waiting on an
          answer. */}
      {awaitingCancellationReview && (
        <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '40ms', borderColor: 'var(--warning)', background: 'var(--warning-bg)' }}>
          <div className="card-body">
            <h3 className="flex items-center gap-8 mb-12" style={{ color: 'var(--warning-dark)' }}>
              <AlertTriangle size={20} /> Cancellation Request
            </h3>
            <p className="text-sm mb-8" style={{ color: 'var(--warning-dark)' }}>
              <strong>{order.profiles?.name || 'The customer'}</strong> asked to cancel this booking
              {order.cancellation_requested_at
                ? ` on ${safeFormatDate(order.cancellation_requested_at, { month: 'short', day: 'numeric', year: 'numeric' })}`
                : ''}.
              It was <strong>{order.cancellation_previous_status || 'Pending'}</strong> at the time
              and goes back there if you decline.
            </p>
            <blockquote
              className="text-sm mb-16"
              style={{ color: 'var(--warning-dark)', borderLeft: '3px solid var(--warning)', paddingLeft: 12, margin: '0 0 16px' }}
            >
              {order.cancellation_reason || 'No reason recorded.'}
            </blockquote>
            <div className="admin-action-group">
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setShowApproveCancellationModal(true)}
                disabled={reviewingCancellation}
              >
                {reviewingCancellation ? <Loader size={16} className="animate-spin" /> : <Check size={16} />}
                Approve &amp; Cancel Order
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowDeclineCancelModal(true)}
                disabled={reviewingCancellation}
              >
                Decline Request
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => navigate(`/admin/inbox?customerId=${encodeURIComponent(order.user_id)}`)}
              >
                <Phone size={16} /> Contact Customer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Out of Coverage Review Action Bar */}
      {order.service_area_status === 'for_review' && (
        <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '60ms', borderColor: 'var(--warning)', background: 'var(--warning-bg)' }}>
          <div className="card-body">
            <h3 className="flex items-center gap-8 mb-12" style={{ color: 'var(--warning-text)' }}>
              <AlertTriangle size={20} /> Out of Coverage Pickup Review
            </h3>
            <p className="text-sm mb-16" style={{ color: 'var(--warning-text)' }}>
              This pickup location is outside standard coverage: <strong>{order.sender_address}</strong>.<br />
              Please review feasibility and choose an action.
            </p>
            <div className="admin-action-group">
              <button type="button" className="btn btn-primary" onClick={handleApproveReview} disabled={saving}>
                {saving ? <Loader size={16} className="animate-spin" /> : <Check size={16} />}
                Approve Request
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => setShowRejectModal(true)} disabled={saving}>
                Reject Request
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={async () => {
                try {
                  logOrder('Customer Contacted', id, order.tracking_number, { details: 'Admin contacted the customer regarding special pickup request.' });
                } catch(e) {}
                // Same route as MessageCustomerButton. This used to pass
                // router state, which InboxPage no longer reads — one
                // mechanism, and a URL that survives a reload.
                navigate(`/admin/inbox?customerId=${encodeURIComponent(order.user_id)}`);
              }}>
                <Phone size={16} /> Contact Customer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status Action Bar */}
      {(!isTerminal && !awaitingCancellationReview && order.service_area_status !== 'for_review'
        && (needsTrip || showAdvanceButton || showCancelButton || tripOwnsNextStep)) && (
        <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '60ms' }}>
          <div className="card-body">
            {/* Says where the missing button went. Without this the bar just
                empties out and the step looks broken rather than delegated. */}
            {tripOwnsNextStep && (
              <div className="flex items-start gap-8 text-sm text-secondary mb-12">
                <Truck size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  This order moves with its trip. <strong>{nextStatus}</strong> is set for every
                  order aboard when the trip is updated.
                </span>
              </div>
            )}
            <div className="admin-action-group">
            {tripOwnsNextStep && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => navigate(`/admin/trips/${order.trip_id}`)}
              >
                <Truck size={16} /> Open {order.trips?.trip_number || 'Trip'}
              </button>
            )}
            {needsTrip && (
              <button type="button" className="btn btn-secondary" onClick={() => setShowTripModal(true)}>
                <Truck size={16} /> Assign to Trip
              </button>
            )}
            {showAdvanceButton && (
              <button type="button" className="btn btn-primary" onClick={handleStatusAdvance} disabled={saving}>
                {saving ? <Loader size={16} className="animate-spin" /> : <Check size={16} />}
                {nextStatus === 'Picked Up' ? 'Process Pickup' : `Advance to "${nextStatus}"`}
              </button>
            )}
            {showCancelButton && (
              <button type="button" className="btn btn-danger btn-sm" onClick={() => setShowCancelConfirm(true)} disabled={saving}>
                Cancel Order
              </button>
            )}
            </div>
          </div>
        </div>
      )}

      {/* Terminal Order Actions */}
      {isTerminal && (resolvedPickupPhotos.length > 0 || resolvedDeliveryPhotos.length > 0) && (
        <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '60ms' }}>
          <div className="card-body">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="fw-700 text-sm mb-4">Storage Optimization</h4>
                <p className="text-xs text-secondary">This order is completed. You can delete its evidence photos from storage to free up space.</p>
              </div>
              <button type="button" className="btn btn-danger btn-sm flex items-center gap-6" onClick={() => setShowCleanupConfirm(true)} disabled={saving}>
                {saving ? <Loader size={14} className="animate-spin" /> : <Trash2 size={14} />} Manual Evidence Cleanup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Trip Warning */}
      {needsTrip && (
        <div className="alert-banner alert-banner-error" style={{ background: 'var(--warning-bg)', color: 'var(--warning-text)', borderColor: 'var(--warning)' }}>
          <span className="flex items-center gap-10">
            <AlertTriangle size={18} />
            This order has not been assigned to a trip yet. Assign it before advancing status.
          </span>
        </div>
      )}

      {/* Timeline */}
      <ErrorBoundarySection message="Tracking timeline failed to load.">
      <div className="card admin-section-card stagger-item mb-16" style={{ animationDelay: '120ms' }}>
        <div className="card-header"><h3>Status Timeline</h3></div>
        <div className="card-body"><TrackingTimeline currentStatus={timelineStatus(order)} compact stepTimestamps={stepTimestamps} /></div>
      </div>
      </ErrorBoundarySection>

      {/* Sender / Receiver */}
      <div className="grid grid-2 mb-16">
        <div className="card stagger-item" style={{ animationDelay: '180ms' }}><div className="card-body p-16">
          <div className="text-xs text-tertiary font-bold text-uppercase flex items-center gap-6" style={{ marginBottom: 10 }}><User size={12} /> Sender</div>
          <div className="text-sm font-bold">{order.sender_name}</div>
          <div className="text-sm text-secondary flex items-center gap-4" style={{ marginTop: 2 }}><Phone size={12} /> {order.sender_phone}</div>
          <div className="text-xs text-secondary" style={{ marginTop: 6 }}><MapPin size={12} className="inline mr-4" />{order.sender_address}</div>
        </div></div>
        <div className="card stagger-item" style={{ animationDelay: '240ms' }}><div className="card-body p-16">
          <div className="text-xs text-tertiary font-bold text-uppercase flex items-center gap-6" style={{ marginBottom: 10 }}><User size={12} /> Receiver</div>
          <div className="text-sm font-bold">{order.receiver_name}</div>
          <div className="text-sm text-secondary flex items-center gap-4" style={{ marginTop: 2 }}><Phone size={12} /> {order.receiver_phone}</div>
          <div className="text-xs text-secondary" style={{ marginTop: 6 }}><MapPin size={12} className="inline mr-4" />{order.receiver_address}</div>
        </div></div>
      </div>

      {/* Trip Assignment Info */}
      {order.trip_id && (
        <div className="card admin-section-card stagger-item mb-16" style={{ animationDelay: '260ms' }}>
          <div className="card-header flex items-center justify-between">
            <h3><Truck size={16} className="inline mr-8" />Assigned Trip</h3>
            {canReassignTrip && (
              <button className="btn btn-outline btn-sm" onClick={() => setShowReassignModal(true)} disabled={saving}>
                Change Assigned Trip
              </button>
            )}
          </div>
          <div className="card-body">
            <div className="text-sm mb-4 flex items-center gap-8 flex-wrap">
              <strong className="text-primary">{order.trips?.trip_number || 'Unknown Trip'}</strong>
              <span className="text-secondary">({order.trips?.origin} ➔ {order.trips?.destination})</span>
            </div>
            
            {tripHistory && tripHistory.length > 0 && (
              <div className="mt-16 pt-16 border-t">
                <h4 className="text-xs text-tertiary text-uppercase mb-12"><Clock size={12} className="inline mr-4" />Trip History</h4>
                <div className="flex flex-col gap-12">
                  {tripHistory.map((history) => (
                    <div key={history.id} className="text-sm bg-surface p-12 br-8">
                      <div className="flex justify-between mb-4">
                        <strong>
                          {history.prev_trip?.trip_number || 'None'} → {history.new_trip?.trip_number || 'Unknown'}
                        </strong>
                        <span className="text-xs text-secondary">{safeFormatDateTime(history.created_at)}</span>
                      </div>
                      <div className="text-secondary mb-4">Reason: {history.reason}</div>
                      <div className="text-xs text-tertiary">Changed by: {history.admin?.name || 'Admin'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      </ErrorBoundarySection>

      {/* Package Details */}
      <div className="card stagger-item mb-16" style={{ animationDelay: '300ms' }}>
        <div className="card-header"><h3><Package size={16} className="inline mr-8" />Package Details</h3></div>
        <div className="card-body p-16">
          <div className="grid grid-3 gap-16">
            <div><div className="text-xs text-tertiary" style={{ marginBottom: 2 }}>Description</div><div className="text-sm font-bold">{order.package_description || '—'}</div></div>

            <div><div className="text-xs text-tertiary" style={{ marginBottom: 2 }}>Actual Weight</div>
              <div className={`text-sm font-bold ${order.actual_weight ? 'text-success' : 'text-tertiary'}`}>
                {order.actual_weight ? `${order.actual_weight} kg` : 'Not weighed'}
              </div>
            </div>
          </div>
          {order.trip_id && order.trips && (
            <div className="trip-info-box mt-12 px-12 py-8">
              <Truck size={14} className="inline mr-6" />
              Trip: <strong>{order.trips.trip_number}</strong> ({order.trips.origin} ➔ {order.trips.destination})
            </div>
          )}
        </div>
      </div>

      {/* Shipment Evidence */}
      {(resolvedPickupPhotos.length > 0 || resolvedDeliveryPhotos.length > 0) && (
      <ErrorBoundarySection message="Shipment photos failed to load.">
        <div className="card stagger-item mb-16" style={{ animationDelay: '360ms' }}>
          <div className="card-header"><h3><Camera size={16} className="inline mr-8" />Shipment Evidence</h3></div>
          <div className="card-body p-16">
            
            {/* Pickup Photos */}
            {resolvedPickupPhotos.length > 0 && (
              <div className="mb-24">
                <h4 className="text-sm fw-700 mb-12 flex items-center gap-8">
                  <Package size={14} /> Pickup Proofs
                </h4>
                <div className="gap-12" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
                  {resolvedPickupPhotos.map((url, i) => {
                    const loadState = photoLoadState[i] || 'loading';
                    const canOpen = loadState === 'loaded';
                    return (
                      <button key={`pickup-${i}`} onClick={() => { canOpen && setLightboxImages(resolvedPickupPhotos); setLightboxIndex(i); }} className="customer-proof-photo-btn" type="button" disabled={!canOpen}>
                        <div className="customer-proof-photo-fallback">
                          <Image size={20} />
                          <span>{loadState === 'failed' ? 'Image unavailable' : `Photo ${i + 1}`}</span>
                        </div>
                        {canOpen && <div className="customer-proof-photo-preview" style={{ backgroundImage: `url("${url}")` }} />}
                        {canOpen && <div className="customer-proof-photo-overlay"><Image size={12} color="white" /></div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Delivery Photos */}
            {resolvedDeliveryPhotos.length > 0 && (
              <div>
                <h4 className="text-sm fw-700 mb-12 flex items-center gap-8">
                  <Check size={14} className="text-success" /> Delivery Proofs
                </h4>
                <div className="gap-12" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
                  {resolvedDeliveryPhotos.map((url, i) => {
                    const loadState = deliveryPhotoLoadState[i] || 'loading';
                    const canOpen = loadState === 'loaded';
                    return (
                      <button key={`delivery-${i}`} onClick={() => { canOpen && setLightboxImages(resolvedDeliveryPhotos); setLightboxIndex(i); }} className="customer-proof-photo-btn" type="button" disabled={!canOpen}>
                        <div className="customer-proof-photo-fallback">
                          <Image size={20} />
                          <span>{loadState === 'failed' ? 'Image unavailable' : `Photo ${i + 1}`}</span>
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
      </ErrorBoundarySection>
      )}

      {/* Payment & Weight Management */}
      <div className="card admin-section-card stagger-item" style={{ animationDelay: '420ms' }}>
        <div className="card-header"><h3><CreditCard size={16} className="inline mr-8" />Payment & Details</h3></div>
        <div className="card-body">
          <div className="admin-payment-summary">
            <div className="text-center">
              <div className="text-xs text-tertiary" style={{ marginBottom: 2 }}>Shipping Cost</div>
              <div className="text-lg fw-800 text-primary">{settlementState === SETTLEMENT_STATE.UNPRICED ? '—' : formatMoney(computedShippingCost)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-tertiary" style={{ marginBottom: 2 }}>Amount Paid</div>
              <div className="text-lg fw-800 text-success">{settlementState === SETTLEMENT_STATE.UNPRICED ? '—' : formatMoney(computedAmountPaid)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-tertiary" style={{ marginBottom: 2 }}>{isOverpaid ? 'Overpaid' : 'Balance'}</div>
              <div className={`text-lg fw-800 ${settlementState === SETTLEMENT_STATE.UNPRICED ? 'text-tertiary' : isOverpaid ? 'text-warning' : computedRemainingBalance > 0 ? 'text-error' : 'text-success'}`}>
                {settlementState === SETTLEMENT_STATE.UNPRICED ? '—' : isOverpaid ? `+${formatMoney(Math.abs(computedRemainingBalance))}` : formatMoney(computedRemainingBalance)}
              </div>
            </div>
          </div>

          <div className="flex gap-8 flex-wrap mb-16">
            {/* Ledger first, order column only as a fallback for pre-ledger
                orders that have no transaction rows to read. */}
            {paidMethods.length > 1 ? (
              <span
                className="badge badge-info"
                title={`Paid via ${paidMethods.map(formatPaymentMethod).join(' + ')}`}
              >
                Mixed Methods: {paidMethods.map(formatPaymentMethod).join(' + ')}
              </span>
            ) : (paidMethods[0] || order.payment_method) ? (
              <span className="badge badge-info">
                {formatPaymentMethod(paidMethods[0] || order.payment_method)}
              </span>
            ) : null}
            {order.payer_type && <span className="badge badge-info text-capitalize">Payer: {order.payer_type}</span>}
            {/* Settlement is shown separately from status: status says where the
                cargo is, this says where the money is. A delivered order with a
                balance owing is a real, valid state.

                An UNWEIGHED order has neither. It shows one badge saying so —
                not `Unpaid` next to `Settled`, which is what a ₱0 balance on an
                unpriced parcel used to render. Nothing is owed and nothing is
                collected because nothing has been billed. */}
            {settlementState === SETTLEMENT_STATE.UNPRICED ? (
              <span className="badge badge-warning">Not yet weighed — no price</span>
            ) : (
              <>
                {order.payment_status && <span className={`badge ${order.payment_status === 'paid' ? 'badge-success' : order.payment_status === 'partial' ? 'badge-warning' : 'badge-error'} text-capitalize`}>{order.payment_status}</span>}
                {settlementState === SETTLEMENT_STATE.SETTLED
                  ? <span className="badge badge-success">Settled</span>
                  : <span className="badge badge-error">{formatMoney(outstandingBalance(order))} Remaining Balance</span>}
              </>
            )}
            {order.promised_payment_date && <span className="badge badge-warning">Promised: {safeFormatDate(order.promised_payment_date)}</span>}
          </div>


          {order.notes && (
            <div className="mt-16 text-sm text-secondary">
              <strong>Notes:</strong> {order.notes}
            </div>
          )}

          {/* Payment History Table */}
          {paymentTransactions.length > 0 && (
            <div className="mt-24">
              <h4 className="fw-700 text-sm mb-12 flex items-center gap-8">
                <CreditCard size={14} /> Payment History
              </h4>
              {/* Standard admin table shell — `.table-container` + `.data-table`,
                  the same pair used by Orders, Customers, Trips and Activity
                  Logs. `admin-payment-table` remains only as a hook for the
                  receipt/reference cell, not for table chrome. */}
              <div className="table-container">
                <table className="data-table admin-payment-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Type</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Method</th>
                      <th scope="col">Status</th>
                      <th scope="col">Receipt/Ref</th>
                      <th scope="col">Recorded By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentTransactions.map(tx => {
                      const statusInfo = getPaymentStatusDisplay(tx.payment_status);
                      const isAuto = isSystemGenerated(tx);
                      return (
                        <tr key={tx.id}>
                          <td data-label="Date">
                            {tx.payment_date ? safeFormatDate(tx.payment_date) : safeFormatDate(tx.created_at)}
                            {!tx.payment_date && <span className="text-tertiary ml-4">{safeFormatTime(tx.created_at, {hour: '2-digit', minute:'2-digit'})}</span>}
                          </td>
                          <td data-label="Type">{tx.payment_type || 'Additional Payment'}</td>
                          <td data-label="Amount" className="fw-600 text-success">{formatMoney(parseFloat(tx.amount || 0))}</td>
                          <td data-label="Method">{formatPaymentMethod(tx.payment_method)}</td>
                          <td data-label="Status">
                            <span className={`badge badge-${statusInfo.tone} badge-sm`}>{statusInfo.label}</span>
                          </td>
                          <td data-label="Receipt/Ref" className="payment-ref-cell">
                            {tx.transaction_reference && (
                              <button
                                type="button"
                                className="payment-ref-copy-btn"
                                title={`Full ref: ${tx.transaction_reference}\nClick to copy`}
                                onClick={() => {
                                  navigator.clipboard.writeText(tx.transaction_reference);
                                  toast.success('Reference copied');
                                }}
                              >
                                <span className="text-xs">{truncateRef(tx.transaction_reference)}</span>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-50" style={{ flexShrink: 0,}}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                              </button>
                            )}
                            {tx.receipt_url && <a href={tx.receipt_url} target="_blank" rel="noreferrer" className="text-xs text-primary receipt-link"><Image size={12} /> View Receipt</a>}
                            {tx.notes && tx.notes.trim() && !(/captured via paymongo/i.test(tx.notes)) && (
                              <div className="text-xs text-tertiary mt-4" style={{ fontStyle: 'italic' }}>{tx.notes}</div>
                            )}
                          </td>
                          <td data-label="Recorded By">
                            {isAuto
                              ? <span className="badge badge-info badge-sm payment-auto-badge">{fmtRecordedBy(tx.admin_name, 'admin')}</span>
                              : <span>{tx.admin_name || 'System'}</span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {computedRemainingBalance > 0 && order.status !== 'Cancelled' && (
            <div className="mt-20 pt-16 border-t border-color flex justify-end">
              <button className="btn btn-primary btn-sm flex items-center gap-8" onClick={() => setShowPaymentModal(true)}>
                <CreditCard size={16} /> Record Additional Payment
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Timestamps */}
      <div className="flex justify-between mt-16 text-xs text-tertiary" style={{ padding: '0 4px' }}>
        <span>Created: {safeFormatDateTime(order.created_at)}</span>
        <span>Updated: {safeFormatDateTime(order.updated_at)}</span>
      </div>

      {/* Activity History */}
      {activityHistory.length > 0 && (
        <div className="card admin-section-card stagger-item mt-16" style={{ animationDelay: '480ms' }}>
          <div className="card-header">
            <h3><Clock size={16} className="inline mr-8" />Activity History</h3>
          </div>
          <div className="card-body" style={{ paddingTop: 8 }}>
            <div className="relative" style={{paddingLeft: 20}}>
              {/* Vertical line */}
              <div className="absolute" style={{left: 7, top: 8, bottom: 8, width: 2, background: 'var(--border)', borderRadius: 'var(--radius-full)'}} />
              {activityHistory.map((log) => (
                <div key={log.id} className="relative" style={{marginBottom: 16, paddingLeft: 20}}>
                  {/* Dot */}
                  <div className="absolute" style={{left: -13, top: 4, width: 10, height: 10,
                    borderRadius: '50%', background: 'var(--primary)', border: '2px solid var(--surface)',
                    boxShadow: '0 0 0 2px var(--primary)',
                  }} />
                  <div className="text-xs text-tertiary mb-2">
                    {safeFormatTime(log.created_at, { hour: '2-digit', minute: '2-digit' })}
                    {' · '}
                    {safeFormatDate(log.created_at, { month: 'short', day: 'numeric' })}
                  </div>
                  <div className="text-sm">
                    <strong>{log.admin_name}</strong>
                    {' '}
                    <span className="text-secondary">{log.action}</span>
                  </div>
                  {log.details && (
                    <div className="text-xs text-tertiary mt-2">{log.details}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Website Feature Section */}
      {order.status === 'Delivered' && (resolvedPickupPhotos.length > 0 || resolvedDeliveryPhotos.length > 0) && (
        <div className="card admin-section-card stagger-item mt-16" style={{ animationDelay: '520ms' }}>
          <div className="card-header">
            <h3><Star size={16} className="inline mr-8 text-warning" />Website Feature</h3>
          </div>
          <div className="card-body">
            <div className="form-group flex items-center gap-12 mb-16">
              <input
                type="checkbox"
                id="feature-website"
                checked={featureForm.featured_on_website}
                onChange={e => setFeatureForm({ ...featureForm, featured_on_website: e.target.checked })}
                className="w-18"
                style={{height: 18}}
              />
              <label htmlFor="feature-website" className="font-semibold text-lg cursor-pointer m-0">Feature this shipment on the website</label>
            </div>

            {featureForm.featured_on_website && (
              <div className="grid grid-2 gap-16 mt-16 p-16" style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}>
                <div className="form-group col-full">
                  <label className="form-label" htmlFor="order-featured-title">Highlight Title</label>
                  <input
                    id="order-featured-title"
                    type="text"
                    className="form-input"
                    placeholder="e.g. Bound for Jagna"
                    value={featureForm.featured_title}
                    onChange={e => setFeatureForm({ ...featureForm, featured_title: e.target.value })}
                  />
                </div>
                <div className="form-group col-full">
                  <label className="form-label" htmlFor="order-featured-caption">Caption</label>
                  <textarea
                    id="order-featured-caption"
                    className="form-textarea"
                    rows={2}
                    placeholder="Thank you for trusting Cargo Express PH..."
                    value={featureForm.featured_caption}
                    onChange={e => setFeatureForm({ ...featureForm, featured_caption: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="order-featured-image">Featured Image</label>
                  {/* CustomSelect for consistency with every other dropdown in
                      the admin UI; a native select opens the OS picker instead. */}
                  <CustomSelect
                    id="order-featured-image"
                    className="form-select"
                    value={featureForm.featured_image_type}
                    onChange={e => setFeatureForm({ ...featureForm, featured_image_type: e.target.value })}
                  >
                    {resolvedPickupPhotos.length > 0 && <option value="pickup">Use Pickup Proof</option>}
                    {resolvedDeliveryPhotos.length > 0 && <option value="delivery">Use Delivery Proof</option>}
                  </CustomSelect>
                </div>
                
                <div className="form-group flex justify-end col-full" style={{marginTop: 12}}>
                  <button className="btn btn-primary" onClick={handleSaveFeature} disabled={savingFeature}>
                    {savingFeature ? <Loader size={16} className="animate-spin" /> : <><Save size={16} /> Save Feature Settings</>}
                  </button>
                </div>
              </div>
            )}
            
            {!featureForm.featured_on_website && order.featured_on_website && (
               <div className="form-group flex justify-end" style={{ marginTop: 12 }}>
                 <button className="btn btn-primary" onClick={handleSaveFeature} disabled={savingFeature}>
                   {savingFeature ? <Loader size={16} className="animate-spin" /> : 'Save (Remove from Website)'}
                 </button>
               </div>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      {showPickupModal && (
        <PickupModal order={order} onClose={() => setShowPickupModal(false)} onSave={handlePickupSave} pricePerKilo={pickupPricePerKilo} />
      )}
      {showTripModal && (
        <TripAssignModal order={order} onClose={() => setShowTripModal(false)} onAssign={handleTripAssign} />
      )}
      {showReassignModal && (
        <TripReassignModal order={order} onClose={() => setShowReassignModal(false)} onReassign={handleTripReassign} />
      )}
      {showPaymentModal && (
        <AdditionalPaymentModal
          order={order}
          remainingBalance={computedRemainingBalance}
          onClose={() => setShowPaymentModal(false)}
          onSave={handleAdditionalPayment}
          onPaymentConfirmed={() => loadOrder()}
        />
      )}
      {showDeliveryModal && (
        <DeliveryModal order={order} onClose={() => setShowDeliveryModal(false)} onSave={handleDeliverySave} />
      )}
      {showCancelConfirm && (
        <ReasonModal
          isOpen={showCancelConfirm}
          onClose={() => setShowCancelConfirm(false)}
          onConfirm={handleCancel}
          loading={saving}
          title="Cancel Order"
          description="This cannot be undone. Your reason is saved on the booking, recorded in the activity log, and sent to the customer."
          label="Reason for Cancelling *"
          placeholder="e.g. Customer called to cancel; parcel was never dropped off."
          submitLabel="Cancel Order"
        />
      )}
      <ConfirmModal
        isOpen={showCleanupConfirm}
        onClose={() => setShowCleanupConfirm(false)}
        onConfirm={handleManualCleanup}
        title="Delete All Evidence Photos"
        message="Are you sure you want to permanently delete all photo evidence (pickup, delivery, receipts) for this order from storage? This action cannot be undone."
        confirmLabel="Delete Evidence"
        cancelLabel="Keep Photos"
        variant="danger"
        loading={saving}
      />
      {lightboxIndex >= 0 && lightboxImages.length > 0 && (
        <ImageLightbox images={lightboxImages} initialIndex={lightboxIndex} onClose={() => setLightboxIndex(-1)} />
      )}
      {showDeclineCancelModal && (
        <ReasonModal
          isOpen={showDeclineCancelModal}
          onClose={() => setShowDeclineCancelModal(false)}
          onConfirm={(notes) => handleReviewCancellation(false, notes)}
          loading={reviewingCancellation}
          title="Decline Cancellation Request"
          description={`This booking goes back to "${order.cancellation_previous_status || 'Pending'}" and keeps its trip slot. Your note is sent to the customer, so say why the request cannot be accommodated.`}
          label="Reason for Declining *"
          placeholder="e.g. The parcel is already loaded on today's manifest and departs in an hour."
          submitLabel="Decline Request"
        />
      )}
      <ConfirmModal
        isOpen={showApproveCancellationModal}
        onClose={() => setShowApproveCancellationModal(false)}
        onConfirm={() => handleReviewCancellation(true)}
        title="Approve Cancellation Request?"
        message={`Approve ${order.profiles?.name || 'the customer'}'s request to cancel ${order.tracking_number}? The order will be marked Cancelled and the customer will be notified. This cannot be undone.`}
        confirmLabel="Approve & Cancel Order"
        cancelLabel="Keep Order"
        variant="danger"
        loading={reviewingCancellation}
      />
      {showRejectModal && (
        <RejectModal
          isOpen={showRejectModal}
          onClose={() => setShowRejectModal(false)}
          onConfirm={(reason) => {
            handleRejectReview(reason);
            setShowRejectModal(false);
          }}
          loading={saving}
        />
      )}
    </div>
  );
};

/**
 * ReasonModal — a modal whose whole job is to make someone say WHY.
 *
 * Generalised out of the old out-of-coverage RejectModal when the cancellation
 * review needed the same thing. Both decisions land in the customer's
 * notification and in the activity log, and a decision recorded without its
 * reason is the case these screens exist to prevent.
 */
const ReasonModal = ({
  isOpen,
  onClose,
  onConfirm,
  loading,
  title,
  description,
  label,
  placeholder,
  submitLabel,
}) => {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError('Please enter a reason.');
      return;
    }
    onConfirm(reason.trim());
  };

  return (
    <FocusTrap active>
      <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="reason-modal-title">
        <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
          <div className="modal-header">
            <h3 id="reason-modal-title">{title}</h3>
            <button type="button" className="btn-icon btn-ghost" onClick={onClose} disabled={loading} aria-label="Close modal">
              <X size={20} />
            </button>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              {error && (
                <div className="br-8" style={{ color: 'var(--error-text)', background: 'var(--error-bg)', border: '1px solid var(--error)', padding: '8px 12px', fontSize: '0.875rem', marginBottom: 12}}>
                  {error}
                </div>
              )}
              <p className="text-secondary text-sm mb-16">{description}</p>
              <div className="form-group">
                <label className="form-label" htmlFor="reason-modal-input">{label}</label>
                <textarea
                  id="reason-modal-input"
                  className="form-textarea"
                  rows={4}
                  placeholder={placeholder}
                  value={reason}
                  onChange={e => { setReason(e.target.value); setError(''); }}
                  required
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>Cancel</button>
              <button type="submit" className="btn btn-danger" disabled={loading || !reason.trim()}>
                {loading ? <Loader size={16} className="animate-spin" /> : submitLabel}
              </button>
            </div>
          </form>
        </div>
      </div>
    </FocusTrap>
  );
};

const RejectModal = ({ isOpen, onClose, onConfirm, loading }) => (
  <ReasonModal
    isOpen={isOpen}
    onClose={onClose}
    onConfirm={onConfirm}
    loading={loading}
    title="Reject Pickup Request"
    description="Please provide the reason for rejecting this out-of-coverage pickup request. This will be sent as a notification to the customer."
    label="Rejection Reason *"
    placeholder="e.g. Location is outside our delivery zone and no driver is available."
    submitLabel="Reject Request"
  />
);

export default AdminOrderDetailPage;
