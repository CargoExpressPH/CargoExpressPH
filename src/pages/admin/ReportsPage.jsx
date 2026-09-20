import { useState } from 'react';
import { getFinancialReportData } from '../../lib/database';
import { logActivity } from '../../lib/activityLog';
import { useAuth } from '../../contexts/AuthContext';
import { CenteredSpinner } from '../../components/ui/Loader';
import AnimatedCounter from '../../components/ui/AnimatedCounter';
import StatusBadge from '../../components/ui/StatusBadge';
import EmptyState from '../../components/ui/EmptyState';
import PrintDocument from '../../components/ui/PrintDocument';
import MiniBarChart from '../../components/ui/MiniBarChart';
import DatePicker from '../../components/ui/DatePicker';
import { exportPrintDocumentToPdf } from '../../lib/exportPdf';
import {
  FileText, Printer, Package, CheckCircle,
  PhilippinePeso, TrendingUp, Truck, MapPin, BarChart3,
  RefreshCw, CreditCard, Loader, AlertTriangle, Download, ArrowRight, XCircle
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

const formatCurrency = (val) => `₱${(val || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatDate = (d) => new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
const formatDateTime = (d) => new Date(d).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

const formatReportDate = (isoDate) => {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
};

const buildReportFilename = (start, end, withExt = true) => {
  const startLabel = formatReportDate(start);
  const endLabel = formatReportDate(end);
  const label = start === end ? startLabel : `${startLabel} to ${endLabel}`;
  return `CargoExpress PH Report (${label})${withExt ? '.pdf' : ''}`;
};

const ReportsPage = () => {
  usePageTitle('Reports');
  const { userProfile } = useAuth();
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [reportedStart, setReportedStart] = useState('');
  const [reportedEnd, setReportedEnd] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  
  const hasCustomDateRange = customStart && customEnd;
  const customDateRangeInvalid = Boolean(hasCustomDateRange && customEnd < customStart);

  const loadReport = async () => {
    if (!customStart || !customEnd) {
      setError('Choose a start date and an end date to create a report.');
      return;
    }
    if (customDateRangeInvalid) {
      setError('The end date must be the same as or after the start date.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getFinancialReportData(customStart, customEnd);
      setData(result);
      setReportedStart(customStart);
      setReportedEnd(customEnd);
    } catch (e) {
      setError('We couldn’t load this report. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    logActivity({ module: 'Sales & Reports', action: 'Report Printed', details: `Printed report for ${reportedStart} to ${reportedEnd}` });
    const originalTitle = document.title;
    if (reportedStart) {
      document.title = buildReportFilename(reportedStart, reportedEnd, false);
    }
    const restore = () => {
      document.title = originalTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    requestAnimationFrame(() => window.print());
  };

  const handleExportPDF = async () => {
    if ((!data?.completedDeliveries?.length && !data?.paymentRefundDetail?.length) || exporting) return;
    setExporting(true);
    try {
      const filename = reportedStart
        ? buildReportFilename(reportedStart, reportedEnd)
        : 'CargoExpress PH Report.pdf';
      await exportPrintDocumentToPdf(filename);
      logActivity({ module: 'Sales & Reports', action: 'Report Exported', details: `Exported report for ${reportedStart} to ${reportedEnd} to PDF` });
    } catch (e) {
      console.error('PDF export failed:', e);
    } finally {
      setExporting(false);
    }
  };

  const hasData = data && (data.completedDeliveries?.length > 0 || data.paymentRefundDetail?.length > 0);

  return (
    <div className="page-transition">
      <div className="report-controls no-print">
        <div>
          <h1 className="admin-page-title">
            <FileText size={24} color="var(--primary)" aria-hidden="true" />
            Reports & Analytics
          </h1>
          <p className="admin-page-subtitle">
            Payments and refunds recorded within your selected dates.
          </p>
        </div>
        <div className="flex gap-8">
          <button type="button" className="btn btn-ghost btn-sm" onClick={loadReport} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          {hasData && (
            <>
              <button type="button" className="btn btn-primary btn-sm" onClick={handlePrint}>
                <Printer size={16} />
                Print Report
              </button>
            </>
          )}
        </div>
      </div>

      <div className="report-custom-range no-print stagger-item">
        <div className="report-date-inputs">
          <div className="form-group">
            <label className="form-label" htmlFor="report-start-date">Start Date</label>
            <DatePicker
              id="report-start-date"
              value={customStart}
              max={customEnd || undefined}
              onChange={val => { setCustomStart(val); if (error) setError(null); }}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="report-end-date">End Date</label>
            <DatePicker
              id="report-end-date"
              value={customEnd}
              min={customStart || undefined}
              onChange={val => { setCustomEnd(val); if (error) setError(null); }}
            />
          </div>
        </div>
        {customDateRangeInvalid && (
          <p className="form-error">The end date must be the same as or after the start date.</p>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={loadReport}
          disabled={!customStart || !customEnd || customDateRangeInvalid || loading}
        >
          {loading ? <Loader size={16} className="animate-spin" /> : <BarChart3 size={16} />}
          Create Report
        </button>
      </div>

      {error && (
        <div className="card p-24 text-center text-error mt-16">
          <AlertTriangle size={32} className="mb-8" />
          <p>{error}</p>
          <button type="button" className="btn btn-primary btn-sm mt-12" onClick={loadReport}>Retry</button>
        </div>
      )}

      {loading && <CenteredSpinner />}

      {!loading && data && (
        <div>
          {!hasData && (
            <EmptyState
              icon={FileText}
              title="No activity found"
              description={`No payments, refunds, or shipments delivered between ${reportedStart} and ${reportedEnd}.`}
            />
          )}

          {hasData && (
            <>
              <div className="grid grid-4 report-summary-cards mb-20 mt-16">
                <div className="stat-card stat-card-info stagger-item" style={{ animationDelay: '0ms' }}>
                  <div className="stat-value"><AnimatedCounter value={data.grossCollected} prefix="₱" decimals={2} duration={1000} /></div>
                  <div className="stat-label">Payments Received</div>
                </div>
                <div className="stat-card stat-card-warning stagger-item" style={{ animationDelay: '60ms' }}>
                  <div className="stat-value"><AnimatedCounter value={data.successfulRefunds} prefix="₱" decimals={2} duration={1000} /></div>
                  <div className="stat-label">Money Returned</div>
                </div>
                <div className="stat-card stat-card-success stagger-item" style={{ animationDelay: '120ms' }}>
                  <div className="stat-value"><AnimatedCounter value={data.netCollected} prefix="₱" decimals={2} duration={1000} /></div>
                  <div className="stat-label">Payments After Refunds</div>
                </div>
                <div className="stat-card stat-card-primary stagger-item" style={{ animationDelay: '180ms' }}>
                  <div className="stat-value"><AnimatedCounter value={data.deliveredShipmentValue} prefix="₱" decimals={2} duration={1000} /></div>
                  <div className="stat-label">Cargo Fees for Delivered Shipments</div>
                </div>
              </div>
              <p className="text-secondary fs-12 mb-20">
                Payments received, money returned, and payments after refunds use events recorded within your selected dates. Money returned includes successful refunds only. Cargo fees are the current fees for shipments delivered during those dates, not payments received.
              </p>

              <div className="grid grid-2 mb-20 no-print">
                <div className="card stagger-item mb-20" style={{ animationDelay: '200ms' }}>
                  <div className="card-header">
                    <h3 className="flex items-center gap-8">
                      <BarChart3 size={18} className="text-primary" />
                      Payments After Refunds by Day
                    </h3>
                  </div>
                  <div className="card-body p-24">
                    {data.dailyChart?.length > 0 ? (
                      <MiniBarChart 
                        data={data.dailyChart.map(d => ({ label: formatDate(d.day), value: d.net }))} 
                        height={250}
                        formatValue={formatCurrency}
                        color="var(--primary)"
                      />
                    ) : (
                      <div className="text-center text-secondary py-32">No daily payment or refund data for these dates.</div>
                    )}
                  </div>
                </div>
                
                <div className="card stagger-item mb-20" style={{ animationDelay: '240ms' }}>
                   <div className="card-header">
                      <h3 className="flex items-center gap-8">
                        <TrendingUp size={18} className="text-primary" />
                        Payment and Refund Entries
                      </h3>
                   </div>
                   <div className="card-body">
                      <div className="report-table-wrap" style={{ maxHeight: '250px', overflowY: 'auto' }}>
                         <table className="report-table">
                            <thead>
                               <tr>
                                  <th scope="col">Type</th>
                                  <th scope="col">Date</th>
                                  <th scope="col">Amount</th>
                               </tr>
                            </thead>
                            <tbody>
                               {data.paymentRefundDetail?.slice(0, 50).map((dt, idx) => (
                                  <tr key={idx}>
                                  <td data-label="Type"><span className={`badge ${dt.type === 'refund' ? 'badge-warning' : 'badge-success'}`}>{dt.type === 'refund' ? 'Refund' : 'Payment'}</span></td>
                                     <td data-label="Date">{formatDate(dt.event_date)}</td>
                                     <td data-label="Amount" className="fw-600">{formatCurrency(dt.amount)}</td>
                                  </tr>
                               ))}
                               {(!data.paymentRefundDetail || data.paymentRefundDetail.length === 0) && (
                                  <tr><td colSpan="3" className="text-center text-secondary">No payment or refund entries.</td></tr>
                               )}
                            </tbody>
                         </table>
                      </div>
                   </div>
                </div>

                <div className="card stagger-item" style={{ animationDelay: '260ms', gridColumn: '1 / -1' }}>
                  <div className="card-header">
                    <h3 className="flex items-center gap-8">
                      <CreditCard size={18} className="text-primary" />
                      Payments and Refunds in Selected Dates
                    </h3>
                  </div>
                  <div className="card-body">
                    <div className="report-table-wrap">
                      <table className="report-table">
                        <thead>
                          <tr>
                            <th scope="col">How Customers Paid</th>
                            <th scope="col" className="text-right">Payments Received</th>
                            <th scope="col" className="text-right">Money Returned</th>
                            <th scope="col" className="text-right">Payments After Refunds</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.methodTotals?.map((mt, idx) => (
                            <tr key={idx}>
                              <td data-label="How Customers Paid" className="text-capitalize">{mt.method} <span className="text-secondary fs-12">({mt.payment_count} payment{mt.payment_count === 1 ? '' : 's'})</span></td>
                              <td data-label="Payments Received" className="text-right fw-500 text-info">{formatCurrency(mt.gross)}</td>
                              <td data-label="Money Returned" className="text-right fw-500 text-warning">{formatCurrency(mt.refunds)}</td>
                              <td data-label="Payments After Refunds" className="text-right fw-600 text-success">{formatCurrency(mt.net)}</td>
                            </tr>
                          ))}
                          {(!data.methodTotals || data.methodTotals.length === 0) && (
                            <tr><td colSpan="4" className="text-center text-secondary">No payments received.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-secondary mt-8 mb-0">
                      Returns are listed under the original payment method, even if the money was returned another way. Money returned includes successful refunds only.
                    </p>
                  </div>
                </div>
              </div>

              <div className="card stagger-item mb-20" style={{ animationDelay: '280ms' }}>
                <div className="card-header flex justify-between items-center">
                  <h3 className="flex items-center gap-8">
                    <Package size={18} className="text-primary" />
                    Shipments Delivered During Selected Dates
                  </h3>
                  <span className="badge badge-primary">{data.completedDeliveries?.length || 0} shipments</span>
                </div>
                <div className="card-body p-0">
                  <p className="text-secondary fs-12" style={{ padding: '0 16px 12px' }}>
                    Payments and refunds above were recorded within the selected dates. Below are each delivered shipment's current cargo fee, amount paid, and amount still unpaid as of {formatDateTime(data.generatedAt)}. These amounts are not payments received and do not need to add up to the payment totals above.
                  </p>
                  <div className="table-responsive">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Tracking #</th>
                          <th scope="col">Customer</th>
                          <th scope="col">Route</th>
                          <th scope="col">Delivered On</th>
                          <th scope="col" className="text-right">Final Cargo Fee</th>
                          <th scope="col" className="text-right">Amount Paid</th>
                          <th scope="col" className="text-right">Amount Still Unpaid</th>
                          <th scope="col" className="text-center">Payment Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.completedDeliveries?.map(order => (
                          <tr key={order.id}>
                            <td className="fw-600 text-primary">{order.tracking_number}</td>
                            <td>
                              <div className="fw-500">{order.sender_name}</div>
                              <div className="text-secondary fs-12">to {order.receiver_name}</div>
                            </td>
                            <td>
                              <div className="flex items-center gap-4 text-secondary fs-13">
                                {order.origin} <ArrowRight size={12} /> {order.destination}
                              </div>
                            </td>
                            <td>{formatDate(order.delivered_at)}</td>
                            <td className="text-right fw-500">{formatCurrency(order.final_fee)}</td>
                            <td className="text-right text-success">{formatCurrency(order.amount_paid)}</td>
                            <td className="text-right text-warning fw-600">{formatCurrency(order.balance)}</td>
                            <td className="text-center"><StatusBadge status={order.payment_status === 'paid' ? 'Paid' : 'Pending'} /></td>
                          </tr>
                        ))}
                        {(!data.completedDeliveries || data.completedDeliveries.length === 0) && (
                          <tr><td colSpan="8" className="text-center text-secondary py-32">No shipments were delivered during these dates.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              
              <PrintDocument 
                title="Payments and Delivery Report"
                subtitle={`Selected dates: ${reportedStart} to ${reportedEnd}`}
                generatedAt={formatDateTime(data.generatedAt)}
                preparedBy={userProfile?.name}
              >
                <div className="pd-section">
                  <div className="pd-summary-grid" style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
                    <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Payments Received</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{formatCurrency(data.grossCollected)}</div>
                    </div>
                    <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Money Returned</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{formatCurrency(data.successfulRefunds)}</div>
                    </div>
                    <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Payments After Refunds</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{formatCurrency(data.netCollected)}</div>
                    </div>
                    <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Cargo Fees for Delivered Shipments</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{formatCurrency(data.deliveredShipmentValue)}</div>
                    </div>
                  </div>
                </div>

                <div className="pd-section">
                  <h4 className="pd-section-title">Payments and Refunds in Selected Dates</h4>
                  <table className="pd-table">
                    <thead>
                      <tr>
                        <th scope="col">How Customers Paid</th>
                        <th scope="col" style={{ textAlign: 'right' }}>Payments Received</th>
                        <th scope="col" style={{ textAlign: 'right' }}>Money Returned</th>
                        <th scope="col" style={{ textAlign: 'right' }}>Payments After Refunds</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.methodTotals?.map((mt, idx) => (
                        <tr key={idx}>
                          <td style={{ textTransform: 'capitalize' }}>{mt.method} ({mt.payment_count} payment{mt.payment_count === 1 ? '' : 's'})</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(mt.gross)}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(mt.refunds)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{formatCurrency(mt.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ fontSize: '10px', color: '#666', margin: '8px 0 0' }}>
                    Returns are listed under the original payment method, even if the money was returned another way. Money returned includes successful refunds only.
                  </p>
                </div>

                <div className="pd-section">
                  <h4 className="pd-section-title">Shipments Delivered During Selected Dates</h4>
                  <p style={{ fontSize: '10px', color: '#666', margin: '0 0 8px' }}>
                    Current cargo fee, amount paid, and amount still unpaid as of {formatDateTime(data.generatedAt)}. These amounts are not payments received and do not need to add up to the payment totals above.
                  </p>
                  <table className="pd-table" style={{ fontSize: '11px' }}>
                    <thead>
                      <tr>
                        <th scope="col">Tracking #</th>
                        <th scope="col">Customer</th>
                        <th scope="col">Route</th>
                        <th scope="col">Delivered On</th>
                        <th scope="col" style={{ textAlign: 'right' }}>Final Cargo Fee</th>
                        <th scope="col" style={{ textAlign: 'right' }}>Amount Paid</th>
                        <th scope="col" style={{ textAlign: 'right' }}>Amount Still Unpaid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.completedDeliveries?.map(order => (
                        <tr key={order.id}>
                          <td>{order.tracking_number}</td>
                          <td>{order.sender_name}</td>
                          <td>{order.origin} → {order.destination}</td>
                          <td>{formatDate(order.delivered_at)}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(order.final_fee)}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(order.amount_paid)}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(order.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </PrintDocument>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ReportsPage;
