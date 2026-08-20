import { useState, useEffect } from 'react';
import { getReportData } from '../../lib/database';
import { logActivity } from '../../lib/activityLog';
import { useAuth } from '../../contexts/AuthContext';
import { SkeletonStatCard, SkeletonText } from '../../components/ui/SkeletonLoader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import StatusBadge from '../../components/ui/StatusBadge';
import EmptyState from '../../components/ui/EmptyState';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import DonutChart from '../../components/ui/DonutChart';
import MiniBarChart from '../../components/ui/MiniBarChart';
import PrintDocument from '../../components/ui/PrintDocument';
import { exportPrintDocumentToPdf } from '../../lib/exportPdf';
import {
  FileText, Printer, Calendar, Package, CheckCircle,
  DollarSign, TrendingUp, Truck, MapPin, BarChart3,
  Filter, RefreshCw, Clock, CreditCard, Loader, AlertTriangle, Download
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { isOrderPriced } from '../../constants/status';

const PERIODS = [
  { key: 'daily', label: 'Daily', icon: Clock },
  { key: 'weekly', label: 'Weekly', icon: Calendar },
  { key: 'monthly', label: 'Monthly', icon: Calendar },
  { key: 'yearly', label: 'Yearly', icon: BarChart3 },
  { key: 'custom', label: 'Custom', icon: Filter },
];

const formatCurrency = (val) => `₱${(val || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatWeight = (val) => `${(val || 0).toLocaleString('en-PH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg`;
const formatDate = (d) => new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
const formatDateTime = (d) => new Date(d).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

const STATUS_ORDER = ['Pending', 'Assigned', 'Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered', 'Cancelled'];

const ReportsPage = () => {
  usePageTitle('Reports');
  const { userProfile } = useAuth();
  const [period, setPeriod] = useState('daily');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const hasCustomDateRange = customStart && customEnd;
  const customDateRangeInvalid = Boolean(hasCustomDateRange && customEnd < customStart);

  const loadReport = async () => {
    if (period === 'custom' && (!customStart || !customEnd)) {
      setError('Please select both start and end dates for custom range.');
      return;
    }
    if (period === 'custom' && customDateRangeInvalid) {
      setError('End date must be the same as or later than the start date.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getReportData(
        period,
        period === 'custom' ? customStart : null,
        period === 'custom' ? customEnd : null
      );
      setData(result);
    } catch (e) {
      setError(e.message || 'Failed to load report data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (period !== 'custom') loadReport();
  }, [period]);

  const handlePrint = () => {
    logActivity({ module: 'Sales & Reports', action: 'Report Printed', details: `Printed ${period} report` });
    window.print();
  };

  const handleExportPDF = async () => {
    if (!data?.orders?.length || exporting) return;
    setExporting(true);
    try {
      await exportPrintDocumentToPdf(`CargoExpress_Report_${period}_${new Date().toISOString().slice(0, 10)}.pdf`);
      logActivity({ module: 'Sales & Reports', action: 'Report Exported', details: `Exported ${period} report to PDF` });
    } catch (e) {
      console.error('PDF export failed:', e);
    } finally {
      setExporting(false);
    }
  };

  const s = data?.summary || {};
  const hasData = data && data.orders && data.orders.length > 0;

  return (
    <div className="page-transition">
      {/* ── Screen-only controls ── */}
      <div className="report-controls no-print">
        <div>
          <h1 className="admin-page-title">
            <FileText size={24} color="var(--primary)" aria-hidden="true" />
            Reports & Analytics
          </h1>
          <p className="admin-page-subtitle">
            Generate, view, and print detailed business reports
          </p>
        </div>
        <div className="flex gap-8 flex-wrap">
          <button type="button" className="btn btn-ghost btn-sm flex-1 sm:flex-none justify-center" style={{minWidth: 90}} onClick={loadReport} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          {hasData && (
            <>
              <button type="button" className="btn btn-outline btn-sm flex-1 sm:flex-none justify-center" style={{minWidth: 110}} onClick={handleExportPDF} disabled={exporting}>
                {exporting ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
                Export PDF
              </button>
              <button type="button" className="btn btn-primary btn-sm flex-1 sm:flex-none justify-center" style={{minWidth: 110}} onClick={handlePrint}>
                <Printer size={16} />
                Print Report
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Period Tabs ── */}
      <ResponsiveFilterControls
        options={PERIODS.map(p => ({ value: p.key, label: p.label, icon: p.icon }))}
        value={period}
        onChange={setPeriod}
        ariaLabel="Report period"
        label="Period"
        desktopClassName="report-period-tabs"
        buttonClassName={(option, active) => `report-period-tab ${active ? 'active' : ''}`}
        className="no-print report-period-filter"
      />

      {/* ── Custom Date Range ── */}
      {period === 'custom' && (
        <div className="report-custom-range no-print stagger-item">
          <div className="report-date-inputs">
            <div className="form-group">
              <label className="form-label" htmlFor="report-start-date">Start Date</label>
              <input
                id="report-start-date"
                type="date"
                className="form-input"
                value={customStart}
                onChange={e => {
                  setCustomStart(e.target.value);
                  if (error) setError(null);
                }}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="report-end-date">End Date</label>
              <input
                id="report-end-date"
                type="date"
                className="form-input"
                value={customEnd}
                onChange={e => {
                  setCustomEnd(e.target.value);
                  if (error) setError(null);
                }}
              />
            </div>
          </div>
          {customDateRangeInvalid && (
            <p className="form-error" role="alert">
              End date must be the same as or later than the start date.
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={loadReport}
            disabled={!customStart || !customEnd || customDateRangeInvalid || loading}
          >
            {loading ? <Loader size={16} className="animate-spin" /> : <BarChart3 size={16} />}
            Generate Report
          </button>
        </div>
      )}

      {/* ── Error State ── */}
      {error && (
        <div className="card p-24 text-center text-error mt-16">
          <AlertTriangle size={32} className="mb-8" />
          <p>{error}</p>
          <button type="button" className="btn btn-primary btn-sm mt-12" onClick={loadReport}>Retry</button>
        </div>
      )}

      {/* ── Loading State ── */}
      {loading && (
        <div className="mt-20">
          <div className="grid grid-4 mb-20">
            {[0, 1, 2, 3].map(i => <SkeletonStatCard key={i} />)}
          </div>
          <div className="card card-body"><SkeletonText lines={8} /></div>
        </div>
      )}

      {/* ── Report Content (screen only) ── */}
      {!loading && data && (
        <div>

          {/* No Data */}
          {!hasData && (
            <EmptyState
              icon={FileText}
              title="No Orders Found"
              description={`No orders found for the selected period: ${data.periodLabel}`}
            />
          )}

          {hasData && (
            <>
              {/* ── Summary Cards ── */}
              <div className="grid grid-4 report-summary-cards mb-20 mt-16">
                {[
                  { label: 'Total Orders', value: s.totalOrders, tone: 'primary', prefix: '', decimals: 0 },
                  { label: 'Delivered', value: s.deliveredCount, tone: 'success', prefix: '', decimals: 0 },
                  { label: 'Total Revenue', value: s.totalRevenue, tone: 'accent', prefix: '₱', decimals: 0 },
                  { label: 'Collected', value: s.totalCollected, tone: 'info', prefix: '₱', decimals: 0 },
                ].map((card, i) => (
                  <div key={i} className={`stat-card stat-card-${card.tone} stagger-item`} style={{ animationDelay: `${i * 60}ms` }}>
                    <div className="stat-value">
                      <AnimatedCounter value={card.value} prefix={card.prefix} decimals={card.decimals} duration={1000} />
                    </div>
                    <div className="stat-label">{card.label}</div>
                  </div>
                ))}
              </div>

              {/* ── Two Column: Status + Financial ── */}
              <div className="grid grid-2 mb-20">
                {/* Status Breakdown */}
                <div className="card stagger-item" style={{ animationDelay: '240ms' }}>
                  <div className="card-header">
                    <h3 className="flex items-center gap-8">
                      <Package size={18} className="text-primary" />
                      Order Status Breakdown
                    </h3>
                  </div>
                  <div className="card-body">
                    <table className="report-table">
                      <thead>
                        <tr>
                          <th scope="col">Status</th>
                          <th scope="col" className="text-center">Count</th>
                          <th scope="col" className="text-right">Percentage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {STATUS_ORDER.filter(st => data.statusBreakdown[st]).map(st => (
                          <tr key={st}>
                            <td data-label="Status"><StatusBadge status={st} /></td>
                            <td data-label="Count" className="text-center fw-600">{data.statusBreakdown[st]}</td>
                            <td data-label="Percentage" className="text-right text-secondary">
                              {s.totalOrders > 0 ? ((data.statusBreakdown[st] / s.totalOrders) * 100).toFixed(1) : 0}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Visual Status Donut */}
                <div className="card stagger-item" style={{ animationDelay: '260ms' }}>
                  <div className="card-header">
                    <h3 className="flex items-center gap-8">
                      <BarChart3 size={18} className="text-primary" />
                      Status Distribution
                    </h3>
                  </div>
                  <div className="card-body flex justify-center" style={{ padding: '24px 16px' }}>
                    <DonutChart
                      size={170}
                      thickness={24}
                      centerLabel={String(s.totalOrders || 0)}
                      centerSub="Orders"
                      segments={STATUS_ORDER
                        .filter(st => data.statusBreakdown[st])
                        .map(st => ({
                          label: st,
                          value: data.statusBreakdown[st],
                          color: st === 'Delivered' ? 'var(--success)'
                            : st === 'Cancelled' ? 'var(--error)'
                            : st === 'Pending' ? 'var(--warning)'
                            : st === 'In Transit' ? 'var(--info)'
                            : st === 'Out for Delivery' ? 'var(--chart-1)'
                            : st === 'Picked Up' || st === 'Arrived at Hub' ? 'var(--chart-4)'
                            : 'var(--chart-3)',
                        }))
                      }
                    />
                  </div>
                </div>

                {/* Financial Summary */}
                <div className="card stagger-item col-full" style={{ animationDelay: '300ms',}}>
                  <div className="card-header">
                    <h3 className="flex items-center gap-8">
                      <CreditCard size={18} className="text-primary" />
                      Financial Summary
                    </h3>
                  </div>
                  <div className="card-body">
                    <div className="report-financial-grid">
                      <div className="report-financial-item">
                        <span className="report-financial-label">Total Revenue</span>
                        <span className="report-financial-value">{formatCurrency(s.totalRevenue)}</span>
                      </div>
                      <div className="report-financial-item">
                        <span className="report-financial-label">Total Collected</span>
                        <span className="report-financial-value text-success">{formatCurrency(s.totalCollected)}</span>
                      </div>
                      <div className="report-financial-item">
                        <span className="report-financial-label">Outstanding Balance</span>
                        <span className="report-financial-value text-error">{formatCurrency(s.totalOutstanding)}</span>
                      </div>
                      <div className="report-financial-item">
                        <span className="report-financial-label">Total Weight Shipped</span>
                        <span className="report-financial-value">{formatWeight(s.totalWeight)}</span>
                      </div>
                    </div>

                    <div className="mt-16 mb-16 border-t" style={{ paddingTop: 16 }}>
                      <div className="fw-700 text-secondary mb-12 text-uppercase" style={{ fontSize: '0.8rem', letterSpacing: '0.05em' }}>Payment Methods</div>
                      {[
                        { label: 'Cash', count: s.cashCount, total: s.cashTotal, color: 'var(--success)' },
                        { label: 'GCash', count: s.gcashCount, total: s.gcashTotal, color: 'var(--info)' },
                        { label: 'Pay Later', count: s.paylaterCount, total: s.paylaterTotal, color: 'var(--warning)' },
                        // Collected before the ledger became authoritative — no
                        // method to attribute it to. Shown only when non-zero.
                        ...((s.unattributedTotal || 0) > 0
                          ? [{ label: 'Unattributed', count: null, total: s.unattributedTotal, color: 'var(--text-tertiary)' }]
                          : []),
                      ].map((pm, i, arr) => (
                        <div key={pm.label} className="flex justify-between items-center" style={{ padding: '6px 0', borderBottom: i < arr.length - 1 ? '1px solid var(--border-light)' : 'none' }}>
                          <div className="flex items-center gap-8">
                            <div className="w-8 h-8 rounded-full" style={{ background: pm.color }} />
                            <span className="text-sm">{pm.label}</span>
                            {/* Payments, not orders — one order can settle across two methods. */}
                            {pm.count !== null && (
                              <span className="badge text-secondary" style={{ background: 'var(--bg-secondary)', fontSize: '0.7rem' }}>{pm.count || 0} payments</span>
                            )}
                          </div>
                          <span className="fw-700 text-sm">{formatCurrency(pm.total)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Route Performance ── */}
              {data.routeBreakdown.length > 0 && (
                <div className="card stagger-item mb-20" style={{ animationDelay: '360ms' }}>
                  <div className="card-header">
                    <h3 className="flex items-center gap-8">
                      <MapPin size={18} className="text-primary" />
                      Route Performance
                    </h3>
                  </div>
                  <div className="card-body">
                    {/* Route Revenue Chart */}
                    <div className="mb-20">
                      <MiniBarChart
                        height={140}
                        valuePrefix="₱"
                        bars={data.routeBreakdown.slice(0, 8).map((r, i) => ({
                          label: r.route.length > 12 ? r.route.slice(0, 11) + '…' : r.route,
                          value: r.revenue,
                          color: ['var(--primary)', 'var(--accent)', 'var(--info)', 'var(--success)', 'var(--warning)', 'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'][i % 8],
                        }))}
                      />
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="report-table">
                        <thead>
                          <tr>
                            <th scope="col">Route</th>
                            <th scope="col" className="text-center">Orders</th>
                            <th scope="col" className="text-right">Revenue</th>
                            <th scope="col" className="text-right">Weight</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.routeBreakdown.map((r, i) => (
                            <tr key={i}>
                              <td data-label="Route" className="fw-600">
                                <div className="flex items-center gap-6">
                                  <Truck size={14} className="text-primary flex-shrink-0" />
                                  {r.route}
                                </div>
                              </td>
                              <td data-label="Orders" className="text-center">{r.count}</td>
                              <td data-label="Revenue" className="text-right fw-600">{formatCurrency(r.revenue)}</td>
                              <td data-label="Weight" className="text-right text-secondary">{formatWeight(r.weight)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Detailed Order List ── */}
              <div className="card stagger-item mb-20" style={{ animationDelay: '420ms' }}>
                <div className="card-header flex justify-between items-center">
                  <h3 className="flex items-center gap-8">
                    <FileText size={18} className="text-primary" />
                    Detailed Order List
                  </h3>
                  <span className="badge text-primary" style={{ background: 'var(--primary-bg)' }}>
                    {data.orders.length} orders
                  </span>
                </div>
                <div className="card-body p-0">
                  <div style={{ overflowX: 'auto' }}>
                    <table className="report-table report-table-striped">
                      <thead>
                        <tr>
                          <th scope="col">Tracking #</th>
                          <th scope="col">Customer</th>
                          <th scope="col">Route</th>
                          <th scope="col">Status</th>
                          <th scope="col" className="text-right">Weight</th>
                          <th scope="col" className="text-right">Amount</th>
                          <th scope="col">Payment</th>
                          <th scope="col">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.orders.map((order) => (
                          <tr key={order.id}>
                            <td data-label="Tracking #" className="fw-600 text-primary" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                              {order.tracking_number}
                            </td>
                            <td data-label="Customer">
                              <div className="fw-500" style={{ fontSize: '0.85rem' }}>{order.sender_name || order.profiles?.name || '—'}</div>
                            </td>
                            <td data-label="Route" className="text-secondary" style={{ fontSize: '0.8rem' }}>
                              {order.origin || '—'} → {order.destination || '—'}
                            </td>
                            <td data-label="Status"><StatusBadge status={order.status} /></td>
                            <td data-label="Weight" className="text-right" style={{ fontSize: '0.85rem' }}>
                              {formatWeight(parseFloat(order.actual_weight || 0))}
                            </td>
                            <td data-label="Amount" className="text-right fw-600" style={{ fontSize: '0.85rem' }}>
                              {isOrderPriced(order) ? formatCurrency(parseFloat(order.shipping_cost || 0)) : '—'}
                            </td>
                            <td data-label="Payment">
                              <span className="badge text-capitalize" style={{
                                background: order.payment_method === 'cash' ? 'var(--success-bg)' : order.payment_method === 'gcash' ? 'var(--info-bg)' : 'var(--warning-bg)',
                                color: order.payment_method === 'cash' ? 'var(--success-text)' : order.payment_method === 'gcash' ? 'var(--info-text)' : 'var(--warning-text)',
                                fontSize: '0.7rem'
                              }}>
                                {order.payment_method || '—'}
                              </span>
                            </td>
                            <td data-label="Date" className="text-secondary" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                              {formatDate(order.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

            </>
          )}

          {/* ── Formal printed document (bond paper) — replaces UI in print ── */}
          {hasData && (
            <PrintDocument
              title={period === 'custom' ? 'Operations Report — Custom Period' : `${period.charAt(0).toUpperCase() + period.slice(1)} Operations Report`}
              subtitle={data.periodLabel}
              generatedAt={formatDateTime(data.generatedAt)}
              preparedBy={userProfile?.name}
            >
              {/* Summary */}
              <div className="pd-section">
                <div className="pd-section-title">I. Summary</div>
                <table className="pd-table">
                  <tbody>
                    <tr>
                      <td>Total Orders</td><td className="num">{s.totalOrders}</td>
                      <td>Total Revenue</td><td className="num">{formatCurrency(s.totalRevenue)}</td>
                    </tr>
                    <tr>
                      <td>Delivered</td><td className="num">{s.deliveredCount}</td>
                      <td>Total Collected</td><td className="num">{formatCurrency(s.totalCollected)}</td>
                    </tr>
                    <tr>
                      <td>In Transit / Processing</td><td className="num">{s.inTransitCount}</td>
                      <td>Outstanding Balance</td><td className="num">{formatCurrency(s.totalOutstanding)}</td>
                    </tr>
                    <tr>
                      <td>Pending</td><td className="num">{s.pendingCount}</td>
                      <td>Total Weight Shipped</td><td className="num">{formatWeight(s.totalWeight)}</td>
                    </tr>
                    <tr>
                      <td>Cancelled</td><td className="num">{s.cancelledCount}</td>
                      <td></td><td></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Status Breakdown */}
              <div className="pd-section">
                <div className="pd-section-title">II. Order Status Breakdown</div>
                <table className="pd-table">
                  <thead>
                    <tr><th scope="col">Status</th><th scope="col" className="ctr">Count</th><th scope="col" className="num">Percentage</th></tr>
                  </thead>
                  <tbody>
                    {STATUS_ORDER.filter(st => data.statusBreakdown[st]).map(st => (
                      <tr key={st}>
                        <td>{st}</td>
                        <td className="ctr">{data.statusBreakdown[st]}</td>
                        <td className="num">{s.totalOrders > 0 ? ((data.statusBreakdown[st] / s.totalOrders) * 100).toFixed(1) : 0}%</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td>Total</td><td className="ctr">{s.totalOrders}</td><td className="num">100%</td></tr>
                  </tfoot>
                </table>
              </div>

              {/* Payment Methods */}
              <div className="pd-section">
                <div className="pd-section-title">III. Collections by Payment Method</div>
                <table className="pd-table">
                  <thead>
                    <tr><th scope="col">Payment Method</th><th scope="col" className="ctr">Payments</th><th scope="col" className="num">Amount Collected</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>Cash</td><td className="ctr">{s.cashCount || 0}</td><td className="num">{formatCurrency(s.cashTotal)}</td></tr>
                    <tr><td>GCash</td><td className="ctr">{s.gcashCount || 0}</td><td className="num">{formatCurrency(s.gcashTotal)}</td></tr>
                    <tr><td>Pay Later</td><td className="ctr">{s.paylaterCount || 0}</td><td className="num">{formatCurrency(s.paylaterTotal)}</td></tr>
                    {(s.unattributedTotal || 0) > 0 && (
                      <tr><td>Unattributed</td><td className="ctr">—</td><td className="num">{formatCurrency(s.unattributedTotal)}</td></tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total Collected</td>
                      <td className="ctr">{(s.cashCount || 0) + (s.gcashCount || 0) + (s.paylaterCount || 0)}</td>
                      <td className="num">{formatCurrency(s.totalCollected)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Route Performance */}
              {data.routeBreakdown.length > 0 && (
                <div className="pd-section">
                  <div className="pd-section-title">IV. Route Performance</div>
                  <table className="pd-table">
                    <thead>
                      <tr><th scope="col">Route</th><th scope="col" className="ctr">Orders</th><th scope="col" className="num">Revenue</th><th scope="col" className="num">Weight</th></tr>
                    </thead>
                    <tbody>
                      {data.routeBreakdown.map((r, i) => (
                        <tr key={i}>
                          <td>{r.route}</td>
                          <td className="ctr">{r.count}</td>
                          <td className="num">{formatCurrency(r.revenue)}</td>
                          <td className="num">{formatWeight(r.weight)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Detailed Order List */}
              <div className="pd-section pd-flow">
                <div className="pd-section-title">{data.routeBreakdown.length > 0 ? 'V.' : 'IV.'} Detailed Order List ({data.orders.length} orders)</div>
                <table className="pd-table">
                  <thead>
                    <tr>
                      <th scope="col">Tracking No.</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Route</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">Weight</th>
                      <th scope="col" className="num">Amount</th>
                      <th scope="col" className="ctr">Payment</th>
                      <th scope="col">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.map(order => (
                      <tr key={order.id}>
                        <td>{order.tracking_number}</td>
                        <td>{order.sender_name || order.profiles?.name || '—'}</td>
                        <td>{order.origin || '—'} → {order.destination || '—'}</td>
                        <td>{order.status}</td>
                        <td className="num">{formatWeight(parseFloat(order.actual_weight || 0))}</td>
                        <td className="num">{isOrderPriced(order) ? formatCurrency(parseFloat(order.shipping_cost || 0)) : '—'}</td>
                        <td className="ctr text-capitalize">{order.payment_method || '—'}</td>
                        <td>{formatDate(order.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>Total</td>
                      <td className="num">{formatWeight(s.totalWeight)}</td>
                      <td className="num">{formatCurrency(s.totalRevenue)}</td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </PrintDocument>
          )}
        </div>
      )}
    </div>
  );
};

export default ReportsPage;
