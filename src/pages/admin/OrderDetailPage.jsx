import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getOrderById, updateOrder, createNotification, getTripReassignments, reassignTrip, getActivityLogsByRecord, getPaymentTransactions, recordPaymentTransaction, recordAdditionalPayment } from '../../lib/database';
import { logOrder, logPayment } from '../../lib/activityLog';
import { deriveStatusTimestamps } from '../../utils/statusTimestamps';
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
import {
  STATUS_FLOW, STATUS_TIMELINE, validateStatusTransition,
  PAYMENT_METHODS, PAYMENT_STATUSES, ORDER_STATUS
} from '../../constants/status';
import {
  ArrowLeft, Check, Package, CreditCard, User, Phone, MapPin,
  Truck, Loader, Save, Camera, AlertTriangle, X, Image, Clock, Trash2, Star
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';

const safeFormatDate = (dateStr, options) => {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', options);
  } catch {
    try {
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
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
    return d.toLocaleTimeString('en-US', options);
  } catch {
    try {
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
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
    return d.toLocaleString('en-US');
  } catch {
    try {
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? '—' : d.toLocaleString();
    } catch {
      return '—';
    }
  }
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
  const [tripHistory, setTripHistory] = useState([]);
  const [activityHistory, setActivityHistory] = useState([]);
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

  // Per-step timestamps for tracking timeline
  const stepTimestamps = useMemo(
    () => deriveStatusTimestamps(activityHistory, order?.created_at, order?.status),
    [activityHistory, order?.created_at, order?.status]
  );

  useEffect(() => {
    let isMounted = true;
    loadOrder(isMounted);
    return () => { isMounted = false; };
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
    const validation = validateStatusTransition(order.status, next, order.trip_id);
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
      // Clean up internal flags before state updates
      const cleanData = { ...pickupData };
      delete cleanData.skipPaymentInsert;

      await updateOrder(id, cleanData);

      // Also automatically record the payment transaction if money was collected and insert wasn't skipped
      if (pickupData.amount_paid && pickupData.amount_paid > 0 && !pickupData.skipPaymentInsert) {
        await recordPaymentTransaction(id, pickupData.amount_paid, pickupData.payment_method, pickupData.payment_reference || null, pickupData.payment_status, 'Initial pickup payment', 'Initial Payment', pickupData.payment_date, pickupData.receipt_url);
      }
      
      logOrder('Pickup Processed', id, order.tracking_number, { details: `Pickup processed. Weight: ${cleanData.actual_weight}kg, Payment: ${cleanData.payment_method}, Amount: ₱${cleanData.amount_paid}` });

      await createNotification(order.user_id, 'Pickup Complete', `Order ${order.tracking_number} has been picked up`, 'order_update', order.id);
      setShowPickupModal(false);
      await loadOrder();
      toast.success('Pickup processed successfully!');
    } catch (e) { throw e; }
  };

  const handleDeliverySave = async (deliveryData) => {
    try {
      await updateOrder(id, deliveryData);
      
      if (deliveryData.amount_paid && deliveryData.amount_paid > 0) {
        await recordPaymentTransaction(id, deliveryData.amount_paid, deliveryData.payment_method, deliveryData.payment_reference || null, deliveryData.payment_status, 'Balance settlement upon delivery', 'Balance Settlement', deliveryData.payment_date, deliveryData.receipt_url);
      }

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

  const handleCancel = async () => {
    try {
      await updateOrder(id, { status: 'Cancelled' });
      logOrder('Order Cancelled', id, order.tracking_number, { previousValue: { status: order.status }, newValue: { status: 'Cancelled' } });
      await createNotification(order.user_id, 'Order Cancelled', `Order ${order.tracking_number} has been cancelled`, 'order_update', order.id);
      setShowCancelConfirm(false);
      await loadOrder();
      toast.success('Order cancelled.');
    } catch (e) { throw e; }
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
        const { error: txError } = await supabase
          .from('payment_transactions')
          .update({ receipt_url: null })
          .eq('order_id', id);
        if (txError) throw txError;
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
  const needsTrip = order.status === 'Pending' && !order.trip_id;
  const hasPhotos = resolvedPickupPhotos.length > 0;
  const canReassignTrip = order.trip_id && [ORDER_STATUS.PENDING, ORDER_STATUS.ASSIGNED].includes(order.status);

  const ratePerKg = parseFloat(order.trips?.price_per_kg || 0) > 0
    ? parseFloat(order.trips.price_per_kg)
    : parseFloat(order.package_weight || 0) > 0
      ? parseFloat(order.shipping_cost || 0) / parseFloat(order.package_weight)
      : 70;

  const currentWeight = parseFloat(order.actual_weight) || parseFloat(order.package_weight) || 0;
  const computedShippingCost = currentWeight * ratePerKg;
  const computedAmountPaid = parseFloat(order.amount_paid || 0);
  const computedRemainingBalance = computedShippingCost - computedAmountPaid;
  const isOverpaid = computedRemainingBalance < 0;
  const pickupPricePerKilo = ratePerKg;

  const estimatedWeight = parseFloat(order.package_weight) || 0;
  const actualWeightVal = parseFloat(order.actual_weight) || 0;
  const showsWeightWarning = estimatedWeight > 0 && actualWeightVal > 0 &&
    (actualWeightVal > estimatedWeight * 2 || actualWeightVal < estimatedWeight * 0.25);



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
                <AlertTriangle size={14} /> Outstanding Balance: ₱{computedRemainingBalance.toFixed(2)}
              </span>
            )}
        </div>
      </div>
      <div className="flex items-center gap-8 text-sm mb-20 flex-wrap">
        <span className="fw-800 text-secondary">{order.origin}</span>
        <span className="fw-700" style={{ color: 'var(--primary)' }}>➔</span>
        <span className="fw-800 text-secondary">{order.destination}</span>
        <span className="text-secondary opacity-50">•</span>
        <span className="text-secondary">{order.profiles?.name}</span>
      </div>

      {/* Out of Coverage Review Action Bar */}
      {order.service_area_status === 'for_review' && (
        <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '60ms', borderColor: 'var(--warning)', background: 'var(--warning-bg)' }}>
          <div className="card-body">
            <h3 className="flex items-center gap-8 mb-12" style={{ color: 'var(--warning-dark)' }}>
              <AlertTriangle size={20} /> Out of Coverage Pickup Review
            </h3>
            <p className="text-sm mb-16" style={{ color: 'var(--warning-dark)' }}>
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
                navigate('/admin/inbox', { state: { contactUserId: order.user_id } });
              }}>
                <Phone size={16} /> Contact Customer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status Action Bar */}
      {(!isTerminal && order.service_area_status !== 'for_review') && (
        <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '60ms' }}>
          <div className="card-body">
            <div className="admin-action-group">
            {needsTrip && (
              <button type="button" className="btn btn-secondary" onClick={() => setShowTripModal(true)}>
                <Truck size={16} /> Assign to Trip
              </button>
            )}
            {nextStatus && !(order.status === 'Picked Up' && nextStatus === 'In Transit') && (
              <button type="button" className="btn btn-primary" onClick={handleStatusAdvance} disabled={saving}>
                {saving ? <Loader size={16} className="animate-spin" /> : <Check size={16} />}
                {nextStatus === 'Picked Up' ? 'Process Pickup' : `Advance to "${nextStatus}"`}
              </button>
            )}
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setShowCancelConfirm(true)} disabled={saving}>
              Cancel Order
            </button>
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
        <div className="alert-banner alert-banner-error" style={{ background: 'var(--warning-bg)', color: 'var(--warning-dark)', borderColor: 'var(--warning)' }}>
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
        <div className="card-body"><TrackingTimeline currentStatus={order.status} compact stepTimestamps={stepTimestamps} /></div>
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
              <div className="mt-16 pt-16" style={{ borderTop: '1px solid var(--border)' }}>
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
            <div><div className="text-xs text-tertiary" style={{ marginBottom: 2 }}>Est. Weight</div><div className="text-sm font-bold">{order.package_weight || '—'} kg</div></div>
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
              <div className="text-lg fw-800 text-primary">₱{computedShippingCost.toFixed(2)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-tertiary" style={{ marginBottom: 2 }}>Amount Paid</div>
              <div className="text-lg fw-800 text-success">₱{computedAmountPaid.toFixed(2)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-tertiary" style={{ marginBottom: 2 }}>{isOverpaid ? 'Overpaid' : 'Balance'}</div>
              <div className={`text-lg fw-800 ${isOverpaid ? 'text-warning' : computedRemainingBalance > 0 ? 'text-error' : 'text-success'}`}>
                {isOverpaid ? `+₱${Math.abs(computedRemainingBalance).toFixed(2)}` : `₱${computedRemainingBalance.toFixed(2)}`}
              </div>
            </div>
          </div>

          <div className="flex gap-8 flex-wrap mb-16">
            {order.payment_method && <span className="badge badge-info text-capitalize">{order.payment_method === 'gcash' ? 'GCash' : order.payment_method === 'paylater' ? 'Pay Later' : 'Cash'}</span>}
            {order.payer_type && <span className="badge badge-info text-capitalize">Payer: {order.payer_type}</span>}
            {order.payment_status && <span className={`badge ${order.payment_status === 'paid' ? 'badge-success' : order.payment_status === 'partial' ? 'badge-warning' : 'badge-error'} text-capitalize`}>{order.payment_status}</span>}
            {order.promised_payment_date && <span className="badge badge-warning">Due: {safeFormatDate(order.promised_payment_date)}</span>}
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
              <div className="table-responsive admin-payment-table-wrap">
                <table className="table admin-payment-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Method</th>
                      <th>Receipt/Ref</th>
                      <th>Admin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentTransactions.map(tx => (
                      <tr key={tx.id}>
                        <td data-label="Date">
                          {tx.payment_date ? safeFormatDate(tx.payment_date) : safeFormatDate(tx.created_at)}
                          {!tx.payment_date && <span className="text-tertiary ml-4">{safeFormatTime(tx.created_at, {hour: '2-digit', minute:'2-digit'})}</span>}
                        </td>
                        <td data-label="Type">{tx.payment_type || 'Additional Payment'}</td>
                        <td data-label="Amount" className="fw-600 text-success">₱{parseFloat(tx.amount || 0).toFixed(2)}</td>
                        <td data-label="Method" className="text-capitalize">{tx.payment_method === 'gcash' ? 'GCash' : tx.payment_method}</td>
                        <td data-label="Receipt/Ref" className="payment-ref-cell">
                          {tx.transaction_reference && <div className="text-xs">Ref: {tx.transaction_reference}</div>}
                          {tx.receipt_url && <a href={tx.receipt_url} target="_blank" rel="noreferrer" className="text-xs text-primary receipt-link"><Image size={12} /> View Receipt</a>}
                          {tx.notes && <div className="text-xs text-tertiary mt-4">{tx.notes}</div>}
                        </td>
                        <td data-label="Admin">{tx.admin_name || 'System'}</td>
                      </tr>
                    ))}
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
            <div style={{ position: 'relative', paddingLeft: 20 }}>
              {/* Vertical line */}
              <div style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 2, background: 'var(--border)', borderRadius: 2 }} />
              {activityHistory.map((log) => (
                <div key={log.id} style={{ position: 'relative', marginBottom: 16, paddingLeft: 20 }}>
                  {/* Dot */}
                  <div style={{
                    position: 'absolute', left: -13, top: 4, width: 10, height: 10,
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
      {(order.status === 'Completed' || order.status === 'Delivered') && (resolvedPickupPhotos.length > 0 || resolvedDeliveryPhotos.length > 0) && (
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
                style={{ width: 18, height: 18 }}
              />
              <label htmlFor="feature-website" className="font-semibold text-lg cursor-pointer m-0">Feature this shipment on the website</label>
            </div>

            {featureForm.featured_on_website && (
              <div className="grid grid-2 gap-16 mt-16 p-16" style={{ background: 'var(--bg-secondary)', borderRadius: 12 }}>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Highlight Title</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. Bound for Jagna"
                    value={featureForm.featured_title}
                    onChange={e => setFeatureForm({ ...featureForm, featured_title: e.target.value })}
                  />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Caption</label>
                  <textarea
                    className="form-textarea"
                    rows={2}
                    placeholder="Thank you for trusting CargoExpress PH..."
                    value={featureForm.featured_caption}
                    onChange={e => setFeatureForm({ ...featureForm, featured_caption: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Featured Image</label>
                  <select
                    className="form-select"
                    value={featureForm.featured_image_type}
                    onChange={e => setFeatureForm({ ...featureForm, featured_image_type: e.target.value })}
                  >
                    {resolvedPickupPhotos.length > 0 && <option value="pickup">Use Pickup Proof</option>}
                    {resolvedDeliveryPhotos.length > 0 && <option value="delivery">Use Delivery Proof</option>}
                  </select>
                </div>
                
                <div className="form-group" style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={handleSaveFeature} disabled={savingFeature}>
                    {savingFeature ? <Loader size={16} className="animate-spin" /> : <><Save size={16} /> Save Feature Settings</>}
                  </button>
                </div>
              </div>
            )}
            
            {!featureForm.featured_on_website && order.featured_on_website && (
               <div className="form-group" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
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
        <AdditionalPaymentModal order={order} remainingBalance={computedRemainingBalance} onClose={() => setShowPaymentModal(false)} onSave={handleAdditionalPayment} />
      )}
      {showDeliveryModal && (
        <DeliveryModal order={order} onClose={() => setShowDeliveryModal(false)} onSave={handleDeliverySave} />
      )}
      <ConfirmModal
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={handleCancel}
        title="Cancel Order"
        message="Are you sure you want to cancel this order? This action cannot be undone."
        confirmLabel="Cancel Order"
        cancelLabel="Keep Order"
        variant="danger"
        loading={saving}
      />
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

const RejectModal = ({ isOpen, onClose, onConfirm, loading }) => {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError('Please enter a rejection reason.');
      return;
    }
    onConfirm(reason.trim());
  };

  return (
    <FocusTrap active>
      <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
        <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
          <div className="modal-header">
            <h3>Reject Pickup Request</h3>
            <button type="button" className="btn-icon btn-ghost" onClick={onClose} disabled={loading} aria-label="Close modal">
              <X size={20} />
            </button>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              {error && (
                <div style={{ color: 'var(--error)', background: 'var(--error-bg)', border: '1px solid var(--error)', padding: '8px 12px', borderRadius: 8, fontSize: '0.875rem', marginBottom: 12 }}>
                  {error}
                </div>
              )}
              <p className="text-secondary text-sm mb-16">
                Please provide the reason for rejecting this out-of-coverage pickup request. This will be sent as a notification to the customer.
              </p>
              <div className="form-group">
                <label className="form-label" htmlFor="reject-reason">Rejection Reason *</label>
                <textarea
                  id="reject-reason"
                  className="form-textarea"
                  rows={4}
                  placeholder="e.g. Location is outside our delivery zone and no driver is available."
                  value={reason}
                  onChange={e => { setReason(e.target.value); setError(''); }}
                  required
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>Cancel</button>
              <button type="submit" className="btn btn-danger" disabled={loading || !reason.trim()}>
                {loading ? <Loader size={16} className="animate-spin" /> : 'Reject Request'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </FocusTrap>
  );
};

export default AdminOrderDetailPage;
