import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getOrders } from '../../lib/database';
import useNetworkRecovery from '../../hooks/useNetworkRecovery';
import useRealtimeOrders from '../../hooks/useRealtimeOrders';
import StatusBadge from '../../components/ui/StatusBadge';
import { SkeletonOrderCard } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import PageTransition, { StaggerItem } from '../../components/ui/PageTransition';
import PullToRefresh from '../../components/ui/PullToRefresh';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import Pagination from '../../components/ui/Pagination';
import { Search, Package, AlertCircle, MapPin, ChevronRight, Container, Weight } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDate } from '../../utils/datetime';
import { formatMoney } from '../../utils/currencyInput';
import { CUSTOMER_ORDER_FILTERS, isOrderPriced } from '../../constants/status';

// One chip per GROUP, not one per internal status. See CUSTOMER_ORDER_FILTERS.
const filterOptions = CUSTOMER_ORDER_FILTERS.map(f => ({ value: f.value, label: f.label }));
const statusesFor = (value) =>
  CUSTOMER_ORDER_FILTERS.find(f => f.value === value)?.statuses ?? null;
const ITEMS_PER_PAGE = 10;

const fmtDate = (iso) => {
  if (!iso) return '—';
  return formatPhDate(iso);
};

const OrdersPage = () => {
  usePageTitle('My Bookings');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const refreshOrders = useCallback(() => {
    if (!user) return;
    loadOrders(true);
  }, [user]);

  useNetworkRecovery(refreshOrders);

  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    loadOrders(isMounted);
    return () => { isMounted = false; };
  }, [user]);

  // Live updates: an admin advancing a status, assigning a trip, or a payment
  // webhook landing all change rows in `orders` out from under whatever the
  // customer already has on screen. Without this the list only ever refreshes
  // on mount, network recovery, or a manual pull-to-refresh — RLS scopes the
  // subscription to this customer's own rows, same as every other list here.
  useRealtimeOrders({
    enabled: Boolean(user?.id),
    channelName: 'customer_orders_list',
    userId: user?.id,
    debounceMs: 1000,
    onBatch: refreshOrders,
  });

  const loadOrders = async (isMounted = true) => {
    setError(null);
    setLoading(true);
    try {
      const data = await getOrders(user.id, false);
      if (isMounted) setOrders(data || []);
    } catch (err) {
      if (isMounted) setError(err.message || 'Failed to load orders.');
    } finally {
      if (isMounted) setLoading(false);
    }
  };

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setCurrentPage(1);
  };

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setCurrentPage(1);
  };

  const activeStatuses = statusesFor(activeTab);

  const filtered = orders.filter(o => {
    if (activeStatuses && !activeStatuses.includes(o.status)) return false;
    if (search) {
      const q = search.toLowerCase();
      const matchTracking = o.tracking_number?.toLowerCase().includes(q);
      const matchSender = o.sender_name?.toLowerCase().includes(q);
      const matchReceiver = o.receiver_name?.toLowerCase().includes(q);
      const matchOrigin = o.origin?.toLowerCase().includes(q);
      const matchDest = o.destination?.toLowerCase().includes(q);
      if (!(matchTracking || matchSender || matchReceiver || matchOrigin || matchDest)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  // Keep the UI valid immediately when a refresh removes the current page.
  // The effect below persists the clamped value for subsequent interactions.
  const visiblePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const paginatedOrders = filtered.slice(
    (visiblePage - 1) * ITEMS_PER_PAGE,
    visiblePage * ITEMS_PER_PAGE
  );

  return (
    <PullToRefresh onRefresh={() => loadOrders(true)}>
      <PageTransition className="customer-orders-page">
      <div className="customer-page-heading">
        <div>
          <h1 className="fw-800 mb-4">My Bookings</h1>
          <p className="text-sm text-secondary">Search, filter, and follow every shipment.</p>
        </div>
        {!loading && <span className="badge badge-info">{filtered.length} shown</span>}
      </div>
      <StaggerItem className="search-box customer-orders-search mb-16" role="search" delay={0}>
        <Search size={16} className="search-icon" aria-hidden="true" />
        <input
          id="customer-orders-search"
          name="qbookings"
          aria-label="Search bookings"
          placeholder="Search tracking, sender, receiver, destination..."
          value={search}
          onChange={handleSearchChange}
        />
      </StaggerItem>
      <StaggerItem className="mb-16" delay={60}>
        <ResponsiveFilterControls
          options={filterOptions}
          value={activeTab}
          onChange={handleTabChange}
          ariaLabel="Booking status filters"
          label="Status"
          desktopClassName="tabs customer-order-tabs"
        />
      </StaggerItem>
      {loading ? (
        <div>
          {[0, 1, 2].map(i => (
            <StaggerItem key={i} delay={(i + 2) * 60} className="mb-12">
              <SkeletonOrderCard />
            </StaggerItem>
          ))}
        </div>
      ) : error ? (
        <div className="card animate-scale-in text-center" role="alert" style={{ padding: 40 }}>
          <div className="flex items-center justify-center mx-auto mb-16" style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--error-bg)' }}>
            <AlertCircle size={28} color="var(--error)" aria-hidden="true" />
          </div>
          <h3 className="mb-8" style={{ color: 'var(--error-dark)' }}>Error Loading Bookings</h3>
          <p className="text-secondary text-sm mb-20">{error}</p>
          <button type="button" className="btn btn-primary" onClick={() => loadOrders()}>Retry</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="animate-scale-in">
          <EmptyState
            icon={Package}
            title={search || activeTab !== 'all' ? 'No bookings found' : 'No Bookings Yet'}
            description={search || activeTab !== 'all' ? 'Try adjusting your search or filter criteria.' : 'Book your first shipment to get started!'}
            actionLabel={!search && activeTab === 'all' ? 'Book Shipment' : undefined}
            onAction={!search && activeTab === 'all' ? () => navigate('/customer/book') : undefined}
          />
        </div>
      ) : (
        <>
          {paginatedOrders.map((order, index) => (
            <StaggerItem key={order.id} delay={(index + 2) * 60} className="mb-12">
              <Link to={`/customer/orders/${order.id}`} className="customer-order-list-card customer-shipment-card-v2 card card-interactive block text-no-underline" style={{ color: 'inherit' }}>
                <div className="card-body p-16">
                  <div className="customer-list-card-top">
                    <div className="flex flex-col min-width-0">
                      <span className="customer-list-card-title flex items-center gap-6"><Package size={14} className="text-tertiary" aria-hidden="true" />{order.tracking_number}</span>
                      <span className="customer-list-card-booked-date">Booked: {fmtDate(order.created_at)}</span>
                    </div>
                    <div className="flex items-center gap-8 flex-shrink-0">
                      <StatusBadge status={order.status} size="sm" />
                      <ChevronRight size={18} className="customer-card-chevron" />
                    </div>
                  </div>
                  <div className="customer-list-card-route-visual">
                    <span className="customer-route-node origin inline-flex items-center gap-4"><Container size={14} className="text-tertiary" aria-hidden="true" />{order.origin || 'Not set'}</span>
                    <div className="customer-route-line-wrap" aria-hidden="true">
                      <div className="customer-route-line">
                        <div className="customer-route-arrow" />
                      </div>
                    </div>
                    <span className="customer-route-node destination inline-flex items-center gap-4"><MapPin size={14} className="text-tertiary" aria-hidden="true" />{order.destination || 'Not set'}</span>
                  </div>
                  <div className="customer-list-card-footer flex items-center justify-between gap-8 flex-wrap">
                    <span className="inline-flex items-center gap-6 text-sm">To: {order.receiver_name || 'Receiver'}</span>
                    <span className="flex items-center gap-6">
                      {order.actual_weight && <span className="chip chip-info inline-flex items-center gap-4"><Weight size={12} aria-hidden="true" />{order.actual_weight}kg</span>}
                      <span className="chip chip-success">{isOrderPriced(order) ? formatMoney(parseFloat(order.shipping_cost || 0)) : 'Priced at pickup'}</span>
                    </span>
                  </div>
                </div>
              </Link>
            </StaggerItem>
          ))}

          {filtered.length > ITEMS_PER_PAGE && (
            <div className="mt-16 flex justify-center">
              <Pagination
                totalItems={filtered.length}
                currentPage={visiblePage}
                itemsPerPage={ITEMS_PER_PAGE}
                onPageChange={setCurrentPage}
              />
            </div>
          )}
        </>
      )}
    </PageTransition>
    </PullToRefresh>
  );
};

export default OrdersPage;
