import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getTripById, updateTrip, getActivityLogsByRecord, bulkUpdateOrdersStatusByTrip } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import ConfirmModal from '../../components/ui/ConfirmModal';
import { SkeletonText } from '../../components/ui/SkeletonLoader';
import { ArrowLeft, Play, Flag, CheckCircle, XCircle, Loader, Clock, ArrowRight } from 'lucide-react';
import CapacityTracker from '../../components/ui/CapacityTracker';
import Breadcrumb from '../../components/ui/Breadcrumb';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { logTrip } from '../../lib/activityLog';

const TripDetailPage = () => {
  usePageTitle('Trip Details');
  const { id } = useParams(); const navigate = useNavigate();
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activityHistory, setActivityHistory] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const toast = useToast();

  useEffect(() => {
    let isMounted = true;
    load(isMounted);
    return () => { isMounted = false; };
  }, [id]);

  const load = async (isMounted = true) => {
    setError(null); setLoading(true);
    try {
      const result = await getTripById(id);
      if (isMounted) setData(result);
      const actLogs = await getActivityLogsByRecord(id);
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
    }

    setSaving(true);
    try {
      await updateTrip(id, { status });
      const tripRef = data?.trip?.trip_number || id;
      const actionMap = { in_progress: 'Trip Started', arrived: 'Trip Arrived', completed: 'Trip Completed', cancelled: 'Trip Cancelled' };
      logTrip(actionMap[status] || `Status Changed to ${status}`, id, tripRef, { previousValue: { status: data?.trip?.status }, newValue: { status }, details: `Trip status updated to ${status}` });
      
      // Perform bulk order updates based on the new trip status
      if (status === 'in_progress') {
        await bulkUpdateOrdersStatusByTrip(id, ['Picked Up'], 'In Transit', 'Triggered by Trip Start');
      } else if (status === 'arrived') {
        await bulkUpdateOrdersStatusByTrip(id, ['In Transit'], 'Arrived at Hub', 'Triggered by Trip Arrival');
      }

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

  const handleCompleteClick = () => {
    const undelivered = orders.some(o => o.status !== 'Delivered' && o.status !== 'Cancelled');
    if (undelivered) {
      toast.error('All assigned orders must be delivered or cancelled before completing this trip.');
      return;
    }
    openConfirm('completed', 'Complete Trip', `Complete trip ${trip.trip_number}? All orders have been delivered.`, 'success');
  };

  if (loading) return (
    <div className="page-transition">
      <div className="skeleton skeleton-text w-80 mb-16" />
      <div className="skeleton skeleton-text mb-8" style={{ width: '200px', height: 28 }} />
      <div className="skeleton skeleton-text mb-20" style={{ width: '250px' }} />
      <div className="card mb-16"><div className="card-body"><SkeletonText lines={2} /></div></div>
      <div className="card mb-16"><div className="card-body"><SkeletonText lines={3} /></div></div>
    </div>
  );
  if (error) return (
    <div className="page-transition">
      <div className="card text-center" role="alert" style={{ padding: 40, color: 'var(--error)' }}>
        <h3>Error Loading Trip</h3>
        <p className="mt-8 mb-20">{error}</p>
        <button type="button" className="btn btn-primary" onClick={() => load()}>Retry</button>
      </div>
    </div>
  );
  if (!data) return <div className="empty-state"><h3>Trip not found</h3></div>;
  const { trip, orders, current_weight } = data;

  return (
    <div className="page-transition">
      <Breadcrumb items={[
        { label: 'Dashboard', to: '/admin' },
        { label: 'Trips', to: '/admin/trips' },
        { label: trip.trip_number },
      ]} />
      <div className="flex items-center justify-between mb-20">
        <div>
          <h1 className="fw-800">{trip.trip_number}</h1>
          <div className="flex items-center gap-8 mt-4 text-sm">
            <span className="fw-800 text-secondary">{trip.origin}</span>
            <span className="fw-700" style={{ color: 'var(--primary)' }}>➔</span>
            <span className="fw-800 text-secondary">{trip.destination}</span>
          </div>
        </div>
        <StatusBadge status={trip.status}/>
      </div>

      {/* Actions */}
      <div className="card admin-section-card admin-action-card stagger-item mb-16" style={{ animationDelay: '60ms'}}><div className="card-body"><div className="admin-action-group">
        {trip.status==='scheduled' && <button type="button" className="btn btn-primary" onClick={()=>openConfirm('in_progress', 'Start Trip', `Start trip ${trip.trip_number}? This will mark it as in progress.`, 'info')} disabled={saving}><Play size={16}/> Start Trip</button>}
        {trip.status==='in_progress' && <button type="button" className="btn btn-success" onClick={()=>openConfirm('arrived', 'Mark Arrived', `Mark trip ${trip.trip_number} as arrived at destination?`, 'success')} disabled={saving}><Flag size={16}/> Mark Arrived</button>}
        {trip.status==='arrived' && <button type="button" className="btn btn-primary" onClick={handleCompleteClick} disabled={saving}><CheckCircle size={16}/> Complete</button>}
        {!['completed','cancelled'].includes(trip.status) && <button type="button" className="btn btn-danger btn-sm" onClick={()=>openConfirm('cancelled', 'Cancel Trip', `Cancel trip ${trip.trip_number}? This action cannot be undone.`, 'danger')} disabled={saving}><XCircle size={16}/> Cancel</button>}
        </div>
        {saving && <Loader size={18} className="animate-spin"/>}
      </div></div>

      {/* Capacity */}
      <div className="card admin-section-card stagger-item mb-16" style={{ animationDelay: '120ms'}}>
        <div className="card-body">
          <CapacityTracker currentWeight={current_weight} maxCapacity={trip.capacity} tripNumber={trip.trip_number} />
        </div>
      </div>

      {/* Orders */}
      <div className="card admin-section-card admin-table-card stagger-item" style={{ animationDelay: '180ms' }}>
        <div className="card-header"><h3>Assigned Orders ({orders.length})</h3></div>
        <div className="table-container">
          {orders.length === 0 ? (
            <div className="text-center text-secondary py-32">No assigned bookings found for this trip.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tracking No.</th>
                  <th>Sender Address</th>
                  <th>Receiver Address</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id}>
                    <td data-label="Tracking No." className="fw-600">{o.tracking_number}</td>
                    <td data-label="Sender Address">{[o.sender_province, o.sender_city].filter(Boolean).join(', ')}</td>
                    <td data-label="Receiver Address">{[o.receiver_province, o.receiver_city].filter(Boolean).join(', ')}</td>
                    <td data-label="Status">
                      <StatusBadge status={o.status} size="sm" />
                    </td>
                    <td data-label="Action">
                      <Link to={`/admin/orders/${o.id}`} className="btn btn-primary btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        View Details
                      </Link>
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
            <div style={{ position: 'relative', paddingLeft: 20 }}>
              <div style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 2, background: 'var(--border)', borderRadius: 2 }} />
              {activityHistory.map((log) => (
                <div key={log.id} style={{ position: 'relative', marginBottom: 16, paddingLeft: 20 }}>
                  <div style={{
                    position: 'absolute', left: -13, top: 4, width: 10, height: 10,
                    borderRadius: '50%', background: 'var(--primary)', border: '2px solid var(--surface)',
                    boxShadow: '0 0 0 2px var(--primary)',
                  }} />
                  <div className="text-xs text-tertiary mb-2">
                    {new Date(log.created_at).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}
                    {' · '}
                    {new Date(log.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}
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
      />
    </div>
  );
};
export default TripDetailPage;
