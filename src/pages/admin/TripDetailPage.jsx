import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { rowLinkProps } from '../../utils/rowLink';
import { getTripById, getTripStartDateGates, updateTrip, getActivityLogsByRecord, rescheduleTrip, retryTripReschedulePublicNotice } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import ConfirmModal from '../../components/ui/ConfirmModal';
import RescheduleTripModal from '../../components/ui/RescheduleTripModal';
import { CenteredSpinner } from '../../components/ui/Loader';
import { ArrowLeft, Play, Flag, CheckCircle, XCircle, Loader, Clock, ArrowRight, Package, AlertTriangle, Calendar, Pencil } from 'lucide-react';
import CapacityTracker from '../../components/ui/CapacityTracker';
import Breadcrumb from '../../components/ui/Breadcrumb';
import EmptyState from '../../components/ui/EmptyState';
import MessageCustomerButton from '../../components/ui/MessageCustomerButton';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { outstandingBalance } from '../../constants/status';
import { formatPhDate, formatPhDateTime, phLocalInputToISO } from '../../utils/datetime';

const TripDetailPage = () => {
  usePageTitle('Trip Details');
  const { id } = useParams(); const navigate = useNavigate();
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activityHistory, setActivityHistory] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [pendingRescheduleNotice, setPendingRescheduleNotice] = useState(null);
  const [retryingNotice, setRetryingNotice] = useState(false);
  const [estimatedArrivalInput, setEstimatedArrivalInput] = useState('');
  const [checkingStartGate, setCheckingStartGate] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let isMounted = true;
    load(isMounted);
    return () => { isMounted = false; };
  }, [id]);

  // Keep the displayed Manila-date gate current if an admin leaves this page
  // open across midnight or returns after the tab was backgrounded.
  useEffect(() => {
    if (data?.trip?.status !== 'scheduled') return undefined;
    let isMounted = true;
    const refreshGate = async () => {
      try {
        const gates = await getTripStartDateGates([id]);
        if (isMounted) setData((current) => current ? { ...current, start_gate: gates[id] || null } : current);
      } catch {
        if (isMounted) setData((current) => current ? { ...current, start_gate: null } : current);
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

  const load = async (isMounted = true) => {
    setError(null); setLoading(true);
    try {
      const result = await getTripById(id);
      if (isMounted) setData(result);
      const actLogs = await getActivityLogsByRecord(id, result?.trip?.trip_number);
      if (isMounted) setActivityHistory(actLogs);
    } catch(e) {
      if (isMounted) setError(e.message || 'Failed to load trip.');
    } finally {
      if (isMounted) setLoading(false);
    }
  };

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
      await updateTrip(id, updates);

      await load();
      toast.success(`Trip updated to "${status}"`);
    } catch(e) {
      toast.error(e.message || 'Failed to update trip');
    } finally {
      setSaving(false); setConfirmAction(null);
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

      await load();

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
  const eligibleWeight = eligibleOrders.reduce((sum, o) => sum + (Number(o.actual_weight) || 0), 0);
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
                    : null;
  const canStartTrip = !startTripBlockReason;

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

      {/* Actions */}
      <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '60ms'}}><div className="card-body">
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
        {trip.status==='in_progress' && <button type="button" className="btn btn-success" onClick={()=>openConfirm('arrived', 'Mark Arrived', `Mark trip ${trip.trip_number} as arrived at destination?`, 'success')} disabled={saving}><Flag size={16}/> Mark Arrived</button>}
        {trip.status==='arrived' && <button type="button" className="btn btn-primary" onClick={handleCompleteClick} disabled={saving}><CheckCircle size={16}/> Complete</button>}
        {!['completed','cancelled'].includes(trip.status) && <button type="button" className="btn btn-danger-outline btn-sm" onClick={()=>openConfirm('cancelled', 'Cancel Trip', `Cancel trip ${trip.trip_number}? This action cannot be undone.`, 'danger')} disabled={saving}><XCircle size={16}/> Cancel Trip</button>}
        {saving && <Loader size={18} className="animate-spin"/>}
        </div>
        {/* A disabled button alone doesn't explain itself — especially on
            touch, where there's no hover to reveal the title tooltip. */}
        {trip.status==='scheduled' && startTripBlockReason && (
          <div className="text-xs text-tertiary mt-8 flex items-center gap-6">
            <AlertTriangle size={12} aria-hidden="true" /> {startTripBlockReason}
          </div>
        )}
      </div></div>

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
          <div className="grid grid-2 gap-16">
            <div>
              <div className="text-xs text-tertiary">Scheduled Departure</div>
              <div className="fw-700">{formatPhDate(trip.departure_date)}</div>
              {/* Stamped by the database the moment Start Trip fires — see
                  guard_trip_status_transition() — never client-supplied. */}
            </div>
            <div>
              <div className="text-xs text-tertiary">Planned Shipment Arrival Date</div>
              <div className="fw-700">{trip.arrival_date ? formatPhDate(trip.arrival_date) : 'Not set'}</div>
            </div>
            {(trip.departure_at || trip.estimated_arrival_at || trip.arrived_at) && (
              <div className="grid grid-3 gap-16" style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                {trip.departure_at && <div><div className="text-xs text-tertiary">Actual Departure</div><div className="fw-700">{formatPhDateTime(trip.departure_at)}</div></div>}
                <div><div className="text-xs text-tertiary">Estimated Arrival at Destination Hub</div><div className="fw-700">{trip.estimated_arrival_at ? formatPhDateTime(trip.estimated_arrival_at) : 'To be confirmed'}</div></div>
                <div><div className="text-xs text-tertiary">Actual Arrival at Destination Hub</div><div className="fw-700">{trip.arrived_at ? formatPhDateTime(trip.arrived_at) : 'Not arrived'}</div></div>
              </div>
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
        <div className="card-header"><h3>Assigned Orders ({orders.length})</h3></div>
        <div className="table-container">
          {orders.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No Assigned Bookings"
              description="No bookings have been assigned to this trip yet."
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Tracking No.</th>
                  <th scope="col">Sender Address</th>
                  <th scope="col">Receiver Address</th>
                  <th scope="col">Status</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} {...rowLinkProps(navigate, `/admin/orders/${o.id}`)}>
                    <td data-label="Tracking No." className="fw-600">{o.tracking_number}</td>
                    <td data-label="Sender Address">{[o.sender_province, o.sender_city].filter(Boolean).join(', ')}</td>
                    <td data-label="Receiver Address">{[o.receiver_province, o.receiver_city].filter(Boolean).join(', ')}</td>
                    <td data-label="Status">
                      <StatusBadge status={o.status} size="sm" />
                    </td>
                    <td data-label="Action">
                      <div className="flex items-center gap-4">
                        <Link to={`/admin/orders/${o.id}`} className="btn btn-primary btn-sm inline-flex items-center gap-xs">
                          View Details
                        </Link>
                        {/* This table lists addresses rather than the booker,
                            so the control carries the customer's name in its
                            accessible label instead of beside it. */}
                        <MessageCustomerButton
                          customerId={o.user_id}
                          customerName={o.profiles?.name}
                        />
                      </div>
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
    </div>
  );
};
export default TripDetailPage;
