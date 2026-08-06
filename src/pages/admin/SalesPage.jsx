import { useState, useEffect, useCallback } from 'react';
import { getSalesData, withTimeout } from '../../lib/database';
import { useAuth } from '../../contexts/AuthContext';
import useRealtimeOrders from '../../hooks/useRealtimeOrders';
import { logActivity } from '../../lib/activityLog';
import { SkeletonStatCard, SkeletonDonut, SkeletonBarChart } from '../../components/ui/SkeletonLoader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import DonutChart from '../../components/ui/DonutChart';
import MiniBarChart from '../../components/ui/MiniBarChart';
import PrintDocument from '../../components/ui/PrintDocument';
import { exportPrintDocumentToPdf } from '../../lib/exportPdf';
import { DollarSign, CheckCircle, AlertTriangle, Clock, Printer, Download, Loader } from 'lucide-react';
import EmptyState from '../../components/ui/EmptyState';
import usePageTitle from '../../hooks/usePageTitle';

const formatCurrency = (val) => `₱${(val || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The four headline tiles, declared once at module scope.
 *
 * Keyed by `key`, not by array index, and always rendered — every tile is
 * present on every pass regardless of what a refresh returns. A tile whose
 * figure is missing shows 0, which is the truthful reading of "the summary
 * carried no value for it"; it must never disappear, because a vanished
 * Outstanding tile reads as "nothing is outstanding".
 */
/**
 * `outstandingTotal` — not `unpaidTotal` — is deliberate. Both tabs of this
 * report now read the SAME derived figure (shipping_cost − amount_paid) over
 * the SAME population (the five settlement-tracked statuses), so this tile and
 * the Unsettled Deliveries total reconcile to the peso. The label names the
 * scope, because a number called "Outstanding" that silently means something
 * different one tab over is how the two figures diverged in the first place.
 */
const STAT_CARDS = [
  { key: 'totalRevenue', label: 'Total Revenue', field: 'totalRevenue', tone: 'primary', prefix: '₱' },
  { key: 'collected',    label: 'Collected',     field: 'paidTotal',    tone: 'success', prefix: '₱' },
  { key: 'outstanding',  label: 'Outstanding (in pipeline)', field: 'outstandingTotal', tone: 'danger', prefix: '₱' },
  { key: 'unpaidCount',  label: 'Unpaid Orders', field: 'unpaidCount',  tone: 'warning', prefix: '' },
];

const EMPTY_SUMMARY = {
  totalRevenue: 0,
  paidTotal: 0,
  outstandingTotal: 0,
  outstandingAllOrders: 0,
  outstandingStored: 0,
  unpaidCount: 0,
  unpricedCount: 0,
  cashTotal: 0,
  gcashTotal: 0,
  paylaterTotal: 0,
  unattributedTotal: 0,
};

const SalesPage = () => {
  usePageTitle('Sales');
  const { user, userProfile } = useAuth();
  const [data, setData] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { loadSales(); }, []);
  const loadSales = async ({ silent = false } = {}) => {
    setError(null);
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const result = await withTimeout(getSalesData());
      // Merge, never replace. A realtime refresh must not be able to blank a
      // tile: if a payload arrives without `unpaidTotal`/`unpaidCount` (an RPC
      // fallback, a partial response), the last known figure stays on screen
      // instead of collapsing to undefined and taking its card with it.
      setData(prev => ({
        ...prev,
        ...result,
        summary: { ...EMPTY_SUMMARY, ...(prev?.summary || {}), ...(result?.summary || {}) },
        monthlySales: result?.monthlySales ?? prev?.monthlySales ?? [],
        unpaidOrders: result?.unpaidOrders ?? prev?.unpaidOrders ?? [],
      }));
      setLoadedAt(new Date());
    } catch (e) {
      // Keep the last good figures on screen if a background refresh fails.
      if (!silent) setError(e.message || 'Failed to load sales data.');
    } finally {
      if (silent) setRefreshing(false); else setLoading(false);
    }
  };

  // ── Realtime ──────────────────────────────────────────────────────────────
  // Every figure here is an aggregate, so there is nothing to patch in place —
  // any order change can move the totals and the monthly series. A 2s debounce
  // (vs 800ms on the row-level list) keeps a burst of webhook reconciliations
  // to a single recompute; a couple of seconds of staleness on an all-time
  // revenue tile is invisible, and get_sales_summary is the heaviest read in
  // the app.
  const handleRealtimeBatch = useCallback(() => {
    loadSales({ silent: true });
  }, []);

  useRealtimeOrders({
    enabled: !loading,
    channelName: 'sales_overview',
    userId: user?.id,
    debounceMs: 2000,
    onBatch: handleRealtimeBatch,
  });

  const handlePrint = () => {
    logActivity({ module: 'Sales & Reports', action: 'Sales Report Printed', details: 'Printed sales & revenue report' });
    window.print();
  };

  const handleExportPDF = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportPrintDocumentToPdf(`CargoExpress_SalesReport_${new Date().toISOString().slice(0, 10)}.pdf`);
      logActivity({ module: 'Sales & Reports', action: 'Sales Report Exported', details: 'Exported sales & revenue report to PDF' });
    } catch (e) {
      console.error('PDF export failed:', e);
    } finally {
      setExporting(false);
    }
  };

  if (error) return (
    <div className="page-transition">
      <div className="card text-center admin-error-card p-40">
        <h3>Error</h3>
        <p>{error}</p>
        <button type="button" className="btn btn-primary mt-md" onClick={() => loadSales()}>Retry</button>
      </div>
    </div>
  );

  const s = { ...EMPTY_SUMMARY, ...(data?.summary || {}) };

  // Each figure is the sum of the payment_transactions recorded under that
  // method, not the balance of orders whose last payment used it — an order
  // picked up on GCash and settled in cash contributes to both.
  // "Unattributed" is money collected before the ledger became authoritative:
  // real, but with no method behind it. It is shown rather than absorbed into
  // Cash, and only when it exists.
  const paymentMethods = [
    { l: 'Cash', v: s.cashTotal || 0, c: 'var(--success)' },
    { l: 'GCash', v: s.gcashTotal || 0, c: 'var(--info)' },
    { l: 'Pay Later', v: s.paylaterTotal || 0, c: 'var(--warning)' },
    ...((s.unattributedTotal || 0) > 0
      ? [{ l: 'Unattributed', v: s.unattributedTotal, c: 'var(--text-tertiary)' }]
      : []),
  ];

  const monthlySales = data?.monthlySales || [];

  return (
    <div className="page-transition">
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">Sales & Revenue</h1>
          <p className="admin-page-subtitle">Revenue, collection health, and payment method performance.</p>
          {!loading && data && (
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
                  Live · updated {loadedAt ? loadedAt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }) : ''}
                </>
              )}
            </div>
          )}
        </div>
        {!loading && data && (
          <div className="flex gap-8">
            <button type="button" className="btn btn-outline btn-sm" onClick={handleExportPDF} disabled={exporting}>
              {exporting ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
              Export PDF
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handlePrint}>
              <Printer size={16} />
              Print Report
            </button>
          </div>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-4 mb-24">
        {loading ? (
          STAT_CARDS.map(c => <SkeletonStatCard key={c.key} />)
        ) : (
          STAT_CARDS.map((c, i) => (
            <div key={c.key} className={`stat-card stat-card-${c.tone} stagger-item`} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="stat-value">
                <AnimatedCounter value={Number(s[c.field]) || 0} prefix={c.prefix} decimals={0} duration={1200} />
              </div>
              <div className="stat-label">{c.label}</div>
            </div>
          ))
        )}
      </div>

      {/* Reconciliation line. The Outstanding tile is scoped to the pipeline so
          it matches Unsettled Deliveries exactly; anything owing outside that
          scope is stated here rather than folded in silently. */}
      {!loading && data && (s.outstandingAllOrders || 0) - (s.outstandingTotal || 0) > 0.005 && (
        <div className="text-xs text-tertiary mb-24 no-print">
          Pipeline figure matches the Unsettled Deliveries tab.
          A further {formatCurrency((s.outstandingAllOrders || 0) - (s.outstandingTotal || 0))} is
          outstanding on orders not yet picked up.
        </div>
      )}

      <div className="grid grid-2 mb-24">
        {/* Payment Methods */}
        <div className="card admin-section-card stagger-item" style={{ animationDelay: '240ms' }}>
          <div className="card-header"><h3>Payment Methods</h3></div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'center', padding: '24px 16px' }}>
            {loading ? <SkeletonDonut size={170} /> : (
              <DonutChart
                size={170}
                thickness={26}
                centerLabel={`₱${(s.paidTotal || 0) >= 1000 ? ((s.paidTotal || 0) / 1000).toFixed(0) + 'k' : (s.paidTotal || 0)}`}
                centerSub="Collected"
                segments={paymentMethods
                  .filter(pm => pm.v > 0)
                  .map(pm => ({ label: pm.l, value: pm.v, color: pm.c }))}
              />
            )}
          </div>
        </div>

        {/* Monthly Revenue */}
        <div className="card admin-section-card stagger-item" style={{ animationDelay: '300ms' }}>
          <div className="card-header"><h3>Monthly Revenue</h3></div>
          <div className="card-body">
            {loading ? <SkeletonBarChart height={180} bars={8} /> : monthlySales.length === 0 ? (
              <EmptyState
                icon={DollarSign}
                title="No sales data"
                description="No revenue records available for this period."
              />
            ) : (
              <MiniBarChart
                height={180}
                valuePrefix="₱"
                bars={monthlySales.slice(0, 8).map(m => ({
                  label: new Date(m.month + '-01').toLocaleDateString('en-PH', { month: 'short' }),
                  value: m.total_revenue,
                  color: 'var(--primary)',
                }))}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Formal printed document (bond paper) — replaces UI in print ── */}
      {!loading && data && (
        <PrintDocument
          title="Sales & Revenue Report"
          subtitle="All-Time Sales Summary"
          generatedAt={loadedAt ? loadedAt.toLocaleString('en-PH', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : ''}
          preparedBy={userProfile?.name}
        >
          {/* Revenue Summary */}
          <div className="pd-section">
            <div className="pd-section-title">I. Revenue Summary</div>
            <table className="pd-table">
              <tbody>
                <tr><td>Total Revenue (billed)</td><td className="num">{formatCurrency(s.totalRevenue)}</td></tr>
                <tr><td>Total Collected</td><td className="num">{formatCurrency(s.paidTotal)}</td></tr>
                {/* Both scopes are printed. They are different questions, and
                    naming only one "Outstanding" is what let the Sales and
                    Unsettled tabs disagree without either being wrong. */}
                <tr><td>Outstanding — shipments in the pipeline</td><td className="num">{formatCurrency(s.outstandingTotal)}</td></tr>
                <tr><td>Outstanding — all active orders</td><td className="num">{formatCurrency(s.outstandingAllOrders)}</td></tr>
                <tr><td>Orders with Unpaid Balance</td><td className="num">{s.unpaidCount || 0}</td></tr>
                {(s.unpricedCount || 0) > 0 && (
                  <tr><td>Bookings not yet weighed (no price yet)</td><td className="num">{s.unpricedCount}</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Payment Methods */}
          <div className="pd-section">
            <div className="pd-section-title">II. Collections by Payment Method</div>
            <table className="pd-table">
              <thead>
                <tr><th>Payment Method</th><th className="num">Amount Collected</th><th className="num">Share of Collections</th></tr>
              </thead>
              <tbody>
                {paymentMethods.map((pm, i) => (
                  <tr key={i}>
                    <td>{pm.l}</td>
                    <td className="num">{formatCurrency(pm.v)}</td>
                    <td className="num">{(s.paidTotal || 0) > 0 ? ((pm.v / s.paidTotal) * 100).toFixed(1) : '0.0'}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>Total Collected</td><td className="num">{formatCurrency(s.paidTotal)}</td><td className="num">100%</td></tr>
              </tfoot>
            </table>
          </div>

          {/* Monthly Revenue */}
          {monthlySales.length > 0 && (
            <div className="pd-section">
              <div className="pd-section-title">III. Monthly Revenue Breakdown</div>
              <table className="pd-table">
                <thead>
                  <tr><th>Month</th><th className="num">Revenue</th><th className="num">Collected</th><th className="num">Outstanding</th></tr>
                </thead>
                <tbody>
                  {monthlySales.map((m, i) => (
                    <tr key={i}>
                      <td>{new Date(m.month + '-01').toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</td>
                      <td className="num">{formatCurrency(m.total_revenue)}</td>
                      <td className="num">{formatCurrency(m.collected)}</td>
                      <td className="num">{formatCurrency(m.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td className="num">{formatCurrency(monthlySales.reduce((sum, m) => sum + (parseFloat(m.total_revenue) || 0), 0))}</td>
                    <td className="num">{formatCurrency(monthlySales.reduce((sum, m) => sum + (parseFloat(m.collected) || 0), 0))}</td>
                    <td className="num">{formatCurrency(monthlySales.reduce((sum, m) => sum + (parseFloat(m.outstanding) || 0), 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Unpaid Orders */}
          {(data?.unpaidOrders || []).length > 0 && (
            <div className="pd-section pd-flow">
              <div className="pd-section-title">{monthlySales.length > 0 ? 'IV.' : 'III.'} Orders with Outstanding Balance ({data.unpaidOrders.length})</div>
              <table className="pd-table">
                <thead>
                  <tr>
                    <th>Tracking No.</th>
                    <th>Booked</th>
                    <th>Status</th>
                    <th className="num">Shipping Cost</th>
                    <th className="num">Amount Paid</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unpaidOrders.map(o => (
                    <tr key={o.id}>
                      <td>{o.tracking_number}</td>
                      <td>{o.created_at ? new Date(o.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                      <td>{o.status || '—'}</td>
                      <td className="num">{formatCurrency(parseFloat(o.shipping_cost || 0))}</td>
                      <td className="num">{formatCurrency(parseFloat(o.amount_paid || 0))}</td>
                      <td className="num">{formatCurrency(parseFloat(o.remaining_balance || 0))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>Total Outstanding</td>
                    <td className="num">{formatCurrency(data.unpaidOrders.reduce((sum, o) => sum + (parseFloat(o.shipping_cost) || 0), 0))}</td>
                    <td className="num">{formatCurrency(data.unpaidOrders.reduce((sum, o) => sum + (parseFloat(o.amount_paid) || 0), 0))}</td>
                    <td className="num">{formatCurrency(data.unpaidOrders.reduce((sum, o) => sum + (parseFloat(o.remaining_balance) || 0), 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </PrintDocument>
      )}
    </div>
  );
};
export default SalesPage;
