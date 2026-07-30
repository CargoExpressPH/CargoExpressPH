import { useState, useEffect } from 'react';
import { getSalesData, withTimeout } from '../../lib/database';
import { useAuth } from '../../contexts/AuthContext';
import { logActivity } from '../../lib/activityLog';
import { SkeletonStatCard, SkeletonDonut, SkeletonBarChart } from '../../components/ui/SkeletonLoader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import DonutChart from '../../components/ui/DonutChart';
import MiniBarChart from '../../components/ui/MiniBarChart';
import PrintDocument from '../../components/ui/PrintDocument';
import { DollarSign, CheckCircle, AlertTriangle, Clock, Printer } from 'lucide-react';
import EmptyState from '../../components/ui/EmptyState';
import usePageTitle from '../../hooks/usePageTitle';

const formatCurrency = (val) => `₱${(val || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SalesPage = () => {
  usePageTitle('Sales');
  const { userProfile } = useAuth();
  const [data, setData] = useState(null); 
  const [loadedAt, setLoadedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => { loadSales(); }, []);
  const loadSales = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await withTimeout(getSalesData());
      setData(result);
      setLoadedAt(new Date());
    } catch (e) {
      setError(e.message || 'Failed to load sales data.');
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    logActivity({ module: 'Sales & Reports', action: 'Sales Report Printed', details: 'Printed sales & revenue report' });
    window.print();
  };

  if (error) return (
    <div className="page-transition">
      <div className="card text-center admin-error-card p-40">
        <h3>Error</h3>
        <p>{error}</p>
        <button type="button" className="btn btn-primary mt-md" onClick={loadSales}>Retry</button>
      </div>
    </div>
  );

  const s = data?.summary || {};

  const paymentMethods = [
    {l:'Cash', v:s.cashTotal || 0, c:'var(--success)'},
    {l:'GCash', v:s.gcashTotal || 0, c:'var(--info)'},
    {l:'Pay Later', v:s.paylaterTotal || 0, c:'var(--warning)'}
  ];

  const monthlySales = data?.monthlySales || [];

  return (
    <div className="page-transition">
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">Sales & Revenue</h1>
          <p className="admin-page-subtitle">Revenue, collection health, and payment method performance.</p>
        </div>
        {!loading && data && (
          <button type="button" className="btn btn-primary btn-sm" onClick={handlePrint}>
            <Printer size={16} />
            Print Report
          </button>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-4 mb-24">
        {loading ? (
          Array.from({ length: 4 }, (_, i) => <SkeletonStatCard key={i} />)
        ) : (
          [
            { l: 'Total Revenue', v: s.totalRevenue || 0, tone: 'primary', prefix: '₱' },
            { l: 'Collected', v: s.paidTotal || 0, tone: 'success', prefix: '₱' },
            { l: 'Outstanding', v: s.unpaidTotal || 0, tone: 'danger', prefix: '₱' },
            { l: 'Unpaid Orders', v: s.unpaidCount || 0, tone: 'warning', prefix: '' }
          ].map((c, i) => (
            <div key={i} className={`stat-card stat-card-${c.tone} stagger-item`} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="stat-value">
                <AnimatedCounter value={c.v} prefix={c.prefix} decimals={0} duration={1200} />
              </div>
              <div className="stat-label">{c.l}</div>
            </div>
          ))
        )}
      </div>

      <div className="grid grid-2 mb-24">
        {/* Payment Methods */}
        <div className="card admin-section-card stagger-item" style={{ animationDelay: '240ms' }}>
          <div className="card-header"><h3>Payment Methods</h3></div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'center', padding: '24px 16px' }}>
            {loading ? <SkeletonDonut size={170} /> : (
              <DonutChart
                size={170}
                thickness={26}
                centerLabel={`₱${((s.paidTotal || 0) / 1000).toFixed(0)}k`}
                centerSub="Collected"
                segments={[
                  { label: 'Cash', value: s.cashTotal || 0, color: 'var(--success)' },
                  { label: 'GCash', value: s.gcashTotal || 0, color: 'var(--info)' },
                  { label: 'Pay Later', value: s.paylaterTotal || 0, color: 'var(--warning)' },
                ].filter(seg => seg.value > 0)}
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
                <tr><td>Outstanding Balance</td><td className="num">{formatCurrency(s.unpaidTotal)}</td></tr>
                <tr><td>Orders with Unpaid Balance</td><td className="num">{s.unpaidCount || 0}</td></tr>
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
