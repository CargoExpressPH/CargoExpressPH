import { useState, useEffect } from 'react';
import { getServiceSummary, withTimeout } from '../../lib/database';
import { useAuth } from '../../contexts/AuthContext';
import { logActivity } from '../../lib/activityLog';
import { SkeletonStatCard, SkeletonBarChart, SkeletonDonut } from '../../components/ui/SkeletonLoader';
import DonutChart from '../../components/ui/DonutChart';
import MiniBarChart from '../../components/ui/MiniBarChart';
import PrintDocument from '../../components/ui/PrintDocument';
import EmptyState from '../../components/ui/EmptyState';
import { exportPrintDocumentToPdf } from '../../lib/exportPdf';
import { MessageSquare, Printer, Download, Loader, RefreshCw, Clock, Headphones } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

/** Minutes → the largest unit that stays readable. */
const formatDuration = (minutes) => {
  if (minutes == null) return '—';
  const m = parseFloat(minutes);
  if (Number.isNaN(m)) return '—';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
};

const WEEK_LABEL = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });

/**
 * ServiceReportsPage — the customer-service half of the reporting picture.
 *
 * Lives in Sales & Reports beside the financial views because it answers the
 * same kind of question: how is the business actually performing. Every
 * figure is a measurement; none is compared to a target, because there is no
 * real traffic to calibrate a target against yet.
 */
const ServiceReportsPage = () => {
  usePageTitle('Service Reports');
  const { userProfile } = useAuth();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await withTimeout(getServiceSummary());
      setData(result);
      setLoadedAt(new Date());
    } catch (e) {
      setError(e.message || 'Failed to load service data.');
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    logActivity({ module: 'System', action: 'Service Report Printed', details: 'Printed customer service report' });
    window.print();
  };

  const handleExportPDF = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportPrintDocumentToPdf(`CargoExpress_ServiceReport_${new Date().toISOString().slice(0, 10)}.pdf`);
      logActivity({ module: 'System', action: 'Service Report Exported', details: 'Exported customer service report to PDF' });
    } catch (e) {
      console.error('PDF export failed:', e);
    } finally {
      setExporting(false);
    }
  };

  if (error) return (
    <div className="card text-center admin-error-card p-40">
      <h3>Error</h3>
      <p>{error}</p>
      <button type="button" className="btn btn-primary mt-md" onClick={load}>Retry</button>
    </div>
  );

  const q = data?.queue || {};
  const r = data?.response || {};
  const b = data?.bot || {};
  const inq = data?.inquiries || {};
  const volume = data?.volume || [];
  const hourly = data?.hourly || [];

  const botVoted = (b.helped || 0) + (b.notHelped || 0);
  const peakHour = hourly.reduce((best, h) => (h.customer_msgs > (best?.customer_msgs || 0) ? h : best), null);

  return (
    <div className="page-transition">
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Headphones size={24} color="var(--primary)" aria-hidden="true" />Customer Service</h1>
          <p className="admin-page-subtitle">
            Queue health, response times, and how much work the bot is absorbing.
          </p>
        </div>
        {!loading && data && (
          <div className="flex gap-8 no-print">
            <button type="button" className="btn btn-outline btn-sm" onClick={load}>
              <RefreshCw size={16} /> Refresh
            </button>
            <button type="button" className="btn btn-outline btn-sm" onClick={handleExportPDF} disabled={exporting}>
              {exporting ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
              Export PDF
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handlePrint}>
              <Printer size={16} /> Print
            </button>
          </div>
        )}
      </div>

      {/* The honesty banner. Without it these numbers read as an operational
          baseline, which they are not — they describe testing. */}
      <div
        className="mb-24 no-print"
        style={{
          background: 'var(--info-bg)', color: 'var(--info-dark)', border: '1px solid var(--info)',
          borderRadius: 8, padding: '12px 16px', fontSize: '0.8125rem', lineHeight: 1.6,
        }}
        role="note"
      >
        <strong>Pre-launch data.</strong> Chat support has not carried real customer traffic yet, so
        the response times below describe testing, not customers waiting. No targets are shown for
        the same reason — a target invented now would make every future comparison meaningless.
        These figures become a real baseline from the first month of live traffic.
      </div>

      {/* Queue snapshot */}
      <div className="grid grid-4 mb-24">
        {loading ? (
          Array.from({ length: 4 }, (_, i) => <SkeletonStatCard key={i} />)
        ) : (
          [
            { l: 'Waiting on us', v: q.waiting ?? 0, tone: (q.waiting > 0 ? 'warning' : 'success') },
            { l: `Waiting over 24h`, v: q.waitingOver24h ?? 0, tone: (q.waitingOver24h > 0 ? 'danger' : 'success') },
            { l: 'Awaiting customer', v: q.waitingCustomer ?? 0, tone: 'primary' },
            // Was 'Unassigned'. Support chat became a shared inbox in
            // 20260808150000, so no thread has an owner to lack and the RPC
            // stopped returning the figure. Escalations take the slot: it is
            // the other "needs attention" signal the queue carries.
            { l: 'Escalated', v: q.escalated ?? 0, tone: (q.escalated > 0 ? 'warning' : 'success') },
          ].map((c, i) => (
            <div key={i} className={`stat-card stat-card-${c.tone} stagger-item`} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="stat-value">{c.v}</div>
              <div className="stat-label">{c.l}</div>
            </div>
          ))
        )}
      </div>

      <div className="grid grid-2 mb-24">
        {/* Response times */}
        <div className="card admin-section-card stagger-item" style={{ animationDelay: '180ms' }}>
          <div className="card-header"><h3>Time to a human reply</h3></div>
          <div className="card-body">
            {loading ? <SkeletonBarChart height={140} bars={4} /> : (
              <>
                <div className="grid grid-2" style={{ gap: 16 }}>
                  {[
                    { l: 'Median', v: formatDuration(r.medianMinutes) },
                    { l: '90th percentile', v: formatDuration(r.p90Minutes) },
                    { l: 'Longest', v: formatDuration(r.worstMinutes) },
                    { l: 'Never answered', v: `${r.neverAnswered ?? 0}`, danger: (r.neverAnswered || 0) > 0 },
                  ].map((s, i) => (
                    <div key={i}>
                      <div
                        className="fw-700"
                        style={{ fontSize: '1.5rem', color: s.danger ? 'var(--error)' : 'var(--text)' }}
                      >
                        {s.v}
                      </div>
                      <div className="text-xs text-tertiary">{s.l}</div>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-tertiary mt-16" style={{ lineHeight: 1.6 }}>
                  Measured per message — every customer message paired with the next admin reply —
                  not just the first exchange in a thread. {r.answered ?? 0} of {r.customerMessages ?? 0} customer
                  messages received one.
                </div>
              </>
            )}
          </div>
        </div>

        {/* Bot deflection */}
        <div className="card admin-section-card stagger-item" style={{ animationDelay: '240ms' }}>
          <div className="card-header"><h3>Bot outcomes</h3></div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'center', padding: '20px 16px' }}>
            {loading ? <SkeletonDonut size={150} /> : botVoted === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No answers yet"
                description={`The bot has sent ${b.answered ?? 0} replies. Customers have not yet answered the "did that help?" prompt, so deflection cannot be measured.`}
              />
            ) : (
              <DonutChart
                size={150}
                thickness={24}
                centerLabel={`${Math.round(((b.helped || 0) / botVoted) * 100)}%`}
                centerSub="Helped"
                segments={[
                  { label: 'Helped', value: b.helped || 0, color: 'var(--success)' },
                  { label: 'Did not help', value: b.notHelped || 0, color: 'var(--warning)' },
                ].filter(s => s.value > 0)}
              />
            )}
          </div>
          {!loading && (
            <div className="card-body pt-0 text-xs text-tertiary" style={{ lineHeight: 1.6 }}>
              {b.unknown ?? 0} conversation{(b.unknown ?? 0) === 1 ? '' : 's'} with no answer recorded.
              Unknown is kept separate from “did not help” on purpose — never asking is not the same
              as failing.
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-2 mb-24">
        {/* Weekly volume */}
        <div className="card admin-section-card stagger-item" style={{ animationDelay: '300ms' }}>
          <div className="card-header"><h3>Messages per week</h3></div>
          <div className="card-body">
            {loading ? <SkeletonBarChart height={170} bars={8} /> : volume.length === 0 ? (
              <EmptyState icon={MessageSquare} title="No messages" description="No chat activity in the last 12 weeks." />
            ) : (
              <MiniBarChart
                height={170}
                bars={volume.map(v => ({
                  label: WEEK_LABEL(v.week),
                  value: v.customer_msgs,
                  color: 'var(--primary)',
                }))}
              />
            )}
          </div>
        </div>

        {/* Demand by hour */}
        <div className="card admin-section-card stagger-item" style={{ animationDelay: '360ms' }}>
          <div className="card-header"><h3>When customers write</h3></div>
          <div className="card-body">
            {loading ? <SkeletonBarChart height={170} bars={10} /> : hourly.length === 0 ? (
              <EmptyState icon={Clock} title="No data" description="No customer messages recorded yet." />
            ) : (
              <>
                <MiniBarChart
                  height={150}
                  bars={hourly.map(h => ({
                    label: `${h.hour}`,
                    value: h.customer_msgs,
                    color: 'var(--info)',
                  }))}
                />
                <div className="text-xs text-tertiary mt-12" style={{ lineHeight: 1.6 }}>
                  Hour of day, Asia/Manila.
                  {peakHour && <> Busiest is <strong>{peakHour.hour}:00</strong> — worth knowing when deciding when to check the queue.</>}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Contact inquiries */}
      <div className="card admin-section-card mb-24 stagger-item" style={{ animationDelay: '420ms' }}>
        <div className="card-header"><h3>Contact inquiries</h3></div>
        <div className="card-body">
          {loading ? <SkeletonBarChart height={80} bars={4} /> : (
            <div className="grid grid-4" style={{ gap: 16 }}>
              {[
                { l: 'Total', v: inq.total ?? 0 },
                { l: 'Awaiting action', v: (inq.new ?? 0) + (inq.read ?? 0) },
                { l: 'Unclaimed', v: inq.unassigned ?? 0 },
                { l: 'Median response', v: inq.measured > 0 ? formatDuration(inq.medianResponseMinutes) : '—' },
              ].map((s, i) => (
                <div key={i}>
                  <div className="fw-700" style={{ fontSize: '1.5rem' }}>{s.v}</div>
                  <div className="text-xs text-tertiary">{s.l}</div>
                </div>
              ))}
            </div>
          )}
          {!loading && (inq.measured ?? 0) === 0 && (
            <div className="text-xs text-tertiary mt-16" style={{ lineHeight: 1.6 }}>
              No response times recorded yet. The {inq.total ?? 0} existing inquiries predate the
              instrumentation and were deliberately left unstamped rather than backfilled with a
              fabricated timestamp.
            </div>
          )}
        </div>
      </div>

      {/* ── Printed document ── */}
      {!loading && data && (
        <PrintDocument
          title="Customer Service Report"
          subtitle="Queue Health, Response Times and Bot Deflection"
          generatedAt={loadedAt ? loadedAt.toLocaleString('en-PH', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : ''}
          preparedBy={userProfile?.name}
        >
          <div className="pd-section">
            <div className="pd-section-title">I. Queue Snapshot</div>
            <table className="pd-table">
              <tbody>
                <tr><td>Conversations, total</td><td className="num">{q.total ?? 0}</td></tr>
                <tr><td>Waiting on us</td><td className="num">{q.waiting ?? 0}</td></tr>
                <tr><td>Waiting over 24 hours</td><td className="num">{q.waitingOver24h ?? 0}</td></tr>
                <tr><td>Longest current wait</td><td className="num">{q.oldestWaitHours ?? 0} h</td></tr>
                <tr><td>Awaiting the customer</td><td className="num">{q.waitingCustomer ?? 0}</td></tr>
                <tr><td>Resolved</td><td className="num">{q.resolved ?? 0}</td></tr>
                <tr><td>Handled by bot only</td><td className="num">{q.botActive ?? 0}</td></tr>
                <tr><td>Escalated at some point</td><td className="num">{q.escalated ?? 0}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="pd-section">
            <div className="pd-section-title">II. Response Times</div>
            <p style={{ fontSize: '0.8rem', marginBottom: 8 }}>
              Pre-launch: these describe testing, not live customer traffic. No targets are set.
            </p>
            <table className="pd-table">
              <tbody>
                <tr><td>Customer messages</td><td className="num">{r.customerMessages ?? 0}</td></tr>
                <tr><td>Received a human reply</td><td className="num">{r.answered ?? 0}</td></tr>
                <tr><td>Never answered</td><td className="num">{r.neverAnswered ?? 0}</td></tr>
                <tr><td>Median time to reply</td><td className="num">{formatDuration(r.medianMinutes)}</td></tr>
                <tr><td>90th percentile</td><td className="num">{formatDuration(r.p90Minutes)}</td></tr>
                <tr><td>Longest</td><td className="num">{formatDuration(r.worstMinutes)}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="pd-section">
            <div className="pd-section-title">III. Bot Deflection</div>
            <table className="pd-table">
              <tbody>
                <tr><td>Bot replies sent</td><td className="num">{b.answered ?? 0}</td></tr>
                <tr><td>Customer confirmed it helped</td><td className="num">{b.helped ?? 0}</td></tr>
                <tr><td>Customer said it did not help</td><td className="num">{b.notHelped ?? 0}</td></tr>
                <tr><td>No answer recorded</td><td className="num">{b.unknown ?? 0}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="pd-section">
            <div className="pd-section-title">IV. Contact Inquiries</div>
            <table className="pd-table">
              <tbody>
                <tr><td>Total</td><td className="num">{inq.total ?? 0}</td></tr>
                <tr><td>New</td><td className="num">{inq.new ?? 0}</td></tr>
                <tr><td>Read, not resolved</td><td className="num">{inq.read ?? 0}</td></tr>
                <tr><td>Resolved</td><td className="num">{inq.resolved ?? 0}</td></tr>
                <tr><td>Unclaimed</td><td className="num">{inq.unassigned ?? 0}</td></tr>
                <tr><td>Median time to first action</td><td className="num">{inq.measured > 0 ? formatDuration(inq.medianResponseMinutes) : 'Not yet measured'}</td></tr>
              </tbody>
            </table>
          </div>

          {volume.length > 0 && (
            <div className="pd-section pd-flow">
              <div className="pd-section-title">V. Weekly Volume</div>
              <table className="pd-table">
                <thead>
                  <tr><th scope="col">Week of</th><th scope="col" className="num">Customer</th><th scope="col" className="num">Bot</th><th scope="col" className="num">Admin</th></tr>
                </thead>
                <tbody>
                  {volume.map((v, i) => (
                    <tr key={i}>
                      <td>{WEEK_LABEL(v.week)}</td>
                      <td className="num">{v.customer_msgs}</td>
                      <td className="num">{v.bot_msgs}</td>
                      <td className="num">{v.admin_msgs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PrintDocument>
      )}
    </div>
  );
};

export default ServiceReportsPage;
