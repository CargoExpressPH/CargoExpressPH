import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader, Mail, RefreshCw, XCircle } from 'lucide-react';
import { getEmailActivityLog, getEmailUsageSummary } from '../../lib/database';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDateTime } from '../../utils/datetime';
import { CenteredSpinner } from '../../components/ui/Loader';
import Pagination from '../../components/ui/Pagination';

const ACTIVITY_PAGE_SIZE = 10;

const number = (value) => Number(value || 0).toLocaleString('en-PH');

// Traffic-light thresholds for email usage: Safe up to 75%, Warning 76-90%,
// Danger above 90% — matches Resend's Free Plan limits (100/day, 3,000/month).
const emailUsageTone = (percent) => percent > 90 ? 'var(--error)' : percent > 75 ? 'var(--warning)' : 'var(--success)';
const emailUsageBadge = (percent) => percent > 90
  ? { className: 'badge-error', text: 'Limit Reached' }
  : percent > 75 ? { className: 'badge-warning', text: 'Warning' } : { className: 'badge-success', text: 'Safe' };

const EmailUsageBar = ({ label, used, limit }) => {
  const percent = limit > 0 ? Math.min((Number(used || 0) / limit) * 100, 100) : 0;
  const tone = emailUsageTone(percent);
  const badge = emailUsageBadge(percent);
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-8">
        <span className="flex items-center gap-8">{label} <span className={`badge ${badge.className}`}>{badge.text}</span></span>
        <span><strong>{number(used)}</strong> / {number(limit)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        style={{ height: 14, borderRadius: 999, overflow: 'hidden', background: 'var(--bg-secondary)' }}
      >
        <div style={{ width: `${percent}%`, height: '100%', background: tone, borderRadius: 999, transition: 'width 300ms ease' }} />
      </div>
    </div>
  );
};

const sourceLabel = (source) => source === 'announcement' ? 'Announcement' : 'Payment Reminder';

const EmailServiceTab = () => {
  usePageTitle('Storage Monitoring — Email Service');
  const toast = useToast();
  const [usageLoaded, setUsageLoaded] = useState(false);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [emailUsage, setEmailUsage] = useState(null);
  const [activity, setActivity] = useState([]);
  const [activityCount, setActivityCount] = useState(0);
  const [activityPage, setActivityPage] = useState(1);

  const loadUsage = useCallback(async () => {
    try {
      const usage = await getEmailUsageSummary();
      setEmailUsage(usage);
    } catch (error) {
      toast.error(error?.message || 'Could not load Email Usage.');
    } finally {
      setUsageLoaded(true);
    }
  }, [toast]);

  const loadActivity = useCallback(async (page) => {
    try {
      const { data, count } = await getEmailActivityLog({ page, pageSize: ACTIVITY_PAGE_SIZE });
      setActivity(data);
      setActivityCount(count);
    } catch (error) {
      toast.error(error?.message || 'Could not load Recent Email Activity.');
    } finally {
      setActivityLoaded(true);
    }
  }, [toast]);

  useEffect(() => { void loadUsage(); }, [loadUsage]);
  useEffect(() => { void loadActivity(activityPage); }, [activityPage, loadActivity]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.allSettled([loadUsage(), loadActivity(activityPage)]);
    setRefreshing(false);
  };

  if (!usageLoaded || !activityLoaded) return <CenteredSpinner />;

  const emailDailyLimit = Number(emailUsage?.daily_limit) || 100;
  const emailMonthlyLimit = Number(emailUsage?.monthly_limit) || 3000;
  const emailSentToday = Number(emailUsage?.emails_sent_today) || 0;
  const emailSentThisMonth = Number(emailUsage?.emails_sent_this_month) || 0;
  const emailDailyPercent = emailDailyLimit > 0 ? (emailSentToday / emailDailyLimit) * 100 : 0;
  const emailMonthlyPercent = emailMonthlyLimit > 0 ? (emailSentThisMonth / emailMonthlyLimit) * 100 : 0;
  const emailDailyOverWarning = emailDailyPercent > 90;
  const emailMonthlyOverWarning = emailMonthlyPercent > 90;

  return (
    <div>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Mail size={24} color="var(--primary)" aria-hidden="true" />Email Service</h1>
          <p className="admin-page-subtitle">Track Resend usage against the Free Plan limits and see recently sent emails.</p>
        </div>
        <button className="btn btn-outline" type="button" onClick={() => void handleRefresh()} disabled={refreshing}>
          {refreshing ? <Loader size={16} className="animate-spin" /> : <RefreshCw size={16} />} Refresh
        </button>
      </div>

      <section className="card admin-section-card mb-24">
        <div className="card-header"><h3><Mail size={17} className="inline mr-8" />Email Usage</h3></div>
        <div className="card-body">
          <p className="text-sm text-secondary" style={{ marginTop: 0 }}>
            Our email service lets us send a limited number of emails for free. This tracks payment reminders and announcement emails against those limits, so we don't run out unexpectedly.
          </p>
          {emailUsage ? (
            <>
              <div className="grid grid-2" style={{ marginTop: 16, gap: 24 }}>
                <EmailUsageBar label="Emails Sent Today" used={emailSentToday} limit={emailDailyLimit} />
                <EmailUsageBar label="Emails Sent This Month" used={emailSentThisMonth} limit={emailMonthlyLimit} />
              </div>

              {emailDailyOverWarning && (
                <div className="alert-banner alert-banner-error mt-16" role="status">
                  <AlertTriangle size={18} />
                  <span><strong>Warning:</strong> You are about to reach your daily email limit. Any emails beyond {number(emailDailyLimit)} will not be sent today.</span>
                </div>
              )}
              {emailMonthlyOverWarning && (
                <div className="alert-banner alert-banner-error mt-16" role="status">
                  <AlertTriangle size={18} />
                  <span><strong>Warning:</strong> You are about to reach this month's email limit. Any emails beyond {number(emailMonthlyLimit)} will not be sent this month.</span>
                </div>
              )}

              <p className="text-xs text-secondary" style={{ margin: '16px 0 0' }}>
                Counts reset automatically each day and each month, Philippine time.
              </p>
            </>
          ) : (
            <div className="alert-banner alert-banner-warning" role="status">
              <AlertTriangle size={17} />
              <span>Email usage could not be checked right now.</span>
            </div>
          )}
        </div>
      </section>

      <section className="card admin-section-card">
        <div className="card-header">
          <h3><Mail size={17} className="inline mr-8" />Recent Email Activity</h3>
        </div>
        {activity.length === 0 ? (
          <div className="card-body text-sm text-secondary">No email activity yet.</div>
        ) : (
          <>
            <div className="table-container"><table className="data-table"><thead><tr><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">Subject</th><th scope="col">Status</th></tr></thead>
              <tbody>{activity.map((row) => {
                const failed = row.status === 'failed';
                const Icon = failed ? XCircle : CheckCircle2;
                return <tr key={row.id}>
                  <td data-label="Date" className="text-sm">{formatPhDateTime(row.created_at)}</td>
                  <td data-label="Customer">
                    <div>{row.recipient_name || 'Customer'}</div>
                    <div className="text-xs text-secondary">{row.recipient_email}</div>
                  </td>
                  <td data-label="Subject" className="text-sm">
                    {row.subject}
                    {row.tracking_number && <div className="text-xs text-secondary">Order {row.tracking_number}</div>}
                    <div className="text-xs text-secondary">{sourceLabel(row.source)}</div>
                  </td>
                  <td data-label="Status"><span className={`badge ${failed ? 'badge-error' : 'badge-success'}`}><Icon size={13} /> {failed ? 'Failed' : 'Sent'}</span></td>
                </tr>;
              })}</tbody>
            </table></div>
            <Pagination
              totalItems={activityCount}
              currentPage={activityPage}
              itemsPerPage={ACTIVITY_PAGE_SIZE}
              onPageChange={setActivityPage}
            />
          </>
        )}
      </section>
    </div>
  );
};

export default EmailServiceTab;
