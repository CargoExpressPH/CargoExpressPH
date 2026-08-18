import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getOrders, withTimeout } from '../../lib/database';
import useNetworkRecovery from '../../hooks/useNetworkRecovery';
import StatusBadge from '../../components/ui/StatusBadge';
import { SkeletonTableRow } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import PageTransition from '../../components/ui/PageTransition';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import Pagination from '../../components/ui/Pagination';
import { Search, Package } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
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

// Debounce delay in ms — avoids firing a DB query on every keystroke.
// Matches CustomersPage so admin search feels consistent across pages.
const SEARCH_DEBOUNCE_MS = 350;

const AdminOrdersPage = () => {
  usePageTitle('Bookings');
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

  useEffect(() => { loadOrders(); }, [currentPage, perPage, activeTab, debouncedSearch]);

  // Cleanup debounce on unmount so a pending timer can't set state after teardown
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  useNetworkRecovery(loadOrders);

  // Counts would need one COUNT query per group; the list already reports the
  // total for the active filter in the header, so they stay off.
  const filterOptions = FILTER_GROUPS.map(g => ({ value: g.value, label: g.label, count: null }));

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
          <h1 className="admin-page-title">Bookings</h1>
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
            <table className="data-table">
              <caption className="sr-only">List of customer bookings</caption>
              <thead><tr><th scope="col">Tracking</th><th scope="col">Customer</th><th scope="col">Route</th><th scope="col">Weight</th><th scope="col">Cost</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
              <tbody>
                {paginated.map((o) => (
                  <tr key={o.id}>
                    <td data-label="Tracking">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <Link to={`/admin/orders/${o.id}`} className="fw-700 text-accent">{o.tracking_number}</Link>
                        {o.service_area_status === 'for_review' && (
                          <span className="badge badge-warning" style={{ alignSelf: 'flex-start', fontSize: '0.65rem' }}>Out of Coverage Review</span>
                        )}
                      </div>
                    </td>
                    <td data-label="Customer">{o.profiles?.name || o.sender_name}</td>
                    <td data-label="Route" className="text-sm">{o.origin} → {o.destination}</td>
                    <td data-label="Weight">{o.actual_weight ? `${o.actual_weight} kg` : '—'}</td>
                    <td data-label="Cost" className="fw-600">{isOrderPriced(o) ? `₱${parseFloat(o.shipping_cost || 0).toFixed(2)}` : '—'}</td>
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
