import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getTrips, withTimeout } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import { SkeletonCard } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import { Plus, Truck, Calendar, MapPin } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

const tabs = ['All', 'scheduled', 'in_progress', 'arrived', 'completed', 'cancelled'];

const formatTripDate = (value) => {
  if (!value) return 'Date not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date not set';
  return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
};

const getCapacityState = (current = 0, max = 0) => {
  const percent = max > 0 ? (current / max) * 100 : 0;
  return {
    percent,
    barPercent: Math.min(100, percent),
    isOver: percent > 100,
    isWarning: percent > 80,
  };
};

const AdminTripsPage = () => {
  usePageTitle('Trips');
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('All');
  const navigate = useNavigate();

  useEffect(() => { loadTrips(); }, []);
  const loadTrips = async () => {
    setError(null);
    setLoading(true);
    try { 
      const data = await withTimeout(getTrips());
      setTrips(data || []); 
    } catch (e) { 
      setError(e.message || 'Failed to load trips.');
    } finally { 
      setLoading(false); 
    }
  };

  const filtered = activeTab === 'All' ? trips : trips.filter(t => t.status === activeTab);
  const filterOptions = tabs.map(t => ({
    value: t,
    label: t === 'All' ? 'All' : t.replace(/_/g, ' '),
    count: t === 'All' ? trips.length : trips.filter(trip => trip.status === t).length,
  }));

  return (
    <div className="page-transition">
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">Trips</h1>
          <p className="admin-page-subtitle">Plan cargo runs, capacity, and trip status across routes.</p>
        </div>
        <div className="admin-page-meta">
          <span className="badge badge-info">{loading ? 'Loading' : `${filtered.length} shown`}</span>
          <span className="badge">{loading ? 'Checking trips' : `${trips.length} total`}</span>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/admin/trips/create')}><Plus size={16} /> Create Trip</button>
        </div>
      </div>
      <ResponsiveFilterControls
        options={filterOptions}
        value={activeTab}
        onChange={setActiveTab}
        ariaLabel="Trip status filters"
        label="Status"
        desktopClassName="tabs admin-mobile-tabs"
        className="mb-16"
      />
      {loading ? (
        <div className="flex flex-col gap-12">
          {Array.from({ length: 3 }, (_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : error ? (
        <div className="card admin-error-card">
          <h3>Error</h3>
          <p>{error}</p>
          <button type="button" className="btn btn-primary mt-md" onClick={loadTrips}>Retry</button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No trips found"
          description={activeTab === 'All' ? 'Create your first trip to start managing deliveries.' : `No trips with status "${activeTab.replace(/_/g, ' ')}".`}
          actionLabel={activeTab === 'All' ? 'Create Trip' : undefined}
          onAction={activeTab === 'All' ? () => navigate('/admin/trips/create') : undefined}
        />
      ) : (
        filtered.map((trip, i) => (
          <Link
            key={trip.id}
            to={`/admin/trips/${trip.id}`}
            className="card card-interactive admin-list-card stagger-item"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="card-body">
              <div className="flex items-center justify-between mb-8">
                <span className="fw-700 text-accent">{trip.trip_number}</span>
                <StatusBadge status={trip.status} size="sm" />
              </div>
              <div className="flex items-center gap-8 text-sm"><MapPin size={14} className="text-primary" />{trip.origin} → {trip.destination}</div>
              <div className="flex items-center gap-8 text-xs text-secondary mt-4">
                <Calendar size={14} />{formatTripDate(trip.departure_date)}
              </div>
              {trip.capacity > 0 && (
                <div className="mt-8">
                  {(() => {
                    const current = trip.current_weight || 0;
                    const capacity = getCapacityState(current, trip.capacity);
                    return (
                      <>
                        <div className="capacity-bar">
                          <div
                            className={`capacity-fill ${capacity.isOver ? 'danger' : capacity.isWarning ? 'warning' : ''}`}
                            style={{ width: `${capacity.barPercent}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs text-tertiary mt-4">
                          <span>{current.toFixed(1)} / {trip.capacity} kg</span>
                          <span>{capacity.percent.toFixed(0)}%</span>
                        </div>
                        {capacity.isOver && <div className="capacity-note">Over planned capacity</div>}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          </Link>
        ))
      )}
    </div>
  );
};

export default AdminTripsPage;
