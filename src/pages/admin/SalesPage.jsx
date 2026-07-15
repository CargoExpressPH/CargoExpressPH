import { useState, useEffect } from 'react';
import { getSalesData, withTimeout } from '../../lib/database';
import { SkeletonStatCard, SkeletonDonut, SkeletonBarChart } from '../../components/ui/SkeletonLoader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import DonutChart from '../../components/ui/DonutChart';
import MiniBarChart from '../../components/ui/MiniBarChart';
import { DollarSign } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

const SalesPage = () => {
  usePageTitle('Sales');
  const [data, setData] = useState(null); 
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => { loadSales(); }, []);
  const loadSales = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await withTimeout(getSalesData());
      setData(result);
    } catch (e) {
      setError(e.message || 'Failed to load sales data.');
    } finally {
      setLoading(false);
    }
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
      </div>

      {/* Stat Cards */}
      <div className="grid grid-4 mb-24">
        {loading ? (
          Array.from({ length: 4 }, (_, i) => <SkeletonStatCard key={i} />)
        ) : (
          [
            {l:'Total Revenue', v:s.totalRevenue||0, g:'linear-gradient(135deg,var(--primary),var(--primary-light))', prefix:'₱'},
            {l:'Collected', v:s.paidTotal||0, g:'linear-gradient(135deg,var(--success),var(--success-dark, #059669))', prefix:'₱'},
            {l:'Outstanding', v:s.unpaidTotal||0, g:'linear-gradient(135deg,var(--error),var(--error-dark, #dc2626))', prefix:'₱'},
            {l:'Unpaid Orders', v:s.unpaidCount||0, g:'linear-gradient(135deg,var(--warning),var(--warning-dark, #d97706))', prefix:''}
          ].map((c,i)=>(
            <div key={i} className="stat-card stagger-item text-white" style={{background:c.g, animationDelay: `${i * 60}ms`}}>
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
              <div className="text-center text-secondary p-20">No sales data</div>
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
    </div>
  );
};
export default SalesPage;
