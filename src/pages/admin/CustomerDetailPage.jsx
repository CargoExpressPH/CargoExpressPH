import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getCustomerById } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import { CenteredSpinner } from '../../components/ui/Loader';
import { Package } from 'lucide-react';
import EmptyState from '../../components/ui/EmptyState';
import MessageCustomerButton from '../../components/ui/MessageCustomerButton';
import Breadcrumb from '../../components/ui/Breadcrumb';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDate } from '../../utils/datetime';
import { buildProfileAddress } from '../../lib/address';
import { formatMoney } from '../../utils/currencyInput';
import { isOrderPriced } from '../../constants/status';

const CustomerDetailPage = () => {
  usePageTitle('Customer Details');
  const { id } = useParams();
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;
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

  return (
    <div className="page-transition">
      <h1 className="sr-only">Customer Details</h1>
      <Breadcrumb items={[
        { label: 'Dashboard', to: '/admin' },
        { label: 'Customers', to: '/admin/customers' },
        { label: customer.name },
      ]} />
      {/* Identity as a plain record, not a profile banner.
          The green banner + centred avatar spent ~200px of every viewport on a
          decorative header and a letter, then crammed email, phone and a
          truncated province into two grey subtitle lines. An admin opens this
          screen to read those details or to act on them, so they are a
          label/value list — scannable, full-width, and identical on phone,
          tablet and desktop.

          Message sits in the header rather than at the foot of the list: it is
          the one ACTION on a screen that is otherwise all reference, and this
          is the first place an admin looks when they want to talk to someone. */}
      <div className="card stagger-item mb-16">
        <div className="card-body">
          <div className="customer-detail-head">
            <h2 className="customer-detail-name">{customer.name}</h2>
            <MessageCustomerButton customerId={customer.id} customerName={customer.name} showLabel />
          </div>

          <dl className="customer-detail-list">
            <div className="customer-detail-row">
              <dt>Email</dt>
              <dd>
                {customer.email
                  ? <a href={`mailto:${customer.email}`}>{customer.email}</a>
                  : <span className="text-tertiary">—</span>}
              </dd>
            </div>
            <div className="customer-detail-row">
              <dt>Phone</dt>
              <dd>
                {/* href is stripped to digits (keeping a leading +) because a
                    stored number may carry spaces or dashes, and tel: treats
                    those as part of the number on some dialers. The visible
                    text keeps whatever the customer actually entered. */}
                {customer.phone
                  ? <a href={`tel:${String(customer.phone).replace(/(?!^\+)[^\d]/g, '')}`}>{customer.phone}</a>
                  : <span className="text-tertiary">—</span>}
              </dd>
            </div>
            <div className="customer-detail-row">
              <dt>Address</dt>
              <dd>{buildProfileAddress(customer) || <span className="text-tertiary">No address on file</span>}</dd>
            </div>
            <div className="customer-detail-row">
              <dt>Date Joined</dt>
              <dd>{formatPhDate(customer.created_at)}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="grid grid-4 mb-16">
        {[
          { l: 'Total Bookings', v: summary.totalOrders, tone: 'primary' },
          { l: 'Completed', v: summary.completedOrders, tone: 'success' },
          { l: 'Pending', v: summary.pendingOrders, tone: 'warning' },
          { l: 'Total Spent', v: summary.totalSpent, tone: 'accent', prefix: '₱', decimals: 0 }
        ].map((s, i) => (
          <div key={i} className={`stat-card stat-card-${s.tone} stagger-item`} style={{ animationDelay: `${(i + 1) * 60}ms` }}>
            <div className="stat-value">
              <AnimatedCounter value={typeof s.v === 'number' ? s.v : 0} prefix={s.prefix || ''} decimals={s.decimals || 0} duration={1200} />
            </div>
            <div className="stat-label">{s.l}</div>
          </div>
        ))}
      </div>
      <div className="card admin-section-card admin-table-card stagger-item" style={{ animationDelay: '360ms' }}>
        <div className="card-header"><h3>Order History</h3></div>
        <div className="table-container">
          <table className="data-table">
            <thead><tr><th scope="col">Tracking</th><th scope="col">Route</th><th scope="col">Cost</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
            <tbody>
              {orders.map(o=>(
                <tr key={o.id}><td data-label="Tracking"><Link to={`/admin/orders/${o.id}`} className="fw-700 text-accent">{o.tracking_number}</Link></td><td data-label="Route" className="text-sm">{o.origin} → {o.destination}</td>
                <td data-label="Cost">{isOrderPriced(o) ? formatMoney(parseFloat(o.shipping_cost || 0)) : '—'}</td><td data-label="Status"><StatusBadge status={o.status} size="sm"/></td>
                <td data-label="Date" className="text-xs text-secondary">{formatPhDate(o.created_at)}</td></tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-state-cell">
                    <EmptyState
                      icon={Package}
                      title="No orders found"
                      description="This customer has not placed any cargo orders yet."
                      className="empty-state-compact"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
export default CustomerDetailPage;
