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
      setError('Please select both start and end dates to generate a report.');
      return;
    }
    if (customDateRangeInvalid) {
      setError('End date must be the same as or later than the start date.');
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
      setError(e.message || 'Failed to load report data.');
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
            Generate, view, and print detailed financial event reports
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
          <p className="form-error">End date must be the same as or later than the start date.</p>
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
              title="No Data Found"
              description={`No financial events or deliveries occurred between ${reportedStart} and ${reportedEnd}`}
            />
          )}

          {hasData && (
            <>
              <div className="grid grid-4 report-summary-cards mb-20 mt-16">
                <div className="stat-card stat-card-info stagger-item" style={{ animationDelay: '0ms' }}>
                  <div className="stat-value"><AnimatedCounter value={data.grossCollected} prefix="₱" decimals={2} duration={1000} /></div>
                  <div className="stat-label">Gross Collected</div>
                </div>
                <div className="stat-card stat-card-warning stagger-item" style={{ animationDelay: '60ms' }}>
                  <div className="stat-value"><AnimatedCounter value={data.successfulRefunds} prefix="₱" decimals={2} duration={1000} /></div>
                  <div className="stat-label">Successful Refunds</div>
                </div>
                <div className="stat-card stat-card-success stagger-item" style={{ animationDelay: '120ms' }}>
                  <div className="stat-value"><AnimatedCounter value={data.netCollected} prefix="₱" decimals={2} duration={1000} /></div>
                  <div className="stat-label">Net Collected</div>
                </div>
                <div className="stat-card stat-card-primary stagger-item" style={{ animationDelay: '180ms' }}>
                  <div className="stat-value"><AnimatedCounter value={data.deliveredShipmentValue} prefix="₱" decimals={2} duration={1000} /></div>
                  <div className="stat-label">Delivered Value</div>
                </div>
              </div>

              <div className="grid grid-2 mb-20 no-print">
                <div className="card stagger-item mb-20" style={{ animationDelay: '200ms' }}>
                  <div className="card-header">
                    <h3 className="flex items-center gap-8">
                      <BarChart3 size={18} className="text-primary" />
                      Daily Net Collections
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
                      <div className="text-center text-secondary py-32">No daily data available</div>
                    )}
                  </div>
                </div>
                
                <div className="card stagger-item mb-20" style={{ animationDelay: '240ms' }}>
                  <div className="card-header">
                    <h3 className="flex items-center gap-8">
                      <CreditCard size={18} className="text-primary" />
                      Collection Breakdown
                    </h3>
                  </div>
                  <div className="card-body">
                    <div className="report-table-wrap">
                      <table className="report-table">
                        <thead>
                          <tr>
                            <th scope="col">Method</th>
                            <th scope="col" className="text-right">Gross</th>
                            <th scope="col" className="text-right">Refunds</th>
                            <th scope="col" className="text-right">Net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.methodTotals?.map((mt, idx) => (
                            <tr key={idx}>
                              <td data-label="Method" className="text-capitalize">{mt.method} <span className="text-secondary fs-12">({mt.payment_count} tx)</span></td>
                              <td data-label="Gross" className="text-right fw-500 text-info">{formatCurrency(mt.gross)}</td>
                              <td data-label="Refunds" className="text-right fw-500 text-warning">{formatCurrency(mt.refunds)}</td>
                              <td data-label="Net" className="text-right fw-600 text-success">{formatCurrency(mt.net)}</td>
                            </tr>
                          ))}
                          {(!data.methodTotals || data.methodTotals.length === 0) && (
                            <tr><td colSpan="4" className="text-center text-secondary">No collections</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
                
                <div className="card stagger-item" style={{ animationDelay: '260ms' }}>
                   <div className="card-header">
                      <h3 className="flex items-center gap-8">
                        <TrendingUp size={18} className="text-primary" />
                        Transactions
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
                                     <td data-label="Type"><span className={`badge ${dt.type === 'refund' ? 'badge-warning' : 'badge-success'}`}>{dt.type}</span></td>
                                     <td data-label="Date">{formatDate(dt.event_date)}</td>
                                     <td data-label="Amount" className="fw-600">{formatCurrency(dt.amount)}</td>
                                  </tr>
                               ))}
                               {(!data.paymentRefundDetail || data.paymentRefundDetail.length === 0) && (
                                  <tr><td colSpan="3" className="text-center text-secondary">No transactions</td></tr>
                               )}
                            </tbody>
                         </table>
                      </div>
                   </div>
                </div>
              </div>

              <div className="card stagger-item mb-20" style={{ animationDelay: '280ms' }}>
                <div className="card-header flex justify-between items-center">
                  <h3 className="flex items-center gap-8">
                    <Package size={18} className="text-primary" />
                    Completed Deliveries in Period
                  </h3>
                  <span className="badge badge-primary">{data.completedDeliveries?.length || 0} deliveries</span>
                </div>
                <div className="card-body p-0">
                  <div className="table-responsive">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Tracking #</th>
                          <th>Customer</th>
                          <th>Route</th>
                          <th>Delivered On</th>
                          <th className="text-right">Final Charge</th>
                          <th className="text-right">Paid (Current)</th>
                          <th className="text-right">Balance (Current)</th>
                          <th className="text-center">Status</th>
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
                          <tr><td colSpan="8" className="text-center text-secondary py-32">No deliveries completed in this period</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              
              <PrintDocument 
                title="Financial Analytics Report" 
                subtitle={`Report Period: ${reportedStart} to ${reportedEnd}`}
                generatedAt={formatDateTime(data.generatedAt)}
                preparedBy={userProfile?.name}
              >
                <div className="pd-section">
                  <div className="pd-summary-grid" style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
                    <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Gross Collected</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{formatCurrency(data.grossCollected)}</div>
                    </div>
                    <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Successful Refunds</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{formatCurrency(data.successfulRefunds)}</div>
                    </div>
                    <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Net Collected</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{formatCurrency(data.netCollected)}</div>
                    </div>
                    <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                      <div style={{ fontSize: '12px', color: '#666' }}>Delivered Value</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{formatCurrency(data.deliveredShipmentValue)}</div>
                    </div>
                  </div>
                </div>

                <div className="pd-section">
                  <h4 className="pd-section-title">Collection Breakdown</h4>
                  <table className="pd-table">
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th style={{ textAlign: 'right' }}>Gross</th>
                        <th style={{ textAlign: 'right' }}>Refunds</th>
                        <th style={{ textAlign: 'right' }}>Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.methodTotals?.map((mt, idx) => (
                        <tr key={idx}>
                          <td style={{ textTransform: 'capitalize' }}>{mt.method} ({mt.payment_count} tx)</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(mt.gross)}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(mt.refunds)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{formatCurrency(mt.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="pd-section">
                  <h4 className="pd-section-title">Completed Deliveries</h4>
                  <table className="pd-table" style={{ fontSize: '11px' }}>
                    <thead>
                      <tr>
                        <th>Tracking #</th>
                        <th>Customer</th>
                        <th>Route</th>
                        <th>Delivered On</th>
                        <th style={{ textAlign: 'right' }}>Final Charge</th>
                        <th style={{ textAlign: 'right' }}>Paid (Current)</th>
                        <th style={{ textAlign: 'right' }}>Balance (Current)</th>
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
