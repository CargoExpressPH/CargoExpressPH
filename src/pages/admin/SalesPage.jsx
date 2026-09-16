import { useState, useEffect } from 'react';
import { getSalesOverviewData } from '../../lib/database';
import { useAuth } from '../../contexts/AuthContext';
import { CenteredSpinner } from '../../components/ui/Loader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import EmptyState from '../../components/ui/EmptyState';
import { Wallet, CheckCircle, Package, TrendingUp, AlertTriangle } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import MiniBarChart from '../../components/ui/MiniBarChart';

const formatCurrency = (val) => `₱${(val || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SalesPage = () => {
  usePageTitle('Sales Overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getSalesOverviewData();
      setData(result);
    } catch (e) {
      setError(e.message || 'Failed to load sales overview.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-transition">
      <div className="admin-page-header no-print">
        <div>
          <h1 className="admin-page-title">
            <TrendingUp size={24} color="var(--primary)" aria-hidden="true" />
            Sales Overview
          </h1>
          <p className="admin-page-subtitle">Real-time collections and outstanding balances</p>
        </div>
      </div>

      {error && (
        <div className="card p-24 text-center text-error mt-16">
          <AlertTriangle size={32} className="mb-8" />
          <p>{error}</p>
          <button type="button" className="btn btn-primary btn-sm mt-12" onClick={loadData}>Retry</button>
        </div>
      )}

      {loading && <CenteredSpinner />}

      {!loading && data && (
        <>
          <div className="grid grid-4 report-summary-cards mb-24 mt-16">
            <div className="stat-card stat-card-info stagger-item" style={{ animationDelay: '0ms' }}>
              <div className="stat-value"><AnimatedCounter value={data.collectedToday} prefix="₱" decimals={2} duration={1000} /></div>
              <div className="stat-label">Collected Today</div>
            </div>
            <div className="stat-card stat-card-success stagger-item" style={{ animationDelay: '60ms' }}>
              <div className="stat-value"><AnimatedCounter value={data.netCollectedThisMonth} prefix="₱" decimals={2} duration={1000} /></div>
              <div className="stat-label">Net Collected This Month</div>
            </div>
            <div className="stat-card stat-card-warning stagger-item" style={{ animationDelay: '120ms' }}>
              <div className="stat-value"><AnimatedCounter value={data.currentUnpaidBalance} prefix="₱" decimals={2} duration={1000} /></div>
              <div className="stat-label">Current Unpaid Balance</div>
            </div>
            <div className="stat-card stat-card-error stagger-item" style={{ animationDelay: '180ms' }}>
              <div className="stat-value"><AnimatedCounter value={data.deliveredButUnpaid} prefix="₱" decimals={2} duration={1000} /></div>
              <div className="stat-label">Delivered but Unpaid</div>
            </div>
          </div>

          <div className="card stagger-item mb-20" style={{ animationDelay: '240ms' }}>
            <div className="card-header">
              <h3 className="flex items-center gap-8">
                <TrendingUp size={18} className="text-primary" />
                Current Year Monthly Collections
              </h3>
            </div>
            <div className="card-body p-24">
              <MiniBarChart 
                data={data.monthlyChart.map(m => ({ label: new Date(2026, m.mth - 1, 1).toLocaleString('default', { month: 'short' }), value: m.net }))} 
                height={250}
                formatValue={formatCurrency}
                color="var(--success)"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default SalesPage;
