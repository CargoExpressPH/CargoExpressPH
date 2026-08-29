import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getDashboardStats, getVanCapacity, withTimeout } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import CapacityTracker from '../../components/ui/CapacityTracker';
import DonutChart from '../../components/ui/DonutChart';
import { SkeletonStatCard, SkeletonTableRow, SkeletonDonut } from '../../components/ui/SkeletonLoader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import PageTransition, { StaggerItem } from '../../components/ui/PageTransition';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';
import { Package, PackageCheck, Truck, Map, Clock, ArrowRight, Gauge, PieChart, AlertTriangle, LayoutDashboard } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import EmptyState from '../../components/ui/EmptyState';

const DashboardPage = () => {
  usePageTitle('Dashboard');
  const [stats, setStats] = useState(null);
  const [capacity, setCapacity] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statsWarning, setStatsWarning] = useState(null);

  useEffect(() => { loadData(); }, []);
  const loadData = async () => {
    setError(null);
    setStatsWarning(null);
    setLoading(true);
    try {
      const results = await Promise.allSettled([
        withTimeout(getDashboardStats()), 
        withTimeout(getVanCapacity())
      ]);
      
      const dashResult = results[0];
      const capResult = results[1];
      
      if (dashResult.status === 'fulfilled' && dashResult.value) {
        setStats(dashResult.value.stats);
        setRecent(dashResult.value.recentOrders || []);
      } else if (dashResult.status === 'rejected') {
        if (import.meta.env.DEV) console.error('Failed to load dashboard stats:', dashResult.reason);
      }
      
      if (capResult.status === 'fulfilled' && capResult.value) {
        setCapacity(capResult.value);
      } else if (capResult.status === 'rejected') {
        if (import.meta.env.DEV) console.error('Failed to load van capacity:', capResult.reason);
      }
      
      if (dashResult.status === 'rejected' && capResult.status === 'rejected') {
        throw new Error('All dashboard data queries failed to load.');
      }

      // Surface partial failures so admin knows data may be incomplete
      const partialFailures = [];
      if (dashResult.status === 'rejected') partialFailures.push('order statistics');
      if (capResult.status === 'rejected') partialFailures.push('van capacity');
      if (partialFailures.length > 0) {
        setStatsWarning(`Failed to load ${partialFailures.join(' and ')}. Some data may be incomplete.`);
      }
    } catch (e) { 
      setError(e.message || 'Failed to load dashboard data.');
    } finally { 
      setLoading(false); 
    }
  };

  if (error) return (
    <PageTransition>
      <div className="card text-center" role="alert" style={{ padding: 40, color: 'var(--error-text)' }}>
        <h3>Error</h3>
        <p>{error}</p>
        <button type="button" className="btn btn-primary mt-md" onClick={loadData}>Retry</button>
      </div>
    </PageTransition>
  );

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
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setStatsWarning(null)}>Dismiss</button>
        </div>
      )}
      {/* Stat Cards */}
      <ErrorBoundarySection message="Stats failed to load.">
        <div className="grid grid-4 mb-24">
          {loading ? (
            <>
              {Array.from({ length: 4 }, (_, i) => (
                <SkeletonStatCard key={i} />
              ))}
            </>
          ) : (
            statCards.map((s, i) => (
              <StaggerItem key={i} className={`stat-card stat-card-${s.tone}`} delay={i * 60}>
                <div className="stat-icon"><s.icon size={22} /></div>
                <div className="stat-value">
                  <AnimatedCounter value={s.value} duration={1200} />
                </div>
                <div className="stat-label">{s.label}</div>
              </StaggerItem>
            ))
          )}
        </div>
      </ErrorBoundarySection>

      <div className="grid grid-2 mb-24">
        {/* Trip Capacity */}
        <ErrorBoundarySection message="Capacity info unavailable.">
          <StaggerItem className="card admin-section-card" delay={240}>
          <div className="card-header"><h3><Gauge size={16} className="inline mr-8" />Trip Capacity</h3></div>
          <div className="card-body">
            {loading ? (
              <div className="p-20">
                <div className="skeleton skeleton-text mb-12" style={{ width: '60%' }} />
                <div className="skeleton" style={{ height: 14, borderRadius: 'var(--radius-full)' }} />
              </div>
            ) : capacity?.activeTrip ? (
              <>
                <div className="text-sm text-secondary mb-12">
                  {capacity.activeTrip.trip_number} • {capacity.activeTrip.origin} → {capacity.activeTrip.destination}
                </div>
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
                title="No active trip"
                description="There are currently no active trips in transit."
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
              <SkeletonDonut size={170} />
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
          <div className="table-container">
            <table className="data-table">
              <thead><tr><th scope="col">Tracking</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
              <tbody>{Array.from({ length: 4 }, (_, i) => <SkeletonTableRow key={i} cols={4} />)}</tbody>
            </table>
          </div>
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
