import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getOrders, getOrderStatusCounts, withTimeout } from '../../lib/database';
import useNetworkRecovery from '../../hooks/useNetworkRecovery';
import useRealtimeOrders from '../../hooks/useRealtimeOrders';
import { useAuth } from '../../contexts/AuthContext';
import StatusBadge from '../../components/ui/StatusBadge';
import { SkeletonTableRow } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import PageTransition from '../../components/ui/PageTransition';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import Pagination from '../../components/ui/Pagination';
import { Search, Package } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { formatMoney } from '../../utils/currencyInput';
import { isOrderPriced, ORDER_STATUS } from '../../constants/status';

// Eleven chips — one per status — put the whole state machine in the toolbar and
// made the two that need a human ('Pending Review', 'Pending Cancellation') look
// like the eight that don't. These six group by what the admin has to DO:
// something is waiting on a decision, waiting on a trip, moving, or finished.
// The exact micro-status is still on every row's badge and on the order page.
//
// `statuses: null` means "no filter" — an empty array would filter to nothing.
const FILTER_GROUPS = [
  { value: 'All',           label: 'All',           statuses: null },
  { value: 'Action Needed', label: 'Action Needed', statuses: [ORDER_STATUS.PENDING_REVIEW, ORDER_STATUS.PENDING_CANCELLATION] },
  { value: 'Pending',       label: 'Pending',       statuses: [ORDER_STATUS.PENDING] },
  { value: 'Active',        label: 'Active',        statuses: [ORDER_STATUS.ASSIGNED, ORDER_STATUS.PICKED_UP, ORDER_STATUS.IN_TRANSIT, ORDER_STATUS.ARRIVED_HUB, ORDER_STATUS.OUT_FOR_DELIVERY] },
  { value: 'Completed',     label: 'Completed',     statuses: [ORDER_STATUS.DELIVERED] },
  { value: 'Cancelled',     label: 'Cancelled',     statuses: [ORDER_STATUS.CANCELLED] },
];

// Every status appears in exactly one group, so 'All' is the sum of the other
// five and nothing can go missing from the list by being unfiltered anywhere.
const statusesForTab = (tab) =>
  FILTER_GROUPS.find(g => g.value === tab)?.statuses ?? null;

// Which tabs carry a badge. 'All' is a total, not a queue — a number there
// would compete with the two that mean something. 'Completed' and 'Cancelled'
// only grow, so their counts are trivia, not work.
const BADGED_TABS = ['Action Needed', 'Pending', 'Active'];

// Sum the per-status counts the RPC returns into one group's total. A status
// absent from the payload has no orders, which is a 0 here.
const groupCount = (statusCounts, statuses) =>
  statuses.reduce((sum, status) => sum + (statusCounts[status] || 0), 0);

// Debounce delay in ms — avoids firing a DB query on every keystroke.
// Matches CustomersPage so admin search feels consistent across pages.
const SEARCH_DEBOUNCE_MS = 350;

const AdminOrdersPage = () => {
  usePageTitle('Bookings');
  const { user } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('All');
  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage, setPerPage] = useState(15);

  const [totalOrders, setTotalOrders] = useState(0);

  // Only the debounced value reaches the query; `search` drives the input.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceTimer = useRef(null);

  const loadOrders = async () => {
    setError(null);
    setLoading(true);
    try {
      const { data, count } = await withTimeout(
        getOrders(null, true, {
          page: currentPage,
          perPage,
          // A group is a list of statuses matched with IN, applied in the query
          // so pagination and the total count cover the same population.
          statusFilter: statusesForTab(activeTab),
          search: debouncedSearch.trim(),
        })
      );
      setOrders(data || []);
      setTotalOrders(count || 0);
    } catch (e) {
      setError(e.message || 'Failed to load bookings.');
    } finally {
      setLoading(false);
    }
  };

  // loadOrders closes over the current tab, page and search. The refresh
  // callbacks below are memoized (so they don't re-subscribe the socket on
  // every render), which would otherwise pin them to the first render's
  // filters and reload page 1 of "All" forever.
  const loadOrdersRef = useRef(loadOrders);
  loadOrdersRef.current = loadOrders;

  useEffect(() => { loadOrders(); }, [currentPage, perPage, activeTab, debouncedSearch]);

  // ── Filter badges ────────────────────────────────────────────────────────
  // Deliberately NOT part of loadOrders: the counts do not depend on the tab,
  // the page, or the search box, so recomputing them on every keystroke or
  // page turn would be an aggregate over the whole orders table for an answer
  // that has not changed. They move only when an order's status does, which is
  // mount, a realtime batch, and coming back from offline.
  //
  // null (not {}) until the first load, so a badge is absent rather than
  // claiming zero while the answer is still unknown.
  const [statusCounts, setStatusCounts] = useState(null);

  const loadStatusCounts = useCallback(async () => {
    try {
      setStatusCounts(await getOrderStatusCounts());
    } catch {
      // A failed count must not take the list down with it — the table is the
      // page, the badges are decoration. Leave whatever was there.
    }
  }, []);

  useEffect(() => { loadStatusCounts(); }, [loadStatusCounts]);

  // Cleanup debounce on unmount so a pending timer can't set state after teardown
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  const handleRecovery = useCallback(() => {
    loadOrdersRef.current();
    loadStatusCounts();
  }, [loadStatusCounts]);

  useNetworkRecovery(handleRecovery);

  // One admin action fans out across many rows (a trip cascade rewrites every
  // order aboard), so the hook's debounce collapses the burst into one refresh
  // of both the rows on screen and the badge totals.
  const handleRealtimeBatch = useCallback(() => {
    loadOrdersRef.current();
    loadStatusCounts();
  }, [loadStatusCounts]);

  useRealtimeOrders({
    // Keyed off the session, not off `loading`: this list sets loading on every
    // tab change and page turn, so gating on it would tear the socket down and
    // rebuild it each time the admin clicks a filter.
    enabled: Boolean(user?.id),
    channelName: 'admin_orders_list',
    userId: user?.id,
    debounceMs: 1500,
    onBatch: handleRealtimeBatch,
  });

  const filterOptions = FILTER_GROUPS.map(g => {
    const badged = statusCounts && BADGED_TABS.includes(g.value);
    const count = badged ? groupCount(statusCounts, g.statuses) : null;
    return {
      value: g.value,
      label: g.label,
      // A zero queue is good news and needs no pill; showing "0" three times
      // trains the eye to skip the row where the real number appears.
      count: count > 0 ? count : null,
      // Red only where a human is blocked waiting on a decision.
      countClassName: g.value === 'Action Needed' ? 'tab-count-alert' : undefined,
    };
  });

  const handleTabChange = (tab) => { setActiveTab(tab); setCurrentPage(1); };
  const handleSearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    setCurrentPage(1);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedSearch(val), SEARCH_DEBOUNCE_MS);
  };

  const paginated = orders;
  const totalFiltered = totalOrders;

  return (
    <PageTransition>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Package size={24} color="var(--primary)" aria-hidden="true" />Bookings</h1>
          <p className="admin-page-subtitle">Search, review, and advance every cargo order.</p>
        </div>
        <div className="admin-page-meta">
          <span className="badge badge-info">{loading ? 'Loading' : `${paginated.length} shown`}</span>
          <span className="badge">{loading ? 'Checking orders' : `${totalFiltered} total`}</span>
        </div>
      </div>
      <div className="admin-toolbar">
        <div className="search-box" role="search">
          <Search size={16} className="search-icon" aria-hidden="true" />
          <input
            aria-label="Search orders"
            placeholder="Search tracking, sender, or receiver..."
            value={search}
            onChange={handleSearchChange}
          />
        </div>
      </div>
      <ResponsiveFilterControls
        options={filterOptions}
        value={activeTab}
        onChange={handleTabChange}
        ariaLabel="Order status filters"
        label="Status"
        desktopClassName="tabs admin-mobile-tabs"
        className="mb-16"
      />
      {loading ? (
        <div className="card animate-fade-in">
          <div className="table-container">
            <table className="data-table" aria-busy="true">
              <caption className="sr-only">List of customer bookings (loading)</caption>
              <thead><tr><th scope="col">Tracking</th><th scope="col">Customer</th><th scope="col">Route</th><th scope="col">Weight</th><th scope="col">Cost</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
              <tbody>
                {Array.from({ length: 6 }, (_, i) => <SkeletonTableRow key={i} cols={7} />)}
              </tbody>
            </table>
          </div>
        </div>
      ) : error ? (
        <div className="card admin-error-card">
          <h3>Error</h3>
          <p>{error}</p>
          <button type="button" className="btn btn-primary mt-md" onClick={loadOrders}>Retry</button>
        </div>
      ) : (
        <div className="card admin-section-card admin-table-card animate-fade-in">
          <div className="table-container">
            <table className="data-table data-table--wide">
              <caption className="sr-only">List of customer bookings</caption>
              <thead><tr><th scope="col">Tracking</th><th scope="col">Customer</th><th scope="col">Route</th><th scope="col">Weight</th><th scope="col">Cost</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
              <tbody>
                {paginated.map((o) => (
                  <tr key={o.id}>
                    <td data-label="Tracking">
                      <div className="flex flex-col" style={{gap: '4px'}}>
                        <Link to={`/admin/orders/${o.id}`} className="fw-700 text-accent">{o.tracking_number}</Link>
                        {o.service_area_status === 'for_review' && (
                          <span className="badge badge-warning" style={{ alignSelf: 'flex-start', fontSize: '0.65rem' }}>Out of Coverage Review</span>
                        )}
                      </div>
                    </td>
                    <td data-label="Customer">{o.profiles?.name || o.sender_name}</td>
                    <td data-label="Route" className="text-sm">{o.origin} → {o.destination}</td>
                    <td data-label="Weight">{o.actual_weight ? `${o.actual_weight} kg` : '—'}</td>
                    <td data-label="Cost" className="fw-600">{isOrderPriced(o) ? formatMoney(parseFloat(o.shipping_cost || 0)) : '—'}</td>
                    <td data-label="Status"><StatusBadge status={o.status} size="sm" /></td>
                    <td data-label="Date" className="text-xs text-secondary">{new Date(o.created_at).toLocaleDateString('en-PH')}</td>
                  </tr>
                ))}
                {paginated.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-0 b-0">
                      <EmptyState
                        icon={Package}
                        title="No orders found"
                        description="Try adjusting your search or filter criteria."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            totalItems={totalFiltered}
            currentPage={currentPage}
            itemsPerPage={perPage}
            onPageChange={setCurrentPage}
            onPerPageChange={(n) => { setPerPage(n); setCurrentPage(1); }}
          />
        </div>
      )}
    </PageTransition>
  );
};

export default AdminOrdersPage;
