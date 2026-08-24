import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, AlertTriangle, Banknote, CalendarClock, ChevronRight,
  ExternalLink, Loader, MessageCircle, Package, Receipt, ShieldCheck,
  Smartphone, X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getOrders, getPaymentTransactionsBatch } from '../../lib/database';
import EmptyState from '../../components/ui/EmptyState';
import CustomSelect from '../../components/ui/CustomSelect';
import FocusTrap from '../../components/ui/FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { outstandingBalance } from '../../constants/status';
import {
  formatPaymentType, formatPaymentMethod as fmtMethod, formatRecordedBy,
  getPaymentStatusDisplay, getCustomerVisibleRef, getCustomerFriendlyNotes,
} from '../../utils/paymentDisplay';

// Peso sign, like every other money figure in the app. This page was the one
// place still printing a bare currency CODE ("PHP 1,200.00") instead of the ₱
// the rest of the product uses — the odd one out on the only screen a customer
// opens specifically to read amounts.
const formatMoney = (value) =>
  `₱${Number(value || 0).toLocaleString('en-PH', {
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

/** "Aug 12" — the row is already grouped under a month, so the year is noise. */
const formatRowDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
};

const formatDateTime = (value) => {
  if (!value) return 'Not recorded';
  return new Date(value).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

const methodLabel = (method) => {
  if (method === 'gcash') return 'GCash';
  if (method === 'paylater') return 'Pay Later';
  if (method === 'cash') return 'Cash';
  return method || 'Not recorded';
};

/** A payment's month bucket, as a sortable `YYYY-MM` key. */
const monthKey = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (key) => {
  const [year, month] = key.split('-');
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
};

const paymentOptions = [
  { title: 'GCash', icon: Smartphone, tone: 'info', detail: 'Pay through the secure GCash flow when staff sends a payment request.' },
  { title: 'Cash', icon: Banknote, tone: 'success', detail: 'Pay the cargo handler directly at pickup or delivery.' },
  { title: 'Pay Later', icon: CalendarClock, tone: 'warning', detail: 'Downpayment now, with a promised payment date.' },
];

/**
 * The full record for one payment, on demand.
 *
 * The compact row deliberately carries three facts — date, amount, status —
 * because those are what a customer scans a statement for. Everything else
 * about a payment is a lookup, not a scan, so it lives here and costs a tap.
 */
const PaymentDetailModal = ({ tx, onClose, onViewOrder }) => {
  useScrollLock(Boolean(tx));

  useEffect(() => {
    if (!tx) return undefined;
    const onEscape = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [tx, onClose]);

  if (!tx) return null;

  const statusInfo = getPaymentStatusDisplay(tx.payment_status);
  const customerRef = getCustomerVisibleRef(tx.transaction_reference);
  const friendlyNotes = getCustomerFriendlyNotes(tx.notes, tx.admin_name);

  const rows = [
    ['Order', tx.order?.tracking_number || 'Not linked'],
    ['Payment type', formatPaymentType(tx.payment_type)],
    ['Method', fmtMethod(tx.payment_method)],
    ['Date recorded', formatDateTime(tx.payment_date || tx.created_at)],
    // Only a reference the customer can actually cross-check against their own
    // receipt is shown; getCustomerVisibleRef drops PayMongo's internal ids,
    // which are unmatchable to anything the customer holds.
    ...(customerRef ? [['Reference', customerRef]] : []),
    ['Recorded by', formatRecordedBy(tx.admin_name, 'customer')],
  ];

  // Portalled to body: every page sits inside <PageTransition>, whose transform
  // makes a stacking context that would trap a fixed overlay beneath the
  // bottom nav. Same reasoning as ConfirmModal.
  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-detail-title"
      >
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
          <div className="modal-header">
            <h3 id="payment-detail-title" className="flex items-center gap-8">
              <Receipt size={20} aria-hidden="true" /> Payment Details
            </h3>
            <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Close payment details">
              <X size={20} />
            </button>
          </div>

          <div className="modal-body">
            <div className="payment-detail-hero">
              <div className="payment-detail-amount">{formatMoney(tx.amount)}</div>
              <span className={`badge badge-${statusInfo.tone}`}>{statusInfo.label}</span>
            </div>

            <dl className="payment-detail-grid">
              {rows.map(([label, value]) => (
                <div className="payment-detail-row" key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>

            {friendlyNotes && (
              <p className="text-sm text-secondary payment-detail-notes">{friendlyNotes}</p>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
            {tx.order?.id && (
              <button type="button" className="btn btn-primary" onClick={() => onViewOrder(tx.order.id)}>
                <ExternalLink size={15} /> View Order
              </button>
            )}
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body,
  );
};

const PaymentHistoryPage = () => {
  usePageTitle('Payment History');
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(() => monthKey(new Date()));
  const [openTx, setOpenTx] = useState(null);

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
        // The month filter is only honest if the months it offers are backed by
        // the payments actually loaded. The previous 30-order / 12-transaction
        // caps existed because the list rendered everything it held; with a
        // month picker in front of it, those caps would have made any month
        // beyond the last dozen payments read as empty rather than as
        // unloaded. The ceiling here is a URL-length guard on the batched
        // `.in()`, not a display limit.
        const recentOrders = safeOrders.slice(0, 200);
        const txMap = await getPaymentTransactionsBatch(recentOrders.map(order => order.id));

        if (!isMounted) return;
        setOrders(safeOrders);
        setTransactions(
          recentOrders
            .flatMap(order => (txMap[order.id] || []).map(tx => ({ ...tx, order })))
            .sort((a, b) => new Date(b.payment_date || b.created_at) - new Date(a.payment_date || a.created_at))
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
      .filter(order => outstandingBalance(order) > 0)
      .sort((a, b) => outstandingBalance(b) - outstandingBalance(a));

    return {
      activeCount: activeOrders.length,
      outstandingOrders,
      outstandingTotal: outstandingOrders.reduce((sum, order) => sum + outstandingBalance(order), 0),
      paidTotal: activeOrders.reduce((sum, order) => sum + Number(order.amount_paid || 0), 0),
    };
  }, [orders]);

  /**
   * Every month that has a payment, newest first, with the current month
   * always present.
   *
   * The current month is included even when it is empty because it is the
   * default view: a dropdown whose selected value is missing from its own
   * option list renders as the first option instead, which would silently
   * show some arbitrary older month as though it were today's.
   */
  const monthOptions = useMemo(() => {
    const counts = new Map();
    for (const tx of transactions) {
      const key = monthKey(tx.payment_date || tx.created_at);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const current = monthKey(new Date());
    if (!counts.has(current)) counts.set(current, 0);
    return [...counts.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, count]) => ({ key, count, label: monthLabel(key) }));
  }, [transactions]);

  const visibleTransactions = useMemo(
    () => transactions.filter(tx => monthKey(tx.payment_date || tx.created_at) === selectedMonth),
    [transactions, selectedMonth],
  );

  const monthTotal = useMemo(
    () => visibleTransactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
    [visibleTransactions],
  );

  return (
    <div className="page-transition customer-payment-history-page">
      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>

      <div className="customer-page-heading mb-20">
        <div>
          <h1 className="fw-800 flex items-center gap-8">
            <Receipt size={24} aria-hidden="true" /> Payment History
          </h1>
          <p className="text-sm text-secondary mt-4">
            Every payment recorded on your shipments, plus anything still owing.
          </p>
        </div>
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
                  <div className="flex justify-between gap-12 items-start flex-wrap">
                    <div>
                      <div className="fw-800">{order.tracking_number}</div>
                      <div className="text-xs text-tertiary mt-4">
                        {methodLabel(order.payment_method)} | {order.payment_status || 'unpaid'}
                        {order.promised_payment_date ? ` | Due ${formatDate(order.promised_payment_date)}` : ''}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-tertiary">Balance</div>
                      <div className="fw-800 text-error">{formatMoney(outstandingBalance(order))}</div>
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

          {/* ── Recent Payments ───────────────────────────────────── */}
          <div className="payment-list-header">
            <h3 className="profile-section-title m-0">Recent Payments</h3>
            <CustomSelect
              id="payment-month-filter"
              className="form-select payment-month-select"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              aria-label="Filter payments by month"
            >
              {monthOptions.map(option => (
                <option key={option.key} value={option.key}>
                  {option.label}{option.count > 0 ? ` (${option.count})` : ''}
                </option>
              ))}
            </CustomSelect>
          </div>

          {visibleTransactions.length === 0 ? (
            <div className="card card-body text-sm text-secondary">
              No payments were recorded in {monthLabel(selectedMonth)}.
            </div>
          ) : (
            <>
              <div className="card payment-list">
                {visibleTransactions.map(tx => {
                  const statusInfo = getPaymentStatusDisplay(tx.payment_status);
                  return (
                    <button
                      type="button"
                      key={tx.id}
                      className="payment-row"
                      onClick={() => setOpenTx(tx)}
                      aria-label={`Payment of ${formatMoney(tx.amount)} on ${formatDate(tx.payment_date || tx.created_at)} — ${statusInfo.label}. View details`}
                    >
                      <span className="payment-row-date">{formatRowDate(tx.payment_date || tx.created_at)}</span>
                      <span className="payment-row-amount">{formatMoney(tx.amount)}</span>
                      <span className={`badge badge-${statusInfo.tone} badge-sm payment-row-pill`}>{statusInfo.label}</span>
                      <ChevronRight size={16} className="payment-row-chevron" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              <div className="payment-list-total">
                <span>{visibleTransactions.length} payment{visibleTransactions.length === 1 ? '' : 's'}</span>
                <span className="fw-800">{formatMoney(monthTotal)}</span>
              </div>
            </>
          )}

          {/* Reference, not the headline. The page is a record of what was
              paid; how to pay is the smaller question, so it sits below the
              ledger rather than above it — and as three compact rows rather
              than three full cards, which outweighed the ledger itself. */}
          <h3 className="profile-section-title mt-16">Accepted Payment Options</h3>
          <div className="card payment-options-card">
            {paymentOptions.map(option => (
              <div className="payment-option-row" key={option.title}>
                <div className={`profile-menu-icon-wrap ${option.tone}`}>
                  <option.icon size={18} />
                </div>
                <div>
                  <div className="fw-700 text-sm">{option.title}</div>
                  <p className="text-xs text-secondary m-0">{option.detail}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-2 gap-12 mt-16">
            <button type="button" className="btn btn-primary justify-center" onClick={() => navigate('/customer/orders')}>
              <Package size={16} /> View All Orders
            </button>
            <button type="button" className="btn btn-outline justify-center" onClick={() => navigate('/customer/support')}>
              <MessageCircle size={16} /> Ask About a Payment
            </button>
          </div>

          {/* Was a full info banner above the summary cards. It is a standing
              reassurance, not news, so it reads as small print at the foot of
              the statement instead of as the first thing on the page. */}
          <p className="payment-security-note">
            <ShieldCheck size={14} aria-hidden="true" />
            CargoExpress PH does not store card or wallet credentials. Payments are recorded per order for traceability.
          </p>
        </>
      )}

      <PaymentDetailModal
        tx={openTx}
        onClose={() => setOpenTx(null)}
        onViewOrder={(orderId) => { setOpenTx(null); navigate(`/customer/orders/${orderId}`); }}
      />
    </div>
  );
};

export default PaymentHistoryPage;
