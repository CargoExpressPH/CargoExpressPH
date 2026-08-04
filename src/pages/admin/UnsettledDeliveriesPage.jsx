import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  getUnsettledOrders, recordAdditionalPayment, withTimeout, SETTLEMENT_BUCKETS,
} from '../../lib/database';
import { useAuth } from '../../contexts/AuthContext';
import { logPayment, logActivity } from '../../lib/activityLog';
import { SkeletonStatCard, SkeletonTableRow } from '../../components/ui/SkeletonLoader';
import StatusBadge from '../../components/ui/StatusBadge';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import AdditionalPaymentModal from '../../components/ui/AdditionalPaymentModal';
import PrintDocument from '../../components/ui/PrintDocument';
import { exportPrintDocumentToPdf } from '../../lib/exportPdf';
import { CheckCircle, Wallet, Printer, Download, Loader, RefreshCw } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';

const formatCurrency = (val) =>
  `₱${(parseFloat(val) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (value) => {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * How each settlement bucket is presented. `tone` is one of the semantic
 * badge classes that exist in components.css (success / warning / error /
 * info), so the list reads correctly in both themes.
 */
const BUCKET_META = {
  [SETTLEMENT_BUCKETS.OVERDUE]: {
    label: 'Overdue promise', tone: 'error',
    hint: 'The promised payment date has passed and the balance is still owing.',
  },
  [SETTLEMENT_BUCKETS.HELD]: {
    label: 'Held at hub', tone: 'warning',
    hint: 'At the destination warehouse and blocked from dispatch until the balance is settled or a promise date is recorded.',
  },
  [SETTLEMENT_BUCKETS.DELIVERED]: {
    label: 'Delivered, unpaid', tone: 'error',
    hint: 'Cargo was handed over with a balance still owing.',
  },
  [SETTLEMENT_BUCKETS.PROMISED]: {
    label: 'Promised', tone: 'info',
    hint: 'Dispatched against a promise date that has not yet come due.',
  },
  [SETTLEMENT_BUCKETS.COLLECT]: {
    label: 'Freight collect', tone: 'info',
    hint: 'Receiver pays at the door — due on delivery, not late.',
  },
  [SETTLEMENT_BUCKETS.IN_FLIGHT]: {
    label: 'In transit', tone: 'info',
    hint: 'Still moving; the balance has not reached the dispatch gate yet.',
  },
};

/**
 * UnsettledDeliveriesPage — the money side of the delivery pipeline.
 *
 * Rendered as a section of Sales & Reports rather than its own route, so all
 * financial views stay in one place. Every row here is an order the Phase 1b
 * settlement guards care about: `guard_order_update` refuses to dispatch the
 * "Held at hub" rows, and `guard_trip_completion` refuses to close a trip
 * while any of these are still attached to it.
 */
const UnsettledDeliveriesPage = () => {
  usePageTitle('Unsettled Deliveries');
  const { userProfile } = useAuth();
  const toast = useToast();

  const [orders, setOrders] = useState([]);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage, setPerPage] = useState(10);
  const [payingOrder, setPayingOrder] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { loadUnsettled(); }, []);

  const loadUnsettled = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await withTimeout(getUnsettledOrders());
      setOrders(result.orders);
      setTotals(result.totals);
      setLoadedAt(new Date());
    } catch (e) {
      setError(e.message || 'Failed to load unsettled deliveries.');
    } finally {
      setLoading(false);
    }
  };

  const filterOptions = useMemo(() => {
    const countOf = (bucket) => orders.filter(o => o.settlement_bucket === bucket).length;
    return [
      { value: 'all', label: 'All', count: orders.length },
      { value: SETTLEMENT_BUCKETS.OVERDUE, label: 'Overdue', count: countOf(SETTLEMENT_BUCKETS.OVERDUE) },
      { value: SETTLEMENT_BUCKETS.HELD, label: 'Held at hub', count: countOf(SETTLEMENT_BUCKETS.HELD) },
      { value: SETTLEMENT_BUCKETS.DELIVERED, label: 'Delivered', count: countOf(SETTLEMENT_BUCKETS.DELIVERED) },
      { value: SETTLEMENT_BUCKETS.PROMISED, label: 'Promised', count: countOf(SETTLEMENT_BUCKETS.PROMISED) },
      { value: SETTLEMENT_BUCKETS.COLLECT, label: 'Collect', count: countOf(SETTLEMENT_BUCKETS.COLLECT) },
    ];
  }, [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter(o => {
      if (filter !== 'all' && o.settlement_bucket !== filter) return false;
      if (!q) return true;
      return [o.tracking_number, o.sender_name, o.receiver_name, o.profiles?.name]
        .some(v => (v || '').toLowerCase().includes(q));
    });
  }, [orders, filter, search]);

  const filteredOutstanding = useMemo(
    () => filtered.reduce((sum, o) => sum + parseFloat(o.remaining_balance || 0), 0),
    [filtered]
  );

  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * perPage, currentPage * perPage),
    [filtered, currentPage, perPage]
  );

  useEffect(() => { setCurrentPage(1); }, [filter, search]);

  const handleRecordPayment = async (amount, method, ref, notes, date, receiptUrl) => {
    const order = payingOrder;
    await recordAdditionalPayment(order.id, amount, method, ref, notes, date, receiptUrl);
    logPayment('Balance Settled', order.id, order.tracking_number, {
      details: `${formatCurrency(amount)} collected via ${method} from the unsettled deliveries list`,
    });
    setPayingOrder(null);
    await loadUnsettled();
    toast.success(`Payment of ${formatCurrency(amount)} recorded for ${order.tracking_number}.`);
  };

  const handlePrint = () => {
    logActivity({
      module: 'Sales & Reports',
      action: 'Unsettled Deliveries Printed',
      details: `Printed ${filtered.length} unsettled delivery record(s)`,
    });
    window.print();
  };

  const handleExportPDF = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportPrintDocumentToPdf(`CargoExpress_UnsettledDeliveries_${new Date().toISOString().slice(0, 10)}.pdf`);
      logActivity({
        module: 'Sales & Reports',
        action: 'Unsettled Deliveries Exported',
        details: `Exported ${filtered.length} unsettled delivery record(s) to PDF`,
      });
    } catch (e) {
      toast.error('PDF export failed.');
    } finally {
      setExporting(false);
    }
  };

  if (error) return (
    <div className="card text-center admin-error-card p-40">
      <h3>Error</h3>
      <p>{error}</p>
      <button type="button" className="btn btn-primary mt-md" onClick={loadUnsettled}>Retry</button>
    </div>
  );

  const t = totals || {};

  return (
    <div>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">Unsettled Deliveries</h1>
          <p className="admin-page-subtitle">
            Shipments in the pipeline that still owe money — who owes it, how much, and how overdue.
          </p>
        </div>
        {!loading && (
          <div className="flex gap-8 no-print">
            <button type="button" className="btn btn-outline btn-sm" onClick={loadUnsettled}>
              <RefreshCw size={16} /> Refresh
            </button>
            <button type="button" className="btn btn-outline btn-sm" onClick={handleExportPDF} disabled={exporting || filtered.length === 0}>
              {exporting ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
              Export PDF
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handlePrint} disabled={filtered.length === 0}>
              <Printer size={16} /> Print
            </button>
          </div>
        )}
      </div>

      {/* Summary tiles */}
      <div className="grid grid-4 mb-24">
        {loading ? (
          Array.from({ length: 4 }, (_, i) => <SkeletonStatCard key={i} />)
        ) : (
          [
            { l: 'Total Outstanding', v: formatCurrency(t.outstanding), tone: 'danger' },
            { l: 'Unsettled Shipments', v: t.count || 0, tone: 'primary' },
            { l: 'Held at Hub', v: t.held || 0, tone: 'warning' },
            { l: 'Overdue Promises', v: t.overdue || 0, tone: 'danger' },
          ].map((c, i) => (
            <div key={i} className={`stat-card stat-card-${c.tone} stagger-item`} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="stat-value">{c.v}</div>
              <div className="stat-label">{c.l}</div>
            </div>
          ))
        )}
      </div>

      {!loading && (t.overdue || 0) > 0 && (
        <div
          className="mb-16 no-print"
          style={{
            background: 'var(--error-bg)', color: 'var(--error-dark)', border: '1px solid var(--error)',
            borderRadius: 8, padding: '10px 14px', fontSize: '0.8125rem',
          }}
          role="status"
        >
          {t.overdue} shipment{t.overdue === 1 ? '' : 's'} worth {formatCurrency(t.overdueAmount)} passed
          {t.overdue === 1 ? ' its' : ' their'} promised payment date. Follow up before the balance ages further.
        </div>
      )}

      <div className="flex gap-8 flex-wrap items-center mb-16 no-print">
        <ResponsiveFilterControls
          options={filterOptions}
          value={filter}
          onChange={setFilter}
          ariaLabel="Filter unsettled deliveries by settlement state"
          label="Settlement state"
          desktopClassName="tabs admin-mobile-tabs"
        />
        <input
          type="search"
          className="form-input"
          style={{ maxWidth: 260 }}
          placeholder="Search tracking or customer…"
          aria-label="Search unsettled deliveries"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="card animate-fade-in">
          <div className="table-container">
            <table className="data-table" aria-busy="true">
              <caption className="sr-only">Unsettled deliveries (loading)</caption>
              <thead>
                <tr><th>Tracking</th><th>Customer</th><th>Status</th><th>Settlement</th><th>Billed</th><th>Paid</th><th>Balance</th><th>Action</th></tr>
              </thead>
              <tbody>
                {Array.from({ length: 6 }, (_, i) => <SkeletonTableRow key={i} cols={8} />)}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card admin-section-card admin-table-card animate-fade-in no-print">
          <div className="table-container">
            <table className="data-table">
              <caption className="sr-only">Deliveries with an outstanding balance</caption>
              <thead>
                <tr>
                  <th>Tracking</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Settlement</th>
                  <th className="num">Billed</th>
                  <th className="num">Paid</th>
                  <th className="num">Balance</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(o => {
                  const meta = BUCKET_META[o.settlement_bucket] || BUCKET_META[SETTLEMENT_BUCKETS.IN_FLIGHT];
                  return (
                    <tr key={o.id}>
                      <td data-label="Tracking">
                        <Link to={`/admin/orders/${o.id}`} className="fw-700 text-accent">{o.tracking_number}</Link>
                        <div className="text-xs text-tertiary">{o.origin} → {o.destination}</div>
                      </td>
                      <td data-label="Customer">
                        <div>{o.profiles?.name || o.sender_name}</div>
                        <div className="text-xs text-tertiary">
                          {(o.payer_type || 'sender') === 'receiver' ? `Receiver pays · ${o.receiver_name}` : 'Sender pays'}
                        </div>
                      </td>
                      <td data-label="Status"><StatusBadge status={o.status} size="sm" /></td>
                      <td data-label="Settlement">
                        <span className={`badge badge-${meta.tone}`} title={meta.hint}>{meta.label}</span>
                        <div className="text-xs text-tertiary mt-4">
                          {o.promised_payment_date
                            ? (o.days_overdue > 0
                                ? `${o.days_overdue} day${o.days_overdue === 1 ? '' : 's'} overdue · promised ${formatDate(o.promised_payment_date)}`
                                : `Promised ${formatDate(o.promised_payment_date)}`)
                            : `Booked ${formatDate(o.created_at)}`}
                        </div>
                      </td>
                      <td data-label="Billed" className="num">{formatCurrency(o.shipping_cost)}</td>
                      <td data-label="Paid" className="num">{formatCurrency(o.amount_paid)}</td>
                      <td data-label="Balance" className="num fw-700 text-error">{formatCurrency(o.remaining_balance)}</td>
                      <td data-label="Action">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setPayingOrder(o)}
                        >
                          <Wallet size={14} /> Record Payment
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {paginated.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-0 b-0">
                      <EmptyState
                        icon={CheckCircle}
                        title={orders.length === 0 ? 'Everything is settled' : 'No matching shipments'}
                        description={orders.length === 0
                          ? 'No shipment in the pipeline has an outstanding balance.'
                          : 'Try a different settlement state or search term.'}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={6} className="fw-700">Outstanding ({filtered.length} shipment{filtered.length === 1 ? '' : 's'})</td>
                    <td className="num fw-700 text-error">{formatCurrency(filteredOutstanding)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <Pagination
            totalItems={filtered.length}
            currentPage={currentPage}
            itemsPerPage={perPage}
            onPageChange={setCurrentPage}
            onPerPageChange={(n) => { setPerPage(n); setCurrentPage(1); }}
          />
        </div>
      )}

      {/* ── Formal printed document (bond paper) — replaces UI in print ── */}
      {!loading && filtered.length > 0 && (
        <PrintDocument
          title="Unsettled Deliveries Report"
          subtitle="Shipments with an Outstanding Balance"
          generatedAt={loadedAt ? loadedAt.toLocaleString('en-PH', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : ''}
          preparedBy={userProfile?.name}
        >
          <div className="pd-section">
            <div className="pd-section-title">I. Settlement Summary</div>
            <table className="pd-table">
              <tbody>
                <tr><td>Total Outstanding (all shipments)</td><td className="num">{formatCurrency(t.outstanding)}</td></tr>
                <tr><td>Unsettled Shipments</td><td className="num">{t.count || 0}</td></tr>
                <tr><td>Held at Hub (dispatch blocked)</td><td className="num">{t.held || 0}</td></tr>
                <tr><td>Overdue Promises</td><td className="num">{t.overdue || 0}</td></tr>
                <tr><td>Overdue Amount</td><td className="num">{formatCurrency(t.overdueAmount)}</td></tr>
                <tr><td>Delivered with Balance Owing</td><td className="num">{t.delivered || 0}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="pd-section pd-flow">
            <div className="pd-section-title">
              II. Outstanding Shipments ({filtered.length}
              {filter !== 'all' ? ` — ${filterOptions.find(f => f.value === filter)?.label} only` : ''})
            </div>
            <table className="pd-table">
              <thead>
                <tr>
                  <th>Tracking No.</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Settlement</th>
                  <th>Promised</th>
                  <th className="num">Billed</th>
                  <th className="num">Paid</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(o => (
                  <tr key={o.id}>
                    <td>{o.tracking_number}</td>
                    <td>{o.profiles?.name || o.sender_name}</td>
                    <td>{o.status}</td>
                    <td>{(BUCKET_META[o.settlement_bucket] || {}).label || '—'}</td>
                    <td>{o.promised_payment_date ? formatDate(o.promised_payment_date) : '—'}</td>
                    <td className="num">{formatCurrency(o.shipping_cost)}</td>
                    <td className="num">{formatCurrency(o.amount_paid)}</td>
                    <td className="num">{formatCurrency(o.remaining_balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={7}>Total Outstanding</td>
                  <td className="num">{formatCurrency(filteredOutstanding)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </PrintDocument>
      )}

      {payingOrder && (
        <AdditionalPaymentModal
          order={payingOrder}
          remainingBalance={parseFloat(payingOrder.remaining_balance || 0)}
          onClose={() => setPayingOrder(null)}
          onSave={handleRecordPayment}
        />
      )}
    </div>
  );
};

export default UnsettledDeliveriesPage;
