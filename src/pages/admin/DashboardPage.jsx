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
import { Package, Truck, Users, Clock, ArrowRight, Gauge, PieChart, AlertTriangle } from 'lucide-react';
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
      <div className="card text-center" role="alert" style={{ padding: 40, color: 'var(--error)' }}>
        <h3>Error</h3>
        <p>{error}</p>
        <button type="button" className="btn btn-primary mt-md" onClick={loadData}>Retry</button>
      </div>
    </PageTransition>
  );

  const statCards = [
    { label: 'Total Orders', value: stats?.totalOrders || 0, icon: Package, tone: 'primary' },
    { label: 'Pending', value: stats?.pendingOrders || 0, icon: Clock, tone: 'warning' },
    { label: 'Active Trips', value: stats?.activeTrips || 0, icon: Truck, tone: 'info' },
    { label: 'Customers', value: stats?.totalCustomers || 0, icon: Users, tone: 'success' },
  ];
  const totalOrders = stats?.totalOrders || 0;
  const knownOrderSegments = [
    { label: 'Pending', value: stats?.pendingOrders || 0, color: 'var(--warning)' },
    { label: 'Picked Up', value: stats?.pickedUp || 0, color: 'var(--chart-purple)' },
    { label: 'In Transit', value: stats?.inTransit || 0, color: 'var(--info)' },
    { label: 'Delivered', value: stats?.delivered || 0, color: 'var(--success)' },
  ];
  const knownOrderCount = knownOrderSegments.reduce((sum, segment) => sum + segment.value, 0);
  const orderDistributionSegments = [
    ...knownOrderSegments,
    { label: 'Other Orders', value: Math.max(0, totalOrders - knownOrderCount), color: 'var(--chart-slate)' },
  ].filter(segment => segment.value > 0);

  return (
    <PageTransition>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">Dashboard</h1>
          <p className="admin-page-subtitle">Live operations, trip capacity, and recent order movement.</p>
        </div>
      </div>

      {statsWarning && (
        <div className="card mb-16 flex items-center gap-12" role="alert" style={{ padding: '12px 16px', background: 'var(--warning-bg)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-md)' }}>
          <AlertTriangle size={18} style={{ color: 'var(--warning-dark)', flexShrink: 0 }} />
          <span className="flex-1 text-sm" style={{ color: 'var(--warning-dark)' }}>{statsWarning}</span>
          <button type="button" className="btn btn-outline text-xs" onClick={() => setStatsWarning(null)} style={{ padding: '4px 10px', minHeight: 'auto' }}>Dismiss</button>
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
                <div className="stat-icon"><s.icon size={40} /></div>
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
        {/* Van Capacity */}
        <ErrorBoundarySection message="Capacity info unavailable.">
          <StaggerItem className="card admin-section-card" delay={240}>
          <div className="card-header"><h3><Gauge size={16} className="inline mr-8" />Van Capacity</h3></div>
          <div className="card-body">
            {loading ? (
              <div className="p-20">
                <div className="skeleton skeleton-text mb-12" style={{ width: '60%' }} />
                <div className="skeleton" style={{ height: 14, borderRadius: 7 }} />
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
              <div className="text-center text-secondary p-20">No active trip</div>
            )}
          </div>
        </StaggerItem>
        </ErrorBoundarySection>

        {/* Quick Stats */}
        <ErrorBoundarySection message="Order distribution unavailable.">
        <StaggerItem className="card admin-section-card" delay={300}>
          <div className="card-header"><h3><PieChart size={16} className="inline mr-8" />Order Distribution</h3></div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'center', padding: '24px 16px' }}>
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
        <div className="table-container">
          <table className="data-table">
            <thead><tr><th>Tracking</th><th>Customer</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              {loading ? (
                Array.from({ length: 4 }, (_, i) => <SkeletonTableRow key={i} cols={4} />)
              ) : (
                <>
                  {recent.map(o => (
                    <tr key={o.id}>
                      <td data-label="Tracking"><Link to={`/admin/orders/${o.id}`} className="fw-600 text-accent">{o.tracking_number}</Link></td>
                      <td data-label="Customer">{o.profiles?.name || '—'}</td>
                      <td data-label="Status"><StatusBadge status={o.status} size="sm" /></td>
                      <td data-label="Date" className="text-sm text-secondary">{new Date(o.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                  {recent.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ padding: '24px 16px' }}>
                        <EmptyState
                          icon={Package}
                          title="No orders yet"
                          description="Incoming customer bookings will appear here."
                        />
                      </td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </StaggerItem>
      </ErrorBoundarySection>
    </PageTransition>
  );
};

export default DashboardPage;
