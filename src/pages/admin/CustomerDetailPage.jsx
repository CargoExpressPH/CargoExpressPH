import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getCustomerById } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import { CenteredSpinner } from '../../components/ui/Loader';
import { Package, Mail, Phone, MapPin, CalendarDays, CheckCircle2, Clock, Wallet } from 'lucide-react';
import EmptyState from '../../components/ui/EmptyState';
import MessageCustomerButton from '../../components/ui/MessageCustomerButton';
import Breadcrumb from '../../components/ui/Breadcrumb';
import Pagination from '../../components/ui/Pagination';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDate } from '../../utils/datetime';
import { buildProfileAddress } from '../../lib/address';
import { formatMoney } from '../../utils/currencyInput';
import { isOrderPriced } from '../../constants/status';
import { rowLinkProps } from '../../utils/rowLink';

const initialsOf = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

const CustomerDetailPage = () => {
  usePageTitle('Customer Details');
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);

  useEffect(() => {
    let isMounted = true;
    setPage(1);
    load(isMounted);
    return () => { isMounted = false; };
  }, [id]);

  const load = async (isMounted = true) => {
    setError(null);
    setLoading(true);
    try {
      const result = await getCustomerById(id);
      if (isMounted) setData(result);
    } catch(e) {
      if (isMounted) setError(e.message || 'Failed to load customer.');
    } finally {
      if (isMounted) setLoading(false);
    }
  };

  if (loading) return <CenteredSpinner />;
  if (error) return (
    <div className="page-transition">
      <div className="card text-center admin-error-card p-40">
        <h3>Error Loading Customer</h3>
        <p className="mt-8 mb-20">{error}</p>
        <button type="button" className="btn btn-primary" onClick={() => load()}>Retry</button>
      </div>
    </div>
  );
  if (!data) return <div className="empty-state"><h3>Customer not found</h3></div>;
  const { customer, orders, summary } = data;
  const pagedOrders = orders.slice((page - 1) * perPage, page * perPage);
  const address = buildProfileAddress(customer);

  const stats = [
    { l: 'Total Bookings', v: summary.totalOrders, tone: 'primary', icon: Package },
    { l: 'Completed', v: summary.completedOrders, tone: 'success', icon: CheckCircle2 },
    { l: 'Pending', v: summary.pendingOrders, tone: 'warning', icon: Clock },
    { l: 'Total Spent', v: summary.totalSpent, tone: 'accent', icon: Wallet, prefix: '₱', decimals: 0 },
  ];

  return (
    <div className="page-transition customer-profile-page">
      <h1 className="sr-only">Customer Details</h1>
      <Breadcrumb items={[
        { label: 'Dashboard', to: '/admin' },
        { label: 'Customers', to: '/admin/customers' },
        { label: customer.name },
      ]} />

      {/* Identity and contact details. Message sits in the header because it
          is the one ACTION on an otherwise read-only screen, and the first
          place an admin looks when they want to reach this customer. */}
      <div className="card stagger-item mb-16">
        <div className="card-body">
          <div className="customer-detail-head">
            <div className="customer-profile-identity">
              <span className="customer-profile-avatar" aria-hidden="true">{initialsOf(customer.name)}</span>
              <div className="customer-profile-name-block">
                <h2 className="customer-detail-name">{customer.name}</h2>
                <p className="customer-profile-since">
                  Customer since {formatPhDate(customer.created_at)}
                  {' · '}
                  {summary.totalOrders} booking{summary.totalOrders === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <MessageCustomerButton customerId={customer.id} customerName={customer.name} showLabel />
          </div>

          <dl className="customer-profile-facts">
            <div className="customer-profile-fact">
              <span className="customer-profile-fact-icon" aria-hidden="true"><Mail size={16} /></span>
              <div className="customer-profile-fact-text">
                <dt>Email</dt>
                <dd>
                  {customer.email
                    ? <a href={`mailto:${customer.email}`}>{customer.email}</a>
                    : <span className="text-tertiary">Not provided</span>}
                </dd>
              </div>
            </div>
            <div className="customer-profile-fact">
              <span className="customer-profile-fact-icon" aria-hidden="true"><Phone size={16} /></span>
              <div className="customer-profile-fact-text">
                <dt>Phone</dt>
                <dd>
                  {/* href is stripped to digits (keeping a leading +) because a
                      stored number may carry spaces or dashes, and tel: treats
                      those as part of the number on some dialers. The visible
                      text keeps whatever the customer actually entered. */}
                  {customer.phone
                    ? <a href={`tel:${String(customer.phone).replace(/(?!^\+)[^\d]/g, '')}`}>{customer.phone}</a>
                    : <span className="text-tertiary">Not provided</span>}
                </dd>
              </div>
            </div>
            <div className="customer-profile-fact">
              <span className="customer-profile-fact-icon" aria-hidden="true"><MapPin size={16} /></span>
              <div className="customer-profile-fact-text">
                <dt>Address</dt>
                <dd>{address || <span className="text-tertiary">No address on file</span>}</dd>
              </div>
            </div>
            <div className="customer-profile-fact">
              <span className="customer-profile-fact-icon" aria-hidden="true"><CalendarDays size={16} /></span>
              <div className="customer-profile-fact-text">
                <dt>Date Joined</dt>
                <dd>{formatPhDate(customer.created_at)}</dd>
              </div>
            </div>
          </dl>
        </div>
      </div>

      <div className="grid grid-4 mb-16 customer-profile-stats">
        {stats.map((s, i) => (
          <div key={s.l} className={`stat-card stat-card-${s.tone} stagger-item`} style={{ animationDelay: `${(i + 1) * 60}ms` }}>
            <div className="stat-icon"><s.icon size={20} aria-hidden="true" /></div>
            <div className="stat-value">
              <AnimatedCounter value={typeof s.v === 'number' ? s.v : 0} prefix={s.prefix || ''} decimals={s.decimals || 0} duration={1200} />
            </div>
            <div className="stat-label">{s.l}</div>
          </div>
        ))}
      </div>

      <div className="card admin-section-card admin-table-card stagger-item" style={{ animationDelay: '360ms' }}>
        <div className="card-header">
          <h3>Order History</h3>
          {orders.length > 0 && <span className="text-sm text-secondary">{orders.length} total</span>}
        </div>
        {orders.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No orders found"
            description="This customer has not placed any cargo orders yet."
            className="empty-state-compact"
          />
        ) : (
          <>
            <div className="table-container">
              <table className="data-table data-table--compact">
                <caption className="sr-only">Bookings placed by {customer.name}</caption>
                <thead><tr><th scope="col">Tracking</th><th scope="col">Route</th><th scope="col">Cost</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
                <tbody>
                  {pagedOrders.map(o => (
                    <tr key={o.id} {...rowLinkProps(navigate, `/admin/orders/${o.id}`)}>
                      <td data-label="Tracking"><Link to={`/admin/orders/${o.id}`} className="fw-700 text-accent">{o.tracking_number}</Link></td>
                      <td data-label="Route" className="text-sm">{o.origin} → {o.destination}</td>
                      <td data-label="Cost">{isOrderPriced(o) ? formatMoney(parseFloat(o.shipping_cost || 0)) : '—'}</td>
                      <td data-label="Status"><StatusBadge status={o.status} size="sm" /></td>
                      <td data-label="Date" className="text-xs text-secondary">{formatPhDate(o.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              totalItems={orders.length}
              currentPage={page}
              itemsPerPage={perPage}
              onPageChange={setPage}
              onPerPageChange={(n) => { setPerPage(n); setPage(1); }}
            />
          </>
        )}
      </div>
    </div>
  );
};
export default CustomerDetailPage;
