import { useState, useEffect, useCallback, useRef } from 'react';
import { getSalesOverviewData } from '../../lib/database';
import { useAuth } from '../../contexts/AuthContext';
import { CenteredSpinner } from '../../components/ui/Loader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import { TrendingUp, AlertTriangle, RefreshCw } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import useRealtimeOrders from '../../hooks/useRealtimeOrders';
import MiniBarChart from '../../components/ui/MiniBarChart';
import { formatPhDateTime, phDateKey } from '../../utils/datetime';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SalesPage = () => {
  usePageTitle('Sales Overview');
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const dataRef = useRef(null);
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);

  const loadData = useCallback(async ({ background = false } = {}) => {
    const sequence = ++requestSequenceRef.current;
    const keepVisible = background && Boolean(dataRef.current);
    if (keepVisible) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const result = await getSalesOverviewData();
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      dataRef.current = result;
      setData(result);
      setLastUpdated(new Date());
    } catch (e) {
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      setError('We couldn’t refresh the sales totals. The last successful totals remain on screen.');
    } finally {
      if (mountedRef.current && sequence === requestSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadData();
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, [loadData]);

  useEffect(() => {
    const refreshOnFocus = () => { void loadData({ background: true }); };
    window.addEventListener('focus', refreshOnFocus);
    window.addEventListener('pageshow', refreshOnFocus);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      window.removeEventListener('pageshow', refreshOnFocus);
    };
  }, [loadData]);

  // “Today” is a Manila business day. This timer is based on +08:00 rather
  // than the browser's timezone and is recreated after every boundary.
  useEffect(() => {
    let timerId;
    const scheduleNextManilaMidnight = () => {
      const now = Date.now();
      const today = phDateKey(new Date(now));
      const nextMidnight = new Date(today + 'T00:00:00+08:00').getTime() + 86400000;
      timerId = window.setTimeout(() => {
        void loadData({ background: true });
        scheduleNextManilaMidnight();
      }, Math.max(1000, nextMidnight - now + 250));
    };
    scheduleNextManilaMidnight();
    return () => window.clearTimeout(timerId);
  }, [loadData]);

  const handleOrderChanges = useCallback(() => {
    void loadData({ background: true });
  }, [loadData]);

  useRealtimeOrders({
    enabled: Boolean(user?.id) && !loading,
    channelName: 'sales_overview',
    userId: user?.id,
    debounceMs: 1200,
    onBatch: handleOrderChanges,
  });

  return (
    <div className="page-transition">
      <div className="admin-page-header no-print">
        <div>
          <h1 className="admin-page-title">
            <TrendingUp size={24} color="var(--primary)" aria-hidden="true" />
            Sales Overview
          </h1>
          <p className="admin-page-subtitle">
            Payments received and unpaid shipment amounts. Totals update automatically.
            {lastUpdated && <> · Last updated {formatPhDateTime(lastUpdated)}</>}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => loadData({ background: true })}
          disabled={loading || refreshing}
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="alert-banner alert-banner-error mt-16" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
          {data && <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadData({ background: true })}>Try again</button>}
        </div>
      )}

      {loading && !data && <CenteredSpinner />}

      {data && (
        <>
          <div className="grid grid-4 report-summary-cards mb-24 mt-16">
            <div className="stat-card stat-card-info stagger-item" style={{ animationDelay: '0ms' }}>
              <div className="stat-value"><AnimatedCounter value={data.collectedToday} prefix="₱" decimals={2} duration={1000} /></div>
              <div className="stat-label">Payments After Refunds Today</div>
            </div>
            <div className="stat-card stat-card-success stagger-item" style={{ animationDelay: '60ms' }}>
              <div className="stat-value"><AnimatedCounter value={data.netCollectedThisMonth} prefix="₱" decimals={2} duration={1000} /></div>
              <div className="stat-label">Payments After Refunds This Month</div>
            </div>
            <div className="stat-card stat-card-warning stagger-item" style={{ animationDelay: '120ms' }}>
              <div className="stat-value"><AnimatedCounter value={data.currentUnpaidBalance} prefix="₱" decimals={2} duration={1000} /></div>
              <div className="stat-label">Total Amount Still Unpaid</div>
            </div>
            <div className="stat-card stat-card-error stagger-item" style={{ animationDelay: '180ms' }}>
              <div className="stat-value"><AnimatedCounter value={data.deliveredButUnpaid} prefix="₱" decimals={2} duration={1000} /></div>
              <div className="stat-label">Unpaid Amount for Delivered Shipments</div>
            </div>
          </div>
          <p className="text-secondary fs-12 mb-20">
            Payments after refunds are payments received minus successful refunds. Unpaid totals are the amounts still due on current shipments.
          </p>

          <div className="card stagger-item mb-20" style={{ animationDelay: '240ms' }}>
            <div className="card-header">
              <h3 className="flex items-center gap-8">
                <TrendingUp size={18} className="text-primary" />
                Payments After Refunds by Month This Year
              </h3>
            </div>
            <div className="card-body p-24">
              <p className="text-secondary fs-12 mb-16">
                Each bar shows payments received minus successful refunds for one month this year.
              </p>
              <MiniBarChart
                data={(data.monthlyChart || []).map(month => ({
                  label: MONTH_LABELS[Number(month.mth) - 1] || String(month.mth),
                  value: Number(month.net || 0),
                }))}
                height={250}
                valuePrefix="₱"
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
