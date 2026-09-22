import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getDashboardStats, getVanCapacity, withTimeout } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import CapacityTracker from '../../components/ui/CapacityTracker';
import DonutChart from '../../components/ui/DonutChart';
import { CenteredSpinner } from '../../components/ui/Loader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import PageTransition, { StaggerItem } from '../../components/ui/PageTransition';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';
import { Package, PackageCheck, Truck, Map, Clock, ArrowRight, Gauge, PieChart, AlertTriangle, LayoutDashboard } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import EmptyState from '../../components/ui/EmptyState';
import { formatPhDate } from '../../utils/datetime';
import { isScheduledTripOverdue } from '../../lib/tripCapacitySelection';
import useRealtimeTripCapacity from '../../hooks/useRealtimeTripCapacity';

const DashboardPage = () => {
  usePageTitle('Dashboard');
  const [stats, setStats] = useState(null);
  const [capacity, setCapacity] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statsWarning, setStatsWarning] = useState(null);
  const [capacityLoading, setCapacityLoading] = useState(true);
  const [capacityError, setCapacityError] = useState(null);
  const statsRequestSequence = useRef(0);
  const capacityRequestSequence = useRef(0);
  const isMountedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    void loadData();
    void refreshCapacity();
    return () => {
      isMountedRef.current = false;
      statsRequestSequence.current += 1;
      capacityRequestSequence.current += 1;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useRealtimeTripCapacity(refreshCapacity);

  async function loadData() {
    const request = ++statsRequestSequence.current;
    setStatsWarning(null);
    setLoading(true);
    try {
      const dashboardData = await withTimeout(getDashboardStats());
      if (!isMountedRef.current || request !== statsRequestSequence.current) return;
      setStats(dashboardData?.stats || null);
      setRecent(dashboardData?.recentOrders || []);
    } catch (e) { 
      if (isMountedRef.current && request === statsRequestSequence.current) {
        if (import.meta.env.DEV) console.error('Failed to load dashboard stats:', e);
        setStatsWarning('Failed to load order statistics. Some dashboard figures may be incomplete.');
      }
    } finally { 
      if (isMountedRef.current && request === statsRequestSequence.current) setLoading(false);
    }
  }

  async function refreshCapacity() {
    const request = ++capacityRequestSequence.current;
    try {
      const nextCapacity = await withTimeout(getVanCapacity());
      if (!isMountedRef.current || request !== capacityRequestSequence.current) return null;
      setCapacity(nextCapacity);
      setCapacityError(null);
      return true;
    } catch (e) {
      if (!isMountedRef.current || request !== capacityRequestSequence.current) return null;
      setCapacity(null);
      setCapacityError(e.message || 'Trip capacity could not be loaded.');
      return false;
    } finally {
      if (isMountedRef.current && request === capacityRequestSequence.current) setCapacityLoading(false);
    }
  };

  /**
   * Four numbers an admin can act on, in the order cargo moves through the
   * business. "Total Orders" and "Customers" were removed: both only ever go
   * up, so neither tells anyone what to do this morning.
   *
   * A note on the second tile. It counts `status = 'Picked Up'`, which in this
   * system's flow sits between Assigned and In Transit — cargo collected from
   * the sender and sitting on a trip that has not departed yet. It is NOT
   * "held at hub" (that is the later `Arrived at Hub` status, where the
   * settlement gate gets applied) and it is NOT "waiting to be assigned to a
   * trip" (an order with no trip is `Pending`). Labelled for what it counts,
   * because a dispatcher reading "Held at Hub" would go looking for parcels in
   * the wrong warehouse.
   */
  const statCards = [
    // Needs a human: priced at pickup, so these are unpriced and unassigned.
    { label: 'Pending Bookings', value: stats?.pendingOrders || 0, icon: Clock, tone: 'warning' },
    // Collected and loaded — the action is to dispatch the trip.
    { label: 'Awaiting Departure', value: stats?.pickedUp || 0, icon: PackageCheck, tone: 'accent' },
    // Moving. Healthy state, shown for situational awareness rather than action.
    { label: 'In Transit', value: stats?.inTransit || 0, icon: Truck, tone: 'info' },
    // Trips that are scheduled or in progress.
    { label: 'Active Trips', value: stats?.activeTrips || 0, icon: Map, tone: 'primary' },
  ];
  const totalOrders = stats?.totalOrders || 0;
  const knownOrderSegments = [
    { label: 'Pending', value: stats?.pendingOrders || 0, color: 'var(--warning)' },
    { label: 'Picked Up', value: stats?.pickedUp || 0, color: 'var(--primary-text)' },
    { label: 'In Transit', value: stats?.inTransit || 0, color: 'var(--info)' },
    { label: 'Delivered', value: stats?.delivered || 0, color: 'var(--success)' },
  ];
  const knownOrderCount = knownOrderSegments.reduce((sum, segment) => sum + segment.value, 0);
  const orderDistributionSegments = [
    ...knownOrderSegments,
    { label: 'Other Orders', value: Math.max(0, totalOrders - knownOrderCount), color: 'var(--chart-3)' },
  ].filter(segment => segment.value > 0);

  return (
    <PageTransition>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><LayoutDashboard size={24} color="var(--primary)" aria-hidden="true" />Dashboard</h1>
          <p className="admin-page-subtitle">Live operations, trip capacity, and recent order movement.</p>
        </div>
      </div>

      {statsWarning && (
        <div className="alert-banner alert-banner-warning mb-16" role="alert">
          <AlertTriangle size={18} />
          <span className="flex-1 text-sm">{statsWarning}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={loadData}>Retry</button>
        </div>
      )}

      {/* Stat Cards */}
      <ErrorBoundarySection message="Stats failed to load.">
        {loading ? (
          <CenteredSpinner />
        ) : (
          <div className="grid grid-4 mb-24">
            {statCards.map((s, i) => (
              <StaggerItem key={i} className={`stat-card stat-card-${s.tone}`} delay={i * 60}>
                <div className="stat-icon"><s.icon size={22} /></div>
                <div className="stat-value">
                  <AnimatedCounter value={s.value} duration={1200} />
                </div>
                <div className="stat-label">{s.label}</div>
              </StaggerItem>
            ))}
          </div>
        )}
      </ErrorBoundarySection>

      <div className="grid grid-2 mb-24">
        {/* Trip Capacity */}
        <ErrorBoundarySection message="Capacity info unavailable.">
          <StaggerItem className="card admin-section-card" delay={240}>
          <div className="card-header"><h3><Gauge size={16} className="inline mr-8" />Trip Capacity</h3></div>
          <div className="card-body">
            {capacityError ? (
              <div role="alert" className="text-center" style={{ padding: '20px 8px' }}>
                <p className="text-sm text-secondary mb-12">Trip capacity could not be loaded: {capacityError}</p>
                <button type="button" className="btn btn-outline btn-sm" onClick={refreshCapacity}>Retry</button>
              </div>
            ) : loading || (capacityLoading && !capacity) ? (
              <CenteredSpinner />
            ) : capacity?.activeTrip ? (
              <>
                <div className="flex items-center justify-between gap-8 mb-8">
                  <div className="text-sm text-secondary" style={{ overflowWrap: 'anywhere' }}>
                    {capacity.activeTrip.trip_number} • {capacity.activeTrip.origin} → {capacity.activeTrip.destination}
                  </div>
                  <StatusBadge status={capacity.activeTrip.status} size="sm" />
                </div>
                <p className="text-sm text-secondary mb-12">
                  Scheduled departure: {formatPhDate(capacity.activeTrip.departure_date)}
                </p>
                {isScheduledTripOverdue(capacity.activeTrip) ? (
                  <div className="alert-banner alert-banner-warning mb-12" role="status">
                    Overdue — Reschedule Required. This trip cannot be started until it is rescheduled.
                  </div>
                ) : capacity.activeTrip.status === 'in_progress' ? (
                  <p className="text-xs text-secondary mb-12" role="status">
                    Capacity shown is for the ongoing trip. Remaining space does not mean new bookings are accepted.
                  </p>
                ) : capacity.activeTrip.status === 'arrived' ? (
                  <p className="text-xs text-secondary mb-12" role="status">
                    This trip has arrived at the destination hub. New bookings are closed.
                  </p>
                ) : null}
                <CapacityTracker
                  currentWeight={capacity.totalWeight}
                  maxCapacity={capacity.maxCapacity}
                  tripNumber={capacity.activeTrip.trip_number}
                  showLabel={false}
                />
              </>
            ) : (
              <EmptyState
                icon={Truck}
                title="No scheduled or ongoing trip available."
                description="A trip capacity summary will appear when an eligible trip is available."
              />
            )}
          </div>
        </StaggerItem>
        </ErrorBoundarySection>

        {/* Quick Stats */}
        <ErrorBoundarySection message="Order distribution unavailable.">
        <StaggerItem className="card admin-section-card" delay={300}>
          <div className="card-header"><h3><PieChart size={16} className="inline mr-8" />Order Distribution</h3></div>
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', minHeight: '260px' }}>
            {loading ? (
              <CenteredSpinner />
            ) : (
              <DonutChart
                size={170}
                thickness={26}
                centerLabel={String(totalOrders)}
                centerSub="Total"
                segments={orderDistributionSegments}
              />
            )}
          </div>
        </StaggerItem>
        </ErrorBoundarySection>
      </div>

      {/* Recent Orders */}
      <ErrorBoundarySection message="Recent orders failed to load.">
      <StaggerItem className="card admin-section-card admin-table-card" delay={360}>
        <div className="card-header">
          <h3>Recent Orders</h3>
          <Link to="/admin/orders" className="btn btn-ghost btn-sm">View All <ArrowRight size={14} /></Link>
        </div>
        {loading ? (
          <CenteredSpinner />
        ) : recent.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No orders yet"
            description="Incoming customer bookings will appear here."
          />
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead><tr><th scope="col">Tracking</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
              <tbody>
                {recent.map(o => (
                  <tr key={o.id}>
                    <td data-label="Tracking"><Link to={`/admin/orders/${o.id}`} className="fw-600 text-accent">{o.tracking_number}</Link></td>
                    <td data-label="Customer">{o.profiles?.name || '—'}</td>
                    <td data-label="Status"><StatusBadge status={o.status} size="sm" /></td>
                    <td data-label="Date" className="text-sm text-secondary">{new Date(o.created_at).toLocaleDateString('en-PH')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </StaggerItem>
      </ErrorBoundarySection>
    </PageTransition>
  );
};

export default DashboardPage;
