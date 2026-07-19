import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getOrders } from '../../lib/database';
import useNetworkRecovery from '../../hooks/useNetworkRecovery';
import StatusBadge from '../../components/ui/StatusBadge';
import { SkeletonOrderCard } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import PageTransition, { StaggerItem } from '../../components/ui/PageTransition';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import { Search, Package, AlertCircle, MapPin, ChevronRight } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

const tabs = ['All', 'Pending', 'In Transit', 'Delivered', 'Cancelled'];

const fmtDate = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
};

const OrdersPage = () => {
  usePageTitle('My Orders');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('All');
  const [search, setSearch] = useState('');

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

  const filtered = orders.filter(o => {
    if (activeTab !== 'All' && o.status !== activeTab) return false;
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

  return (
    <PageTransition className="customer-orders-page">
      <div className="customer-page-heading">
        <div>
          <h1 className="fw-800 mb-4">My Orders</h1>
          <p className="text-sm text-secondary">Search, filter, and follow every shipment.</p>
        </div>
        {!loading && <span className="badge badge-info">{filtered.length} shown</span>}
      </div>
      <StaggerItem className="search-box customer-orders-search mb-16" role="search" delay={0}>
        <Search size={16} className="search-icon" aria-hidden="true" />
        <input
          aria-label="Search orders"
          placeholder="Search tracking, sender, receiver, destination..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </StaggerItem>
      <StaggerItem className="mb-16" delay={60}>
        <ResponsiveFilterControls
          options={tabs.map(t => ({ value: t, label: t }))}
          value={activeTab}
          onChange={setActiveTab}
          ariaLabel="Order status filters"
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
          <h3 className="mb-8" style={{ color: 'var(--error-dark)' }}>Error Loading Orders</h3>
          <p className="text-secondary text-sm mb-20">{error}</p>
          <button type="button" className="btn btn-primary" onClick={() => loadOrders()}>Retry</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="animate-scale-in">
          <EmptyState
            icon={Package}
            title={search || activeTab !== 'All' ? 'No orders found' : 'No Orders Yet'}
            description={search || activeTab !== 'All' ? 'Try adjusting your search or filter criteria.' : 'Book your first shipment to get started!'}
            actionLabel={!search && activeTab === 'All' ? 'Book Shipment' : undefined}
            onAction={!search && activeTab === 'All' ? () => navigate('/customer/book') : undefined}
          />
        </div>
      ) : (
        filtered.map((order, index) => (
          <StaggerItem key={order.id} delay={(index + 2) * 60} className="mb-12">
            <Link to={`/customer/orders/${order.id}`} className="customer-order-list-card customer-shipment-card-v2 card card-interactive block text-no-underline" style={{ color: 'inherit' }}>
              <div className="card-body p-16">
                <div className="customer-list-card-top">
                  <div className="flex flex-col min-width-0">
                    <span className="customer-list-card-title">{order.tracking_number}</span>
                    <span className="customer-list-card-booked-date">Booked: {fmtDate(order.created_at)}</span>
                  </div>
                  <div className="flex items-center gap-8 flex-shrink-0">
                    <StatusBadge status={order.status} size="sm" />
                    <ChevronRight size={18} className="customer-card-chevron" />
                  </div>
                </div>
                <div className="customer-list-card-route-visual">
                  <span className="customer-route-node origin">{order.origin || 'Not set'}</span>
                  <div className="customer-route-line-wrap" aria-hidden="true">
                    <div className="customer-route-line">
                      <div className="customer-route-arrow" />
                    </div>
                  </div>
                  <span className="customer-route-node destination">{order.destination || 'Not set'}</span>
                </div>
                <div className="customer-list-card-footer">
                  <span>To: {order.receiver_name || 'Receiver'}</span>
                  <span className="customer-list-card-price">₱{parseFloat(order.shipping_cost || 0).toFixed(2)}</span>
                </div>
              </div>
            </Link>
          </StaggerItem>
        ))
      )}
    </PageTransition>
  );
};

export default OrdersPage;
