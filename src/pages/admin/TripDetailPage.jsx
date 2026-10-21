import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { rowLinkProps } from '../../utils/rowLink';
import { getTripById, getTripStartDateGates, listLoadingShortfalls, listBoxScanEvents, updateTrip, getActivityLogsByRecord, rescheduleTrip, retryTripReschedulePublicNotice } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import ConfirmModal from '../../components/ui/ConfirmModal';
import RescheduleTripModal from '../../components/ui/RescheduleTripModal';
import { CenteredSpinner } from '../../components/ui/Loader';
import { ArrowLeft, Play, Flag, CheckCircle, XCircle, Loader, Clock, ArrowRight, Package, AlertTriangle, Calendar, Pencil, ScanQrCode, CloudOff } from 'lucide-react';
import TripScannerModal from '../../components/ui/TripScannerModal';
import CapacityTracker from '../../components/ui/CapacityTracker';
import Breadcrumb from '../../components/ui/Breadcrumb';
import EmptyState from '../../components/ui/EmptyState';
import MessageCustomerButton from '../../components/ui/MessageCustomerButton';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import useLatestRequest from '../../hooks/useLatestRequest';
import { outstandingBalance, isOrderPriced } from '../../constants/status';
import { formatMoney } from '../../utils/currencyInput';
import { summarizeManualScans } from '../../utils/manualScanFlags';
import { MANUAL_SCAN_REASON_LABELS } from '../../constants/manualScan';
import { formatPhDate, formatPhDateTime, phLocalInputToISO } from '../../utils/datetime';
import { orderPartyName } from '../../lib/orderParties';

const TripDetailPage = () => {
  usePageTitle('Trip Details');
  const { id } = useParams(); const navigate = useNavigate();
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activityHistory, setActivityHistory] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [shortfalls, setShortfalls] = useState([]);
  const [scanEvents, setScanEvents] = useState([]);
  const [pendingRescheduleNotice, setPendingRescheduleNotice] = useState(null);
  const [retryingNotice, setRetryingNotice] = useState(false);
  const [estimatedArrivalInput, setEstimatedArrivalInput] = useState('');
  const [checkingStartGate, setCheckingStartGate] = useState(false);
  const toast = useToast();
  const beginRequest = useLatestRequest(id);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const handleOnline = () => { setIsOnline(true); void load({ silent: true }); };
    const handleOffline = () => { setIsOnline(false); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    setData(null);
    setActivityHistory([]);
    setShortfalls([]);
    setScanEvents([]);
    load();
  }, [id]);

  // Keep the displayed Manila-date gate current if an admin leaves this page
  // open across midnight or returns after the tab was backgrounded.
  useEffect(() => {
    if (data?.trip?.status !== 'scheduled') return undefined;
    let isMounted = true;
    const refreshGate = async () => {
      try {
        const gates = await getTripStartDateGates([id]);
        if (isMounted) setData((current) => current?.trip?.id === id ? { ...current, start_gate: gates[id] || null } : current);
      } catch {
        if (isMounted) setData((current) => current?.trip?.id === id ? { ...current, start_gate: null } : current);
      }
    };
    const onFocus = () => { refreshGate(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshGate(); };
    const interval = setInterval(refreshGate, 60_000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      isMounted = false;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [id, data?.trip?.status]);

  const load = async ({ silent = false } = {}) => {
    const isCurrent = beginRequest();
    if (!isCurrent()) return;
    if (!silent && !data) { setError(null); setLoading(true); }
    try {
      const result = await getTripById(id);
      if (!isCurrent()) return;
      setData(result);
      // Supervisor-approved loading shortfalls count as resolved boxes for the Start Trip gate.
      listLoadingShortfalls(id)
        .then((rows) => { if (isCurrent()) setShortfalls(rows); })
        .catch(() => { if (isCurrent()) setShortfalls([]); });
      // Verification audit trail (manual fallbacks are badged below); absent before the migration, so never fatal.
      listBoxScanEvents(id)
        .then((rows) => { if (isCurrent()) setScanEvents(rows); })
        .catch(() => { if (isCurrent()) setScanEvents([]); });
      try {
        const actLogs = await getActivityLogsByRecord(id, result?.trip?.trip_number);
        if (isCurrent()) setActivityHistory(actLogs);
      } catch {
        if (isCurrent()) setActivityHistory([]);
      }
    } catch(e) {
      if (isCurrent() && !silent) setError(e.message || 'Failed to load trip.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  // Live updates from scanners in the field; debounced so a burst of scans reloads once.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!id) return undefined;
    let timer = null;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void loadRef.current({ silent: true }); }, 700);
    };
    const channel = supabase
      .channel(`admin_trip_detail_${id}_${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `trip_id=eq.${id}` }, refresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${id}` }, refresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'box_scan_events', filter: `trip_id=eq.${id}` }, refresh)
      .subscribe();
    return () => { window.clearTimeout(timer); void supabase.removeChannel(channel); };
  }, [id]);

  const handleStatus = async (status) => {
    // Validations
    if (status === 'in_progress') {
      if (!orders || orders.length === 0) {
        toast.error('Cannot start trip because no bookings are assigned to this trip.');
        setConfirmAction(null);
        return;
      }
      // Checked before the pickup check: a Pending-Cancellation order needs a
      // decision, not a pickup, and starting the trip out from under it would
      // strand that order — the bulk sweep below only picks up orders that are
      // 'Picked Up', so it would never be swept into 'In Transit', and a later
      // decline would restore a status the trip already left without.
      const stuck = orders.find(o => o.status === 'Pending Cancellation');
      if (stuck) {
        toast.error(`Order ${stuck.tracking_number} has a cancellation request awaiting review. Approve or decline it before starting the trip.`);
        setConfirmAction(null);
        return;
      }
      const unpicked = orders.find(o => o.status === 'Pending' || o.status === 'Assigned');
      if (unpicked) {
        toast.error('All assigned orders must be picked up before the trip can start.');
        setConfirmAction(null);
        return;
      }
    }
    if (status === 'arrived' && data?.trip?.status !== 'in_progress') {
      toast.error('Trip must be in progress to mark as arrived.');
      setConfirmAction(null);
      return;
    }
    if (status === 'completed') {
      const undelivered = orders?.some(o => o.status !== 'Delivered' && o.status !== 'Cancelled');
      if (undelivered) {
        toast.error('All assigned orders must be delivered or cancelled before completing this trip.');
        setConfirmAction(null);
        return;
      }
      // A trip cannot be completed while any order still owes money. Mirrors
      // the guard_trip_completion trigger; the database is the authority.
      // Uses the shared derived balance so this check, the Unsettled tab and
      // the Sales totals cannot disagree about which orders still owe.
      const unsettled = (orders || []).filter(o => o.status !== 'Cancelled' && outstandingBalance(o) > 0);
      if (unsettled.length > 0) {
        toast.error(`${unsettled.length} order(s) still have an unpaid balance: ${unsettled.slice(0, 3).map(o => o.tracking_number).join(', ')}${unsettled.length > 3 ? '…' : ''}`);
        setConfirmAction(null);
        return;
      }
    }

    let updates = { status };
    if (status === 'in_progress' && estimatedArrivalInput) {
      const estimateISO = phLocalInputToISO(estimatedArrivalInput);
      if (!Number.isFinite(new Date(estimateISO).getTime())) {
        toast.error('Enter a valid estimated arrival time.');
        return;
      }
      // Do not compare against the device clock. The database validates this
      // against its own departure timestamp in the same status transaction.
      updates.estimated_arrival_at = estimateISO;
    }

    setSaving(true);
    try {
      const updatedTrip = await updateTrip(id, updates);
      if (updatedTrip) {
        setData((current) => current ? {
          ...current,
          trip: { ...current.trip, ...updatedTrip, ...updates },
        } : current);
      }
      setConfirmAction(null);
      await load({ silent: true });
      toast.success(`Trip updated to "${status}"`);
    } catch(e) {
      toast.error(e.message || 'Failed to update trip');
    } finally {
      setSaving(false);
      setConfirmAction(null);
    }
  };

  const openConfirm = (status, title, message, variant = 'warning') => {
    setConfirmAction({ status, title, message, variant });
  };

  const handleStartTripClick = async () => {
    setCheckingStartGate(true);
    try {
      const gates = await getTripStartDateGates([id]);
      const gate = gates[id] || null;
      setData((current) => current ? { ...current, start_gate: gate } : current);
      if (gate?.gate_state !== 'today') {
        toast.error(gate?.gate_state === 'overdue'
          ? 'This trip is overdue. Reschedule it before starting.'
          : gate?.gate_state === 'before_date'
            ? `This trip can be started on ${formatPhDate(gate.scheduled_day)} (Manila time).`
            : gate?.gate_state === 'not_scheduled'
              ? 'This trip is no longer scheduled. Refresh the page to see its current status.'
            : 'Could not verify a valid scheduled departure date. Refresh and try again.');
        return;
      }
      setEstimatedArrivalInput('');
      openConfirm('in_progress', 'Start Trip', `Start trip ${trip.trip_number}? This will mark it as in progress.`, 'info');
    } catch (error) {
      toast.error(error.message || 'Could not verify the scheduled departure date. Refresh and try again.');
    } finally {
      setCheckingStartGate(false);
    }
  };

  const handleCompleteClick = () => {
    const undelivered = orders.some(o => o.status !== 'Delivered' && o.status !== 'Cancelled');
    if (undelivered) {
      toast.error('All assigned orders must be delivered or cancelled before completing this trip.');
      return;
    }
    const unsettled = orders.filter(o => o.status !== 'Cancelled' && outstandingBalance(o) > 0);
    if (unsettled.length > 0) {
      toast.error(`Cannot complete: ${unsettled.length} order(s) still have an unpaid balance: ${unsettled.slice(0, 3).map(o => o.tracking_number).join(', ')}${unsettled.length > 3 ? '…' : ''}`);
      return;
    }
    openConfirm('completed', 'Complete Trip', `Complete trip ${trip.trip_number}? All orders have been delivered.`, 'success');
  };

  // The modal already ran the duplicate-route pre-check and built the ISO
  // strings; this just does the write, logs it, and refreshes. Errors are
  // caught here (not swallowed in the modal) so the toast fires and the
  // modal's own catch just keeps it open for another try.
  const handleReschedule = async ({ departure_date, arrival_date, notify_all_subscribers, public_reason, change_reason }) => {
    try {
      const result = await rescheduleTrip(id, {
        departure_date, arrival_date, notify_all_subscribers, public_reason, change_reason,
      }, { origin: trip.origin, destination: trip.destination });

      if (result?.trip) {
        setData((current) => current ? {
          ...current,
          trip: { ...current.trip, ...result.trip },
        } : current);
      }

      await load({ silent: true });

      if (!notify_all_subscribers || !result.scheduleChanged) {
        toast.success('Trip schedule updated.');
      } else if (result.emailQueued) {
        toast.success('Trip schedule updated. Subscriber email notification sent.');
        setPendingRescheduleNotice(null);
      } else {
        toast.error('Schedule updated. Email notification could not be completed.');
        setPendingRescheduleNotice({ announcementId: result.announcementId, error: result.emailError });
      }
      setShowRescheduleModal(false);
    } catch (e) {
      toast.error(e.message || 'Failed to update trip schedule.');
      throw e;
    }
  };

  const handleRetryRescheduleNotice = async () => {
    if (!pendingRescheduleNotice?.announcementId) return;
    setRetryingNotice(true);
    try {
      const result = await retryTripReschedulePublicNotice(pendingRescheduleNotice.announcementId);
      if (result?.state === 'completed') {
        toast.success('Subscriber email notification sent.');
        setPendingRescheduleNotice(null);
      } else if (result?.state === 'partial' || result?.state === 'busy') {
        toast.success(`Still sending: ${result.accepted ?? 0} accepted so far. Retry again to continue.`);
      } else {
        toast.error('Email notification still could not be completed. You can retry again.');
      }
    } catch (e) {
      toast.error(e.message || 'Retry failed. The schedule itself was not changed.');
    } finally {
      setRetryingNotice(false);
    }
  };

  if (loading) return <CenteredSpinner />;
  if (error) return (
    <div className="page-transition">
      <div className="card text-center" role="alert" style={{ padding: 40, color: 'var(--error-text)' }}>
        <h3>Error Loading Trip</h3>
        <p className="mt-8 mb-20">{error}</p>
        <button type="button" className="btn btn-primary" onClick={() => load()}>Retry</button>
      </div>
    </div>
  );
  if (!data) return <div className="empty-state"><h3>Trip not found</h3></div>;
  const { trip, orders, current_weight } = data;

  // ── Strict Start Trip gate ────────────────────────────────────────────────
  // The button itself is disabled by this, not just the click handler above —
  // a disabled control with a stated reason beats one that looks live and
  // then throws a toast. Cancellation requests are checked before pickup
  // status, since "awaiting review" is the more specific, more actionable
  // problem to name first.
  const pendingCancellationOrders = orders.filter(o => o.status === 'Pending Cancellation');
  const notYetPickedUp = orders.filter(o => o.status === 'Pending' || o.status === 'Assigned');
  const eligibleOrders = orders.filter(o => !['Cancelled', 'Pending Cancellation', 'Pending', 'Assigned'].includes(o.status));
  const undeliveredOrders = orders.filter(o => !['Delivered', 'Cancelled'].includes(o.status));
  const eligibleWeight = eligibleOrders.reduce((sum, o) => sum + (Number(o.actual_weight) || 0), 0);
  const heldBoxKeys = new Set(shortfalls.map(s => s.order_id + ':' + s.box_number));
  const unscannedBoxOrders = eligibleOrders.filter(o => {
    const verified = o.verified_boxes || [];
    return Array.from({ length: o.package_quantity || 1 }, (_, i) => i + 1)
      .some(b => !verified.includes(b) && !heldBoxKeys.has(o.id + ':' + b));
  });
  const totalTripBoxes = eligibleOrders.reduce((sum, o) => sum + (o.package_quantity || 1), 0);
  const totalScannedBoxes = eligibleOrders.reduce((sum, o) => {
    const qty = o.package_quantity || 1;
    return sum + (o.verified_boxes || []).filter(b => b <= qty).length;
  }, 0);
  const manualSummary = summarizeManualScans(scanEvents.filter(e => e.phase === 'load'), totalTripBoxes);
  const manualReasonsByOrder = scanEvents.reduce((acc, e) => {
    if (e.method === 'manual_fallback') {
      (acc[e.order_id] = acc[e.order_id] || []).push(`Box ${e.box_number}: ${MANUAL_SCAN_REASON_LABELS[e.reason] || e.reason}`);
    }
    return acc;
  }, {});
  const startGate = data.start_gate;

  const startTripBlockReason =
    !startGate
      ? 'Unable to verify the scheduled departure date. Reload this page before starting the trip.'
      : startGate.gate_state === 'before_date'
        ? `This trip is scheduled for ${formatPhDate(startGate.scheduled_day)}. It can be started on that Manila calendar date, or rescheduled first.`
        : startGate.gate_state === 'overdue'
          ? `This trip was scheduled for ${formatPhDate(startGate.scheduled_day)} and is overdue. Reschedule it to today or a future date before starting.`
          : startGate.gate_state === 'missing_date'
            ? 'This trip has no scheduled departure date. Add a valid date before starting.'
            : startGate.gate_state === 'not_scheduled'
              ? 'Trip status changed elsewhere. Refresh this page before continuing.'
            : pendingCancellationOrders.length > 0
              ? `${pendingCancellationOrders.length} order${pendingCancellationOrders.length === 1 ? '' : 's'} awaiting a cancellation decision: ${pendingCancellationOrders.slice(0, 3).map(o => o.tracking_number).join(', ')}${pendingCancellationOrders.length > 3 ? '…' : ''}. Approve or decline before starting.`
              : notYetPickedUp.length > 0
                ? `${notYetPickedUp.length} order${notYetPickedUp.length === 1 ? '' : 's'} not yet picked up: ${notYetPickedUp.slice(0, 3).map(o => o.tracking_number).join(', ')}${notYetPickedUp.length > 3 ? '…' : ''}.`
                : eligibleOrders.length === 0
                  ? 'Cannot start trip: no active shipments are ready for departure.'
                  : eligibleWeight <= 0
                    ? 'Cannot start trip: record pickup and actual cargo weight first.'
                    : unscannedBoxOrders.length > 0
                      ? `${unscannedBoxOrders.length} booking${unscannedBoxOrders.length === 1 ? '' : 's'} with unscanned package QR codes: ${unscannedBoxOrders.slice(0, 3).map(o => o.tracking_number).join(', ')}${unscannedBoxOrders.length > 3 ? '…' : ''}. Scan every box before starting.`
                      : null;
  const canStartTrip = !startTripBlockReason;
  // Once the trip has reached the hub, the planned estimate is outdated —
  // the recorded actual arrival replaces it.
  const hasArrived = Boolean(trip.arrived_at) || ['arrived', 'completed'].includes(trip.status);

  return (
    <div className="page-transition">
      <Breadcrumb items={[
        { label: 'Dashboard', to: '/admin' },
        { label: 'Trips', to: '/admin/trips' },
        { label: trip.trip_number },
      ]} />
      <div className="flex items-center justify-between mb-20">
        <div>
          <h1 className="fw-700">{trip.trip_number}</h1>
          <div className="flex items-center gap-8 mt-4 text-sm">
            <span className="fw-700 text-secondary">{trip.origin}</span>
            <span className="fw-700" style={{ color: 'var(--primary-text)' }}>➔</span>
            <span className="fw-700 text-secondary">{trip.destination}</span>
          </div>
        </div>
        <StatusBadge status={trip.status}/>
      </div>

      {/* Actions (Only render if there are actionable buttons) */}
      {/* Offline Mode Banner */}
      {(!isOnline || data?._fromCache) && (
        <div
          className="card admin-section-card mb-16"
          style={{
            background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            padding: '12px 16px',
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
          role="status"
        >
          <CloudOff size={18} style={{ color: '#EAB308', flexShrink: 0 }} aria-hidden="true" />
          <div style={{ fontSize: '0.875rem', lineHeight: '1.4' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Offline Mode (Local Cache):</strong>
            <span style={{ color: 'var(--text-secondary)', marginLeft: '6px' }}>
              Viewing trip offline. You can continue scanning packages and capturing delivery proofs. All scans and deliveries will sync automatically once reconnected.
            </span>
          </div>
        </div>
      )}
      {(['scheduled', 'in_progress', 'arrived'].includes(trip.status) || saving) && (
        <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '60ms'}}>
          <div className="card-body">
            <div className="admin-action-group">
            {trip.status==='scheduled' && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleStartTripClick}
                disabled={saving || checkingStartGate || !canStartTrip}
                title={startTripBlockReason || undefined}
              >
                {checkingStartGate ? <Loader size={16} className="animate-spin" /> : <Play size={16}/>} Start Trip
              </button>
            )}
            {trip.status==='scheduled' && eligibleOrders.length > 0 && (
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setShowScannerModal(true)}
                title="Scan physical QR labels to verify cargo loaded onto van"
              >
                <ScanQrCode size={16} /> Scan Cargo ({totalScannedBoxes}/{totalTripBoxes})
              </button>
            )}
            {trip.status==='in_progress' && <button type="button" className="btn btn-success" onClick={()=>openConfirm('arrived', 'Mark Arrived', `Mark trip ${trip.trip_number} as arrived at destination?`, 'success')} disabled={saving}><Flag size={16}/> Mark Arrived</button>}
            {trip.status==='arrived' && <button type="button" className="btn btn-primary" onClick={handleCompleteClick} disabled={saving}><CheckCircle size={16}/> Complete</button>}
            {trip.status==='scheduled' && <button type="button" className="btn btn-danger-outline btn-sm" onClick={()=>openConfirm('cancelled', 'Cancel Trip', `Cancel trip ${trip.trip_number}? This action cannot be undone.`, 'danger')} disabled={saving}><XCircle size={16}/> Cancel Trip</button>}
            {saving && <Loader size={18} className="animate-spin"/>}
            </div>
            {/* A disabled button alone doesn't explain itself — especially on
                touch, where there's no hover to reveal the title tooltip. */}
            {trip.status==='scheduled' && startTripBlockReason && (
              <div className="text-xs text-tertiary mt-8 flex items-center gap-6">
                <AlertTriangle size={12} aria-hidden="true" /> {startTripBlockReason}
              </div>
            )}
            {trip.status==='arrived' && undeliveredOrders.length > 0 && (
              <div className="text-xs text-tertiary mt-8 flex items-center gap-6">
                <AlertTriangle size={12} aria-hidden="true" />
                {`${undeliveredOrders.length} booking${undeliveredOrders.length === 1 ? '' : 's'} remaining. Open each booking below, scan and load all boxes onto the delivery van, then advance to "Out for Delivery".`}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Schedule */}
      <div className="card admin-section-card stagger-item mb-16" style={{ animationDelay: '90ms'}}>
        <div className="card-body">
          <div className="flex items-center justify-between flex-wrap gap-8 mb-12">
            <h3 className="fw-700 flex items-center gap-8" style={{ margin: 0 }}>
              <Calendar size={18} color="var(--primary)" aria-hidden="true" /> Schedule
            </h3>
            {/* Once a trip has started, its departure has already happened —
                there is nothing left to reschedule. */}
            {trip.status === 'scheduled' && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setShowRescheduleModal(true)}
              >
                <Pencil size={14} aria-hidden="true" /> Reschedule
              </button>
            )}
          </div>
          <div className="text-xs text-tertiary mb-12">Times shown below use Manila time.</div>
          {pendingRescheduleNotice && (
            <div className="alert-banner alert-banner-warning mb-12" role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span>
                Schedule updated, but the subscriber email notification could not be completed
                {pendingRescheduleNotice.error ? `: ${pendingRescheduleNotice.error}` : '.'}
              </span>
              {pendingRescheduleNotice.announcementId && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={handleRetryRescheduleNotice}
                  disabled={retryingNotice}
                >
                  {retryingNotice ? <Loader size={14} className="animate-spin" /> : null} Retry email notification
                </button>
              )}
            </div>
          )}
          <div className="trip-schedule-grid">
            <div className="trip-schedule-item">
              <div className="text-xs text-tertiary">Scheduled Departure</div>
              <div className="fw-700">{formatPhDate(trip.departure_date)}</div>
            </div>
            <div className="trip-schedule-item">
              <div className="text-xs text-tertiary">Planned Shipment Arrival Date</div>
              <div className="fw-700">{trip.arrival_date ? formatPhDate(trip.arrival_date) : 'Not set'}</div>
            </div>
            {(trip.departure_at || trip.estimated_arrival_at || trip.arrived_at) && (
              <>
                <div className="trip-schedule-divider" aria-hidden="true" />
                <div className="trip-schedule-item">
                  <div className="text-xs text-tertiary">Actual Departure</div>
                  <div className="fw-700">{trip.departure_at ? formatPhDateTime(trip.departure_at) : '—'}</div>
                </div>
                <div className="trip-schedule-item">
                  <div className="text-xs text-tertiary">
                    {hasArrived ? 'Actual Arrival at Destination Hub' : 'Estimated Arrival at Destination Hub'}
                  </div>
                  <div className="fw-700">
                    {hasArrived
                      ? (trip.arrived_at ? formatPhDateTime(trip.arrived_at) : 'Not arrived')
                      : (trip.estimated_arrival_at ? formatPhDateTime(trip.estimated_arrival_at) : 'To be confirmed')}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>


      {/* Capacity */}
      <div className="card admin-section-card stagger-item mb-16" style={{ animationDelay: '150ms'}}>
        <div className="card-body">
          <CapacityTracker currentWeight={current_weight} maxCapacity={trip.capacity} tripNumber={trip.trip_number} />
        </div>
      </div>

      {/* Internal Notes */}
      {trip.notes && (
        <div className="card admin-section-card stagger-item mb-16" style={{ animationDelay: '160ms'}}>
          <div className="card-body">
            <h4 className="fw-700 mb-8" style={{ fontSize: 'var(--text-13)', color: 'var(--text-tertiary)' }}>Internal Trip Notes</h4>
            <p className="m-0 text-sm" style={{ whiteSpace: 'pre-wrap' }}>{trip.notes}</p>
          </div>
        </div>
      )}

      {/* Orders */}
      <div className="card admin-section-card admin-table-card stagger-item" style={{ animationDelay: '180ms' }}>
        <div className="card-header flex items-center justify-between flex-wrap gap-8">
          <h3>Assigned Orders ({orders.length})</h3>
          <div className="flex items-center gap-10 flex-wrap">
            {eligibleOrders.length > 0 ? (
              <span className="text-xs text-secondary">
                Manifest: <strong>{totalScannedBoxes}</strong> of <strong>{totalTripBoxes}</strong> boxes scanned {totalScannedBoxes === totalTripBoxes ? '✓' : ''}
                {manualSummary.manualCount > 0 && (
                  <> · <strong>{manualSummary.manualCount}</strong> verified manually</>
                )}
              </span>
            ) : notYetPickedUp.length > 0 ? (
              <span className="text-xs text-secondary">
                {notYetPickedUp.length} booking{notYetPickedUp.length === 1 ? '' : 's'} awaiting pickup before loading
              </span>
            ) : null}
          </div>
        </div>
        {manualSummary.flags.length > 0 && (
          <div className="trip-scanner-notice trip-scanner-notice-warning" role="status" style={{ margin: '12px 16px 0' }}>
            <AlertTriangle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />
            <span>Worth a look: {manualSummary.flags.map(f => f.message).join(' ')}</span>
          </div>
        )}
        <div className="table-container">
          {orders.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No Assigned Bookings"
              description="No bookings have been assigned to this trip yet."
            />
          ) : (
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th scope="col">Tracking</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Route</th>
                  <th scope="col">Weight</th>
                  <th scope="col">Boxes</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Message</span></th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} {...rowLinkProps(navigate, `/admin/orders/${o.id}`)}>
                    {/* The whole row opens the booking; the tracking number
                        is the keyboard / new-tab link. */}
                    <td data-label="Tracking"><Link to={`/admin/orders/${o.id}`} className="fw-700 text-accent">{o.tracking_number}</Link></td>
                    <td data-label="Customer">{o.profiles?.name || orderPartyName(o, 'sender') || '—'}</td>
                    <td data-label="Route" className="text-sm">
                      {[o.sender_city, o.sender_province].filter(Boolean).join(', ') || '—'}
                      {' → '}
                      {[o.receiver_city, o.receiver_province].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td data-label="Weight">{o.actual_weight ? `${o.actual_weight} kg` : '—'}</td>
                    <td data-label="Boxes">
                      {(() => {
                        const qty = o.package_quantity || 1;
                        const verified = (o.verified_boxes || []).filter(b => b <= qty);
                        const isEligible = !['Cancelled', 'Pending Cancellation', 'Pending', 'Assigned'].includes(o.status);
                        if (!isEligible) {
                          return <span className="text-secondary text-xs">{qty} box{qty > 1 ? 'es' : ''}</span>;
                        }
                        const allScanned = verified.length === qty;
                        const manualNotes = manualReasonsByOrder[o.id];
                        return (
                          <>
                          <span
                            className={`badge ${allScanned ? 'badge-success' : 'badge-warning'} text-xs`}
                            title={allScanned ? `All ${qty} boxes scanned` : `${verified.length} of ${qty} boxes scanned`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            {allScanned ? (
                              <>
                                <CheckCircle size={11} aria-hidden="true" /> {qty}/{qty}
                              </>
                            ) : (
                              <>
                                <AlertTriangle size={11} aria-hidden="true" /> {verified.length}/{qty}
                              </>
                            )}
                          </span>
                          {manualNotes && (
                            <span
                              className="badge badge-warning text-xs"
                              style={{ marginLeft: 6 }}
                              title={'Verified without a camera scan. ' + manualNotes.join('; ')}
                            >
                              Manual ×{manualNotes.length}
                            </span>
                          )}
                          </>
                        );
                      })()}
                    </td>
                    <td data-label="Cost" className="fw-600">{isOrderPriced(o) ? formatMoney(parseFloat(o.shipping_cost || 0)) : '—'}</td>
                    <td data-label="Status">
                      <StatusBadge status={o.status} size="sm" />
                    </td>
                    <td data-label="Action">
                      <MessageCustomerButton
                        customerId={o.user_id}
                        customerName={o.profiles?.name}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Trip Activity */}
      {activityHistory.length > 0 && (
        <div className="card admin-section-card stagger-item mt-16" style={{ animationDelay: '240ms' }}>
          <div className="card-header">
            <h3><Clock size={16} className="inline mr-8" />Trip Activity</h3>
          </div>
          <div className="card-body" style={{ paddingTop: 8 }}>
            <div className="relative" style={{paddingLeft: 20}}>
              <div className="absolute" style={{left: 7, top: 8, bottom: 8, width: 2, background: 'var(--border)', borderRadius: 'var(--radius-full)'}} />
              {activityHistory.map((log) => (
                <div key={log.id} className="relative" style={{marginBottom: 16, paddingLeft: 20}}>
                  <div className="absolute" style={{left: -13, top: 4, width: 10, height: 10,
                    borderRadius: '50%', background: 'var(--primary)', border: '2px solid var(--surface)',
                    boxShadow: '0 0 0 2px var(--primary)',
                  }} />
                  <div className="text-xs text-tertiary mb-2">
                    {formatPhDateTime(log.created_at)}
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

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => confirmAction && handleStatus(confirmAction.status)}
        title={confirmAction?.title || ''}
        message={confirmAction?.message || ''}
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        variant={confirmAction?.variant || 'warning'}
        loading={saving}
      >
        {confirmAction?.status === 'in_progress' && (
          <div className="form-group" style={{ textAlign: 'left', marginTop: -8 }}>
            <label className="form-label" htmlFor="trip-estimated-arrival-at-hub">Estimated arrival at destination hub (optional)</label>
            <input
              id="trip-estimated-arrival-at-hub"
              type="datetime-local"
              className="form-input"
              value={estimatedArrivalInput}
              onChange={(event) => setEstimatedArrivalInput(event.target.value)}
              disabled={saving}
              aria-describedby="trip-estimated-arrival-help"
            />
            <small id="trip-estimated-arrival-help" className="text-xs text-tertiary">
              Manila time. This is only an estimate; leave blank if unknown. The existing planned shipment-arrival date is unchanged.
            </small>
          </div>
        )}
      </ConfirmModal>

      {/* Reschedule Modal */}
      {showRescheduleModal && (
        <RescheduleTripModal
          trip={trip}
          serverToday={startGate?.ph_today}
          onClose={() => setShowRescheduleModal(false)}
          onReschedule={handleReschedule}
        />
      )}

      {/* Dedicated Trip Cargo & Delivery Continuous Scanner */}
      {showScannerModal && (
        <TripScannerModal
          trip={trip}
          orders={orders}
          onOrdersUpdate={(updatedOrders) => {
            setData((prev) => (prev ? { ...prev, orders: updatedOrders } : prev));
          }}
          onClose={() => {
            setShowScannerModal(false);
            void load({ silent: true });
          }}
        />
      )}
    </div>
  );
};
export default TripDetailPage;
