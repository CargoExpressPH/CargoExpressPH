import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getDashboardStats, getVanCapacity, getDashboardAttention, getMonthSalesSummary, withTimeout } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import CapacityTracker from '../../components/ui/CapacityTracker';
import { CenteredSpinner } from '../../components/ui/Loader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import PageTransition, { StaggerItem } from '../../components/ui/PageTransition';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';
import {
  Package, PackageCheck, Truck, Map, Clock, ArrowRight, Gauge, AlertTriangle, LayoutDashboard,
  ClipboardCheck, XCircle, MessageSquare, Mail, CalendarClock, ChevronRight, CheckCircle2,
  BarChart3, WalletCards,
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import EmptyState from '../../components/ui/EmptyState';
import { formatPhDate, phDateKey } from '../../utils/datetime';
import { formatMoney } from '../../utils/currencyInput';
import { ORDER_STATUS } from '../../constants/status';
import { isScheduledTripOverdue } from '../../lib/tripCapacitySelection';
import useRealtimeTripCapacity from '../../hooks/useRealtimeTripCapacity';
import { rowLinkProps } from '../../utils/rowLink';

// Every order status in the order cargo moves, each drawn in its badge colour
// so a bar here reads the same as the badge on the order row.
const STATUS_BARS = [
  { status: ORDER_STATUS.PENDING_REVIEW, color: 'var(--badge-warning-color)' },
  { status: ORDER_STATUS.PENDING, color: 'var(--badge-pending-color)' },
  { status: ORDER_STATUS.ASSIGNED, color: 'var(--badge-assigned-color)' },
  { status: ORDER_STATUS.PICKED_UP, color: 'var(--badge-pickedup-color)' },
  { status: ORDER_STATUS.IN_TRANSIT, color: 'var(--badge-intransit-color)' },
  { status: ORDER_STATUS.ARRIVED_HUB, color: 'var(--badge-arrived-color)' },
  { status: ORDER_STATUS.OUT_FOR_DELIVERY, color: 'var(--badge-outdelivery-color)' },
  { status: ORDER_STATUS.DELIVERED, color: 'var(--badge-delivered-color)' },
  { status: ORDER_STATUS.PENDING_CANCELLATION, color: 'var(--badge-warning-color)' },
  { status: ORDER_STATUS.CANCELLED, color: 'var(--badge-cancelled-color)' },
];

// Overdue payment promises listed by name before collapsing into "+N more".
const PROMISES_SHOWN = 3;

const currentMonthKey = () => phDateKey(new Date().toISOString()).slice(0, 7);

const monthLabel = (monthKey) =>
  formatPhDate(`${monthKey}-01T00:00:00+08:00`, { month: 'long', year: 'numeric', day: undefined });

const DashboardPage = () => {
  usePageTitle('Dashboard');
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [capacity, setCapacity] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statsWarning, setStatsWarning] = useState(null);
  const [capacityLoading, setCapacityLoading] = useState(true);
  const [capacityError, setCapacityError] = useState(null);
  const [attention, setAttention] = useState(null);
  const [attentionLoading, setAttentionLoading] = useState(true);
  const [attentionError, setAttentionError] = useState(false);
  const [monthKey] = useState(currentMonthKey);
  const [monthSummary, setMonthSummary] = useState(null);
  const [monthLoading, setMonthLoading] = useState(true);
  const [monthError, setMonthError] = useState(false);
  const statsRequestSequence = useRef(0);
  const capacityRequestSequence = useRef(0);
  const attentionRequestSequence = useRef(0);
  const monthRequestSequence = useRef(0);
  const isMountedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    void loadData();
    void refreshCapacity();
    void refreshAttention();
    void loadMonthSummary();
    return () => {
      isMountedRef.current = false;
      statsRequestSequence.current += 1;
      capacityRequestSequence.current += 1;
      attentionRequestSequence.current += 1;
      monthRequestSequence.current += 1;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Trip and order changes move both the capacity card and the attention
  // list. The capacity result is what the hook's poll back-off keys on, so it
  // is the one returned.
  useRealtimeTripCapacity(async () => {
    const [capacityResult] = await Promise.all([refreshCapacity(), refreshAttention()]);
    return capacityResult;
  });

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
  }

  async function refreshAttention() {
    const request = ++attentionRequestSequence.current;
    try {
      const next = await withTimeout(getDashboardAttention());
      if (!isMountedRef.current || request !== attentionRequestSequence.current) return;
      setAttention(next);
      setAttentionError(false);
    } catch (e) {
      if (!isMountedRef.current || request !== attentionRequestSequence.current) return;
      if (import.meta.env.DEV) console.error('Failed to load dashboard attention items:', e);
      // Keep the last good list on screen during a background refresh.
      setAttentionError(true);
    } finally {
      if (isMountedRef.current && request === attentionRequestSequence.current) setAttentionLoading(false);
    }
  }

  async function loadMonthSummary() {
    const request = ++monthRequestSequence.current;
    setMonthLoading(true);
    setMonthError(false);
    try {
      const summary = await withTimeout(getMonthSalesSummary(monthKey));
      if (!isMountedRef.current || request !== monthRequestSequence.current) return;
      setMonthSummary(summary?.grandTotal || null);
    } catch (e) {
      if (!isMountedRef.current || request !== monthRequestSequence.current) return;
      if (import.meta.env.DEV) console.error('Failed to load monthly sales summary:', e);
      setMonthError(true);
    } finally {
      if (isMountedRef.current && request === monthRequestSequence.current) setMonthLoading(false);
    }
  }

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

  // ── Needs attention ────────────────────────────────────────────────────
  // A count of null means that source failed to load; its row is left out
  // rather than shown as a reassuring zero.
  const statusCounts = attention?.statusCounts;
  const countOf = (status) => (statusCounts ? statusCounts[status] || 0 : null);
  const overdueTrips = (capacity?.otherTrips || []).filter(trip => isScheduledTripOverdue(trip));
  if (capacity?.activeTrip && isScheduledTripOverdue(capacity.activeTrip)) overdueTrips.unshift(capacity.activeTrip);
  const overduePromises = attention?.overduePromises;

  const attentionRows = [
    {
      key: 'coverage', icon: ClipboardCheck, tone: 'warning',
      count: countOf(ORDER_STATUS.PENDING_REVIEW),
      label: 'Coverage reviews', hint: 'Pickups outside the usual area',
      to: '/admin/orders?tab=Action%20Needed',
    },
    {
      key: 'cancellations', icon: XCircle, tone: 'error',
      count: countOf(ORDER_STATUS.PENDING_CANCELLATION),
      label: 'Cancellation requests', hint: 'Customers waiting on a decision',
      to: '/admin/orders?tab=Action%20Needed',
    },
    {
      key: 'unassigned', icon: Package, tone: 'warning',
      count: countOf(ORDER_STATUS.PENDING),
      label: 'Bookings without a trip', hint: 'Assign them before pickup',
      to: '/admin/orders?tab=Pending',
    },
    {
      key: 'overdue-trips', icon: CalendarClock, tone: 'error',
      count: capacity ? overdueTrips.length : null,
      label: overdueTrips.length === 1 ? 'Trip past its departure date' : 'Trips past their departure date',
      hint: 'Start or reschedule',
      to: overdueTrips.length === 1 ? `/admin/trips/${overdueTrips[0].id}` : '/admin/trips',
    },
    {
      key: 'inbox', icon: MessageSquare, tone: 'info',
      count: attention?.inboxWaiting ?? null,
      label: 'Customer chats waiting', hint: 'Handed over by the support bot',
      to: '/admin/inbox',
    },
    {
      key: 'inquiries', icon: Mail, tone: 'info',
      count: attention?.newInquiries ?? null,
      label: 'New contact inquiries', hint: 'From the public contact form',
      to: '/admin/contact-inquiries',
    },
  ].filter(row => row.count > 0);

  const hasOverduePromises = Array.isArray(overduePromises) && overduePromises.length > 0;
  const allCaughtUp = attention && !attentionError && attentionRows.length === 0 && !hasOverduePromises;

  // ── Orders by status ───────────────────────────────────────────────────
  const statusBars = statusCounts
    ? STATUS_BARS.map(bar => ({ ...bar, count: statusCounts[bar.status] || 0 })).filter(bar => bar.count > 0)
    : [];
  const statusTotal = statusBars.reduce((sum, bar) => sum + bar.count, 0);
  const statusMax = statusBars.reduce((max, bar) => Math.max(max, bar.count), 0);

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
        {/* Needs attention */}
        <ErrorBoundarySection message="Attention items unavailable.">
          <StaggerItem className="card admin-section-card dash-attention-card" delay={180}>
            <div className="card-header"><h3><AlertTriangle size={16} className="inline mr-8" aria-hidden="true" />Needs Attention</h3></div>
            <div className="card-body">
              {attentionLoading && !attention ? (
                <CenteredSpinner />
              ) : attentionError && !attention ? (
                <div role="alert" className="text-center dash-card-message">
                  <p className="text-sm text-secondary mb-12">Attention items could not be loaded.</p>
                  <button type="button" className="btn btn-outline btn-sm" onClick={refreshAttention}>Retry</button>
                </div>
              ) : allCaughtUp ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="All caught up"
                  description="No reviews, requests, overdue trips or waiting messages right now."
                />
              ) : (
                <>
                  {attentionRows.length > 0 && (
                    <ul className="dash-attention-list">
                      {attentionRows.map(row => (
                        <li key={row.key}>
                          <Link to={row.to} className="dash-attention-row">
                            <span className={`dash-attention-icon dash-tone-${row.tone}`} aria-hidden="true"><row.icon size={16} /></span>
                            <span className="dash-attention-text">
                              <span className="dash-attention-label">{row.label}</span>
                              <span className="dash-attention-hint">{row.hint}</span>
                            </span>
                            <span className="dash-attention-count">{row.count}</span>
                            <ChevronRight size={16} className="dash-attention-chevron" aria-hidden="true" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  {hasOverduePromises && (
                    <div className="dash-promises">
                      <div className="dash-promises-title">
                        <WalletCards size={16} aria-hidden="true" />
                        Overdue payment promises
                        <span className="dash-attention-count">{overduePromises.length}</span>
                      </div>
                      <ul className="dash-promise-list">
                        {overduePromises.slice(0, PROMISES_SHOWN).map(order => (
                          <li key={order.id}>
                            <Link to={`/admin/orders/${order.id}`} className="dash-promise-row">
                              <span className="dash-promise-ref">{order.tracking_number}</span>
                              <span className="dash-promise-meta">
                                {order.profiles?.name || 'Customer'} · due {formatPhDate(order.promised_payment_date)}
                              </span>
                              <span className="dash-promise-amount">{formatMoney(order.outstanding)}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                      {overduePromises.length > PROMISES_SHOWN && (
                        <p className="dash-promises-more">+{overduePromises.length - PROMISES_SHOWN} more with a past promise date</p>
                      )}
                    </div>
                  )}
                  {attentionError && (
                    <p className="text-xs text-secondary mt-12" role="status">Some items could not be refreshed. Showing the last known list.</p>
                  )}
                </>
              )}
            </div>
          </StaggerItem>
        </ErrorBoundarySection>

        {/* Next departure */}
        <ErrorBoundarySection message="Capacity info unavailable.">
          <StaggerItem className="card admin-section-card" delay={240}>
            <div className="card-header"><h3><Gauge size={16} className="inline mr-8" aria-hidden="true" />Next Departure</h3></div>
            <div className="card-body">
              {capacityError ? (
                <div role="alert" className="text-center dash-card-message">
                  <p className="text-sm text-secondary mb-12">Trip capacity could not be loaded: {capacityError}</p>
                  <button type="button" className="btn btn-outline btn-sm" onClick={refreshCapacity}>Retry</button>
                </div>
              ) : capacityLoading && !capacity ? (
                <CenteredSpinner />
              ) : capacity?.activeTrip ? (
                <>
                  <div className="flex items-center justify-between gap-8 mb-8 dash-active-trip-header">
                    <Link to={`/admin/trips/${capacity.activeTrip.id}`} className="text-sm fw-600 text-accent dash-active-trip-link" style={{ overflowWrap: 'anywhere' }}>
                      <span>{capacity.activeTrip.trip_number} • </span>
                      <span className="dash-active-trip-route">{capacity.activeTrip.origin} → {capacity.activeTrip.destination}</span>
                    </Link>
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
                  {capacity.otherTrips?.length > 0 && (
                    <div className="dash-other-trips">
                      <div className="dash-other-trips-title">Also active</div>
                      <ul>
                        {capacity.otherTrips.map(trip => (
                          <li key={trip.id}>
                            <Link to={`/admin/trips/${trip.id}`} className="dash-other-trip-row">
                              <span className="dash-other-trip-ref">{trip.trip_number}</span>
                              <span className="dash-other-trip-route">{trip.origin} → {trip.destination}</span>
                              {isScheduledTripOverdue(trip)
                                ? <span className="badge badge-warning text-xs">Overdue</span>
                                : <StatusBadge status={trip.status} size="sm" />}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
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
      </div>

      <div className="grid grid-2 mb-24">
        {/* This month */}
        <ErrorBoundarySection message="Monthly summary unavailable.">
          <StaggerItem className="card admin-section-card dash-month-card" delay={300}>
            <div className="card-header">
              <h3><WalletCards size={16} className="inline mr-8" aria-hidden="true" />{monthLabel(monthKey)}</h3>
              <Link to="/admin/sales" className="btn btn-ghost btn-sm">Sales & Reports <ArrowRight size={14} /></Link>
            </div>
            <div className="card-body">
              {monthLoading ? (
                <CenteredSpinner />
              ) : monthError || !monthSummary ? (
                <div role="alert" className="text-center dash-card-message">
                  <p className="text-sm text-secondary mb-12">This month&apos;s totals could not be loaded.</p>
                  <button type="button" className="btn btn-outline btn-sm" onClick={loadMonthSummary}>Retry</button>
                </div>
              ) : (
                <>
                  <dl className="dash-money-grid">
                    <div className="dash-money">
                      <dt>Cargo fees</dt>
                      <dd>{formatMoney(monthSummary.shippingFees)}</dd>
                    </div>
                    <div className="dash-money">
                      <dt>Payments after refunds</dt>
                      <dd className="dash-money-positive">{formatMoney(monthSummary.paymentsAfterRefunds)}</dd>
                    </div>
                    <div className="dash-money">
                      <dt>Still to collect</dt>
                      <dd className={monthSummary.amountStillToCollect > 0 ? 'dash-money-owing' : ''}>{formatMoney(monthSummary.amountStillToCollect)}</dd>
                    </div>
                  </dl>
                  <p className="text-xs text-secondary mt-12">
                    {monthSummary.tripCount === 0
                      ? 'No trips depart this month yet.'
                      : `Across ${monthSummary.tripCount} trip${monthSummary.tripCount === 1 ? '' : 's'} departing this month, calculated the same way as Sales & Reports.`}
                  </p>
                </>
              )}
            </div>
          </StaggerItem>
        </ErrorBoundarySection>

        {/* Orders by status */}
        <ErrorBoundarySection message="Order distribution unavailable.">
          <StaggerItem className="card admin-section-card" delay={360}>
            <div className="card-header">
              <h3><BarChart3 size={16} className="inline mr-8" aria-hidden="true" />Orders by Status</h3>
              {statusTotal > 0 && <span className="text-sm text-secondary">{statusTotal} total</span>}
            </div>
            <div className="card-body">
              {attentionLoading && !attention ? (
                <CenteredSpinner />
              ) : !statusCounts ? (
                <div role="alert" className="text-center dash-card-message">
                  <p className="text-sm text-secondary mb-12">Order counts could not be loaded.</p>
                  <button type="button" className="btn btn-outline btn-sm" onClick={refreshAttention}>Retry</button>
                </div>
              ) : statusBars.length === 0 ? (
                <EmptyState icon={Package} title="No orders yet" description="Status counts appear once bookings come in." />
              ) : (
                <ul className="dash-status-bars">
                  {statusBars.map(bar => (
                    <li key={bar.status} className="dash-status-bar">
                      <span className="dash-status-label">{bar.status}</span>
                      <span className="dash-status-track" aria-hidden="true">
                        <span
                          className="dash-status-fill"
                          style={{ width: `${Math.max(4, (bar.count / statusMax) * 100)}%`, background: bar.color }}
                        />
                      </span>
                      <span className="dash-status-count">{bar.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </StaggerItem>
        </ErrorBoundarySection>
      </div>

      {/* Recent Orders */}
      <ErrorBoundarySection message="Recent orders failed to load.">
      <StaggerItem className="card admin-section-card admin-table-card" delay={420}>
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
            <table className="data-table data-table--compact">
              <thead><tr><th scope="col">Tracking</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
              <tbody>
                {recent.map(o => (
                  <tr key={o.id} {...rowLinkProps(navigate, `/admin/orders/${o.id}`)}>
                    <td data-label="Tracking"><Link to={`/admin/orders/${o.id}`} className="fw-600 text-accent">{o.tracking_number}</Link></td>
                    <td data-label="Customer">{o.profiles?.name || '—'}</td>
                    <td data-label="Status"><StatusBadge status={o.status} size="sm" /></td>
                    <td data-label="Date" className="text-sm text-secondary">{formatPhDate(o.created_at)}</td>
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
