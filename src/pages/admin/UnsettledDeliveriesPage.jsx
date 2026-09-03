import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  getUnsettledOrders, recordAdditionalPayment, withTimeout, SETTLEMENT_BUCKETS,
  deriveSettlement, summarizeSettlements, qualifiesAsUnsettled,
} from '../../lib/database';
import { useAuth } from '../../contexts/AuthContext';
import useRealtimeOrders from '../../hooks/useRealtimeOrders';
import { logActivity } from '../../lib/activityLog';
import { CenteredSpinner } from '../../components/ui/Loader';
import StatusBadge from '../../components/ui/StatusBadge';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import AdditionalPaymentModal from '../../components/ui/AdditionalPaymentModal';
import PrintDocument from '../../components/ui/PrintDocument';
import MessageCustomerButton from '../../components/ui/MessageCustomerButton';
import { exportPrintDocumentToPdf } from '../../lib/exportPdf';
import { CheckCircle, Wallet, Printer, Download, Loader, RefreshCw, Search } from 'lucide-react';
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
/** "just now" / "3m ago" — how fresh the numbers on screen are. */
const formatFreshness = (date, now) => {
  if (!date) return '';
  const seconds = Math.max(0, Math.round((now - date) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
};

const UnsettledDeliveriesPage = () => {
  usePageTitle('Unsettled Deliveries');
  const { user, userProfile } = useAuth();
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
  // A background reload triggered by realtime. Distinct from `loading` so the
  // table is never replaced by the spinner under the admin's cursor.
  const [refreshing, setRefreshing] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => { loadUnsettled(); }, []);

  // Re-render the freshness label without refetching anything.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  const loadUnsettled = async ({ silent = false } = {}) => {
    setError(null);
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const result = await withTimeout(getUnsettledOrders());
      setOrders(result.orders);
      setTotals(result.totals);
      setLoadedAt(new Date());
    } catch (e) {
      // A failed background refresh must not blank out good data the admin is
      // reading — surface the error only when this was an explicit load.
      if (!silent) setError(e.message || 'Failed to load unsettled deliveries.');
    } finally {
      if (silent) setRefreshing(false); else setLoading(false);
    }
  };

  // ── Realtime ──────────────────────────────────────────────────────────────
  // Payments land here from three directions the admin cannot see: the GCash
  // webhook, another admin's screen, and the customer's own phone. Without
  // this, a laptop left open on this page shows figures that quietly go stale.
  //
  // Rows already on screen are patched in place — no refetch, no scroll jump,
  // no closed modal. A refetch happens only when a row that is NOT on screen
  // starts qualifying, because only the query carries the customer join.
  const ordersRef = useRef(orders);
  ordersRef.current = orders;

  const handleRealtimeBatch = useCallback((payloads) => {
    const current = ordersRef.current;
    const byId = new Map(current.map(o => [o.id, o]));
    let touched = 0;
    let needsFullReload = false;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    payloads.forEach(({ new: row, old: oldRow, eventType }) => {
      // DELETE payloads carry the removed row in `old`; `new` is null.
      if (eventType === 'DELETE') {
        if (oldRow?.id && byId.has(oldRow.id)) {
          byId.delete(oldRow.id);
          touched += 1;
        }
        return;
      }

      if (!row?.id) return;
      const known = byId.get(row.id);

      if (known) {
        touched += 1;
        if (!qualifiesAsUnsettled(row)) {
          byId.delete(row.id);            // settled, cancelled, or rolled back
          return;
        }
        // Keep the joined customer record; realtime payloads carry columns only.
        const merged = { ...known, ...row, profiles: known.profiles };
        byId.set(row.id, { ...merged, ...deriveSettlement(merged, today) });
      } else if (qualifiesAsUnsettled(row)) {
        needsFullReload = true;           // new arrival — needs the customer join
        touched += 1;
      }
    });

    if (touched === 0) return;

    if (needsFullReload) {
      loadUnsettled({ silent: true });
    } else {
      const next = Array.from(byId.values());
      setOrders(next);
      setTotals(summarizeSettlements(next));
      setLoadedAt(new Date());
    }
    setLiveCount(c => c + touched);
  }, []);

  useRealtimeOrders({
    enabled: !loading,
    channelName: 'unsettled_deliveries',
    userId: user?.id,
    debounceMs: 800,
    onBatch: handleRealtimeBatch,
  });

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
    () => filtered.reduce((sum, o) => sum + o.outstanding, 0),
    [filtered]
  );

  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * perPage, currentPage * perPage),
    [filtered, currentPage, perPage]
  );

  useEffect(() => { setCurrentPage(1); }, [filter, search]);

  const handleRecordPayment = async (amount, method, ref, notes, date, receiptUrl) => {
    const order = payingOrder;
    // The payment_transactions database trigger writes the single activity
    // entry. A second browser-side log here would duplicate the collection.
    await recordAdditionalPayment(
      order.id, amount, method, ref, notes, date, receiptUrl, false,
    );
    setPayingOrder(null);
    // Silent: the realtime patch usually lands first anyway, and a spinner
    // flash right after a successful collection looks like something failed.
    await loadUnsettled({ silent: true });
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
      <button type="button" className="btn btn-primary mt-md" onClick={() => loadUnsettled()}>Retry</button>
    </div>
  );

  const t = totals || {};

  return (
    <div>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Wallet size={24} color="var(--primary)" aria-hidden="true" />Unsettled Deliveries</h1>
          <p className="admin-page-subtitle">
            Shipments in the pipeline that still owe money — who owes it, how much, and how overdue.
          </p>
          {!loading && loadedAt && (
            <div className="text-xs text-tertiary mt-4 no-print" role="status" aria-live="polite">
              {refreshing ? (
                <><Loader size={12} className="animate-spin inline mr-6" aria-hidden="true" /> Updating…</>
              ) : (
                <>
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                      background: 'var(--success)', marginRight: 6, verticalAlign: 'middle',
                    }}
                  />
                  Live · updated {formatFreshness(loadedAt, now)}
                  {liveCount > 0 && <> · {liveCount} change{liveCount === 1 ? '' : 's'} received</>}
                </>
              )}
            </div>
          )}
        </div>
        {!loading && (
          <div className="flex gap-8 no-print">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => loadUnsettled()}>
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
      {loading ? (
        <CenteredSpinner />
      ) : (
        <div className="grid grid-4 mb-24">
          {[
            { l: 'Total Outstanding', v: formatCurrency(t.outstanding), tone: 'danger' },
            { l: 'Unsettled Shipments', v: t.count || 0, tone: 'primary' },
            { l: 'Held at Hub', v: t.held || 0, tone: 'warning' },
            { l: 'Overdue Promises', v: t.overdue || 0, tone: 'danger' },
          ].map((c, i) => (
            <div key={i} className={`stat-card stat-card-${c.tone} stagger-item`} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="stat-value">{c.v}</div>
              <div className="stat-label">{c.l}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && (t.overdue || 0) > 0 && (
        <div
          className="mb-16 no-print br-8"
          style={{
            background: 'var(--error-bg)', color: 'var(--error-text-strong)', border: '1px solid var(--error)',
            padding: '10px 14px', fontSize: '0.8125rem',
          }}
          role="status"
        >
          {t.overdue} shipment{t.overdue === 1 ? '' : 's'} worth {formatCurrency(t.overdueAmount)} passed
          {t.overdue === 1 ? ' its' : ' their'} promised payment date. Follow up before the balance ages further.
        </div>
      )}

      {!loading && (t.mismatched || 0) > 0 && (
        <div
          className="mb-16 no-print br-8"
          style={{
            background: 'var(--warning-bg)', color: 'var(--badge-warning-color)', border: '1px solid var(--warning)',
            padding: '10px 14px', fontSize: '0.8125rem',
          }}
          role="status"
        >
          {t.mismatched} shipment{t.mismatched === 1 ? ' has a' : 's have'} stored balance that disagrees with
          billed minus paid. The figures shown are derived from billed minus paid; the stored total needs reconciling.
        </div>
      )}

      <div className="flex gap-8 flex-wrap items-center mb-16 no-print unsettled-filter-row">
        <ResponsiveFilterControls
          options={filterOptions}
          value={filter}
          onChange={setFilter}
          ariaLabel="Filter unsettled deliveries by settlement state"
          label="Settlement state"
          desktopClassName="tabs admin-mobile-tabs"
        />
        <div className="search-box unsettled-search-box" role="search">
          <Search size={16} className="search-icon" aria-hidden="true" />
          <input
            id="admin-unsettled-search"
            name="qunsettled"
            type="search"
            aria-label="Search unsettled deliveries"
            placeholder="Search tracking or customer…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <CenteredSpinner />
      ) : paginated.length === 0 ? (
        <div className="card animate-fade-in no-print">
          <EmptyState
            icon={CheckCircle}
            title={orders.length === 0 ? 'Everything is settled' : 'No matching shipments'}
            description={orders.length === 0
              ? 'No shipment in the pipeline has an outstanding balance.'
              : 'Try a different settlement state or search term.'}
          />
        </div>
      ) : (
        <div className="card admin-section-card admin-table-card unsettled-table-card animate-fade-in no-print">
          <div className="table-container">
            <table className="data-table data-table--wide unsettled-table">
              <caption className="sr-only">Deliveries with an outstanding balance</caption>
              <thead>
                <tr>
                  <th scope="col">Tracking</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Status</th>
                  <th scope="col">Settlement</th>
                  <th scope="col" className="num">Billed</th>
                  <th scope="col" className="num">Paid</th>
                  <th scope="col" className="num">Balance</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(o => {
                  const meta = BUCKET_META[o.settlement_bucket] || BUCKET_META[SETTLEMENT_BUCKETS.IN_FLIGHT];
                  return (
                    <tr key={o.id}>
                      <td data-label="Tracking" className="unsettled-tracking-cell">
                        <Link to={`/admin/orders/${o.id}`} className="fw-700 text-accent">{o.tracking_number}</Link>
                        <div className="text-xs text-tertiary">{o.origin} → {o.destination}</div>
                      </td>
                      <td data-label="Customer" className="unsettled-customer-cell">
                        {/* Chasing a balance is the case where an admin most
                            often needs to talk to the customer, so the shortcut
                            sits on the name itself. Icon only — the column is
                            narrow and the row already has a labelled action. */}
                        <div className="flex items-center gap-4">
                          <span>{o.profiles?.name || o.sender_name}</span>
                          <MessageCustomerButton
                            customerId={o.user_id}
                            customerName={o.profiles?.name || o.sender_name}
                          />
                        </div>
                        <div className="text-xs text-tertiary">
                          {(o.payer_type || 'sender') === 'receiver' ? `Receiver pays · ${o.receiver_name}` : 'Sender pays'}
                        </div>
                      </td>
                      <td data-label="Status" className="unsettled-status-cell"><StatusBadge status={o.status} size="sm" /></td>
                      <td data-label="Settlement" className="unsettled-settlement-cell">
                        <span className={`badge badge-${meta.tone}`} title={meta.hint}>{meta.label}</span>
                        <div className="text-xs text-tertiary mt-4">
                          {o.promised_payment_date
                            ? (o.days_overdue > 0
                                ? `${o.days_overdue} day${o.days_overdue === 1 ? '' : 's'} overdue · promised ${formatDate(o.promised_payment_date)}`
                                : `Promised ${formatDate(o.promised_payment_date)}`)
                            : `Booked ${formatDate(o.created_at)}`}
                        </div>
                      </td>
                      <td data-label="Billed" className="num unsettled-money-cell unsettled-billed-cell">{formatCurrency(o.shipping_cost)}</td>
                      <td data-label="Paid" className="num unsettled-money-cell unsettled-paid-cell">{formatCurrency(o.amount_paid)}</td>
                      <td data-label="Balance" className="num fw-700 text-error unsettled-money-cell unsettled-balance-cell">
                        {formatCurrency(o.outstanding)}
                        {o.balance_mismatch && (
                          <div className="text-xs text-tertiary fw-400" title={`Stored remaining_balance is ${formatCurrency(o.remaining_balance)} — the ledger total is stale and should be reconciled.`}>
                            ledger says {formatCurrency(o.remaining_balance)}
                          </div>
                        )}
                      </td>
                      <td data-label="Action" className="unsettled-action-cell">
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
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6} className="fw-700">Outstanding ({filtered.length} shipment{filtered.length === 1 ? '' : 's'})</td>
                  <td className="num fw-700 text-error">{formatCurrency(filteredOutstanding)}</td>
                  <td />
                </tr>
              </tfoot>
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
                <tr><td>Stored Balance Needing Reconciliation</td><td className="num">{t.mismatched || 0}</td></tr>
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
                  <th scope="col">Tracking No.</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Status</th>
                  <th scope="col">Settlement</th>
                  <th scope="col">Promised</th>
                  <th scope="col" className="num">Billed</th>
                  <th scope="col" className="num">Paid</th>
                  <th scope="col" className="num">Balance</th>
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
                    <td className="num">{formatCurrency(o.outstanding)}</td>
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
          remainingBalance={payingOrder.outstanding}
          onClose={() => setPayingOrder(null)}
          onSave={handleRecordPayment}
          onPaymentConfirmed={() => loadUnsettled({ silent: true })}
        />
      )}
    </div>
  );
};

export default UnsettledDeliveriesPage;
