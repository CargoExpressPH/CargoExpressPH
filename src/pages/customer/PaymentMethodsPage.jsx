import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, AlertTriangle, Banknote, CalendarClock, CheckCircle2,
  CreditCard, ExternalLink, Loader, MessageCircle, Package, Receipt,
  Smartphone,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getOrders, getPaymentTransactionsBatch } from '../../lib/database';
import EmptyState from '../../components/ui/EmptyState';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';

const formatMoney = (value) =>
  `PHP ${Number(value || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatDate = (value) => {
  if (!value) return 'Not set';
  return new Date(value).toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

const methodLabel = (method) => {
  if (method === 'gcash') return 'GCash';
  if (method === 'paylater') return 'Pay Later';
  if (method === 'cash') return 'Cash';
  return method || 'Not recorded';
};

const paymentOptions = [
  {
    title: 'GCash',
    icon: Smartphone,
    tone: 'info',
    detail: 'Pay through the secure GCash flow when staff sends the payment request for pickup, delivery, or balance settlement.',
  },
  {
    title: 'Cash',
    icon: Banknote,
    tone: 'success',
    detail: 'Pay the cargo handler directly during pickup or delivery. The receipt is recorded on your order after collection.',
  },
  {
    title: 'Pay Later',
    icon: CalendarClock,
    tone: 'warning',
    detail: 'Use a downpayment and promised payment date when the shipment is approved for partial payment.',
  },
];

const PaymentMethodsPage = () => {
  usePageTitle('Payment Methods');
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let isMounted = true;

    const loadPayments = async () => {
      if (!user?.id) return;
      setLoading(true);
      setError('');

      try {
        // C-3 fix: Use batch query instead of N+1 waterfall
        const LOAD_TIMEOUT_MS = 15000;
        const data = await Promise.race([
          getOrders(user.id, false),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Loading timed out. Please try again.')), LOAD_TIMEOUT_MS)),
        ]);
        const safeOrders = data || [];
        const recentOrders = safeOrders.slice(0, 30);
        const orderIds = recentOrders.map(order => order.id);
        const txMap = await getPaymentTransactionsBatch(orderIds);

        if (!isMounted) return;
        setOrders(safeOrders);
        setTransactions(
          recentOrders
            .flatMap(order => (txMap[order.id] || []).map(tx => ({ ...tx, order })))
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 12)
        );
      } catch (err) {
        if (!isMounted) return;
        setError(err?.message || 'Failed to load payment information.');
        toast.error('Failed to load payment information.');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    loadPayments();
    return () => { isMounted = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => {
    const activeOrders = orders.filter(order => order.status !== 'Cancelled');
    const outstandingOrders = activeOrders
      .filter(order => Number(order.remaining_balance || 0) > 0)
      .sort((a, b) => Number(b.remaining_balance || 0) - Number(a.remaining_balance || 0));

    return {
      activeCount: activeOrders.length,
      outstandingOrders,
      outstandingTotal: outstandingOrders.reduce((sum, order) => sum + Number(order.remaining_balance || 0), 0),
      paidTotal: activeOrders.reduce((sum, order) => sum + Number(order.amount_paid || 0), 0),
    };
  }, [orders]);

  return (
    <div className="page-transition customer-payment-methods-page">
      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>

      <div className="customer-page-heading mb-20">
        <div>
          <h1 className="fw-800 flex items-center gap-8">
            <CreditCard size={24} aria-hidden="true" /> Payment Methods
          </h1>
          <p className="text-sm text-secondary mt-4">
            Review accepted payment options, open balances, and recent receipts.
          </p>
        </div>
      </div>

      <div className="alert-banner alert-banner-info mb-16">
        <CheckCircle2 size={16} />
        CargoExpress PH does not store card or wallet credentials in your profile. Payments are recorded per order for traceability.
      </div>

      {loading ? (
        <div className="card card-body flex items-center justify-center gap-8" role="status" aria-live="polite">
          <Loader size={18} className="animate-spin" /> Loading payment center...
        </div>
      ) : error ? (
        <div className="card card-body">
          <div className="alert-banner alert-banner-error">
            <AlertTriangle size={16} /> {error}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-3 gap-12 mb-16">
            <div className="card card-body">
              <div className="text-xs text-tertiary">Outstanding Balance</div>
              <div className="text-xl fw-800 text-error mt-4">{formatMoney(summary.outstandingTotal)}</div>
            </div>
            <div className="card card-body">
              <div className="text-xs text-tertiary">Total Paid</div>
              <div className="text-xl fw-800 text-success mt-4">{formatMoney(summary.paidTotal)}</div>
            </div>
            <div className="card card-body">
              <div className="text-xs text-tertiary">Active Orders</div>
              <div className="text-xl fw-800 text-accent mt-4">{summary.activeCount}</div>
            </div>
          </div>

          <h3 className="profile-section-title">Accepted Options</h3>
          <div className="grid grid-3 gap-12 mb-16">
            {paymentOptions.map(option => (
              <div className="card card-body" key={option.title}>
                <div className={`profile-menu-icon-wrap ${option.tone} mb-12`}>
                  <option.icon size={18} />
                </div>
                <div className="fw-800 mb-6">{option.title}</div>
                <p className="text-sm text-secondary m-0">{option.detail}</p>
              </div>
            ))}
          </div>

          <h3 className="profile-section-title">Open Balances</h3>
          {summary.outstandingOrders.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No Open Balances"
              description="You do not have any unpaid or partially paid orders right now."
            />
          ) : (
            <div className="flex flex-col gap-10 mb-16">
              {summary.outstandingOrders.slice(0, 6).map(order => (
                <div className="card card-body" key={order.id}>
                  <div className="flex justify-between gap-12" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div>
                      <div className="fw-800">{order.tracking_number}</div>
                      <div className="text-xs text-tertiary mt-4">
                        {methodLabel(order.payment_method)} | {order.payment_status || 'unpaid'}
                        {order.promised_payment_date ? ` | Due ${formatDate(order.promised_payment_date)}` : ''}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-tertiary">Balance</div>
                      <div className="fw-800 text-error">{formatMoney(order.remaining_balance)}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm mt-12"
                    onClick={() => navigate(`/customer/orders/${order.id}`)}
                  >
                    <ExternalLink size={14} /> View Order
                  </button>
                </div>
              ))}
            </div>
          )}

          <h3 className="profile-section-title">Recent Payment History</h3>
          {transactions.length === 0 ? (
            <div className="card card-body text-sm text-secondary">
              No payment receipts have been recorded yet.
            </div>
          ) : (
            <div className="table-responsive customer-payment-history-table-wrap">
              <table className="table customer-payment-history-table" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Order</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map(tx => (
                    <tr key={tx.id}>
                      <td data-label="Date">{formatDate(tx.payment_date || tx.created_at)}</td>
                      <td data-label="Order">{tx.order?.tracking_number || '-'}</td>
                      <td data-label="Type">{tx.payment_type || 'Payment'}</td>
                      <td data-label="Amount" className="fw-700 text-success">{formatMoney(tx.amount)}</td>
                      <td data-label="Method">{methodLabel(tx.payment_method)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="grid grid-2 gap-12 mt-16">
            <button type="button" className="btn btn-primary justify-center" onClick={() => navigate('/customer/orders')}>
              <Package size={16} /> View All Orders
            </button>
            <button type="button" className="btn btn-outline justify-center" onClick={() => navigate('/customer/support')}>
              <MessageCircle size={16} /> Ask About a Payment
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default PaymentMethodsPage;
