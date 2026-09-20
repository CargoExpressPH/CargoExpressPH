import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, MapPin, RefreshCw, Route, Search, WalletCards, FileText, Printer } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getAllTripsForReport, getPerTripSalesReport } from '../../lib/database';
import { logActivity } from '../../lib/activityLog';
import { useAuth } from '../../contexts/AuthContext';
import usePageTitle from '../../hooks/usePageTitle';
import useRealtimeOrders from '../../hooks/useRealtimeOrders';
import { formatMoney } from '../../utils/currencyInput';
import { formatPhDate, formatPhDateTime } from '../../utils/datetime';
import { CenteredSpinner } from '../../components/ui/Loader';
import EmptyState from '../../components/ui/EmptyState';
import StatusBadge from '../../components/ui/StatusBadge';
import PrintDocument from '../../components/ui/PrintDocument';
import CustomSelect from '../../components/ui/CustomSelect';
import { exportPrintDocumentToPdf } from '../../lib/exportPdf';
const tripDate = (value) => {
  if (!value) return 'Date not set';
  const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? `${value}T00:00:00+08:00`
    : value;
  return formatPhDate(dateValue);
};

const tripStatusLabel = (status) => ({
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  arrived: 'Arrived',
  completed: 'Completed',
  cancelled: 'Cancelled',
}[status] || status || 'Unknown');

const money = value => value === null || value === undefined ? '—' : formatMoney(value);

const statusClass = (label) => {
  if (label === 'Paid in full' || label === 'Settled') return 'per-trip-pill-success';
  if (label === 'Partly paid' || label === 'Refund processing') return 'per-trip-pill-warning';
  if (label === 'Needs review' || label === 'Refund due' || label === 'Refund failed') return 'per-trip-pill-danger';
  return 'per-trip-pill-neutral';
};

const SummaryCard = ({ label, value, detail, tone = 'info' }) => (
  <div className={`stat-card stat-card-${tone} per-trip-summary-card`}>
    <div className="stat-value">{formatMoney(value)}</div>
    <div className="stat-label">{label}</div>
    {detail && <div className="per-trip-summary-detail">{detail}</div>}
  </div>
);

const ActiveBookingsTable = ({ rows }) => (
  <div className="table-container">
    <table className="data-table data-table--wide per-trip-table">
      <thead>
        <tr>
          <th scope="col">Tracking number</th>
          <th scope="col">Customer</th>
          <th scope="col">Status</th>
          <th scope="col" className="num">Final cargo fee</th>
          <th scope="col" className="num">Payments received</th>
          <th scope="col" className="num">Money returned</th>
          <th scope="col" className="num">Amount still to pay</th>
          <th scope="col">Payment status</th>
          <th scope="col">Booking</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id}>
            <td data-label="Tracking number"><span className="report-mono">{row.trackingNumber || '—'}</span></td>
            <td data-label="Customer">{row.customerName}</td>
            <td data-label="Status"><StatusBadge status={row.status} size="sm" /></td>
            <td data-label="Final cargo fee" className="num">
              {row.shippingFee === null ? <span className="text-secondary">Not priced yet</span> : money(row.shippingFee)}
            </td>
            <td data-label="Payments received" className="num">{money(row.paymentsReceived)}</td>
            <td data-label="Money returned" className="num">
              {money(row.moneyReturned)}
              {row.refundPending > 0 && <small className="per-trip-cell-note">Refund processing: {money(row.refundPending)}</small>}
              {row.refundUncertain > 0 && <small className="per-trip-cell-note per-trip-cell-note-danger">Refund needs checking: {money(row.refundUncertain)}</small>}
              {row.refundFailed > 0 && <small className="per-trip-cell-note per-trip-cell-note-danger">Refund failed: {money(row.refundFailed)}</small>}
            </td>
            <td data-label="Amount still to pay" className="num">
              {row.amountStillToPay === null ? <span className="text-secondary">Not priced yet</span> : money(row.amountStillToPay)}
            </td>
            <td data-label="Payment status">
              <span className={`per-trip-pill ${statusClass(row.paymentStatus)}`}>{row.paymentStatus}</span>
            </td>
            <td data-label="Booking"><Link className="btn btn-ghost btn-sm" to={`/admin/orders/${row.id}`}>Open</Link></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const CancelledBookingsTable = ({ rows }) => (
  <div className="table-container">
    <table className="data-table data-table--wide per-trip-table">
      <thead>
        <tr>
          <th scope="col">Tracking number</th>
          <th scope="col">Customer</th>
          <th scope="col" className="num">Payments received</th>
          <th scope="col" className="num">Money returned</th>
          <th scope="col">Cancellation decision</th>
          <th scope="col" className="num">Confirmed retained fee</th>
          <th scope="col" className="num">Amount still to refund</th>
          <th scope="col">Settlement status</th>
          <th scope="col">Booking</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => {
          const decision = row.cancellation;
          return (
            <tr key={row.id}>
              <td data-label="Tracking number"><span className="report-mono">{row.trackingNumber || '—'}</span></td>
              <td data-label="Customer">{row.customerName}</td>
              <td data-label="Payments received" className="num">{money(row.paymentsReceived)}</td>
              <td data-label="Money returned" className="num">
                {money(row.moneyReturned)}
                {row.refundPending > 0 && <small className="per-trip-cell-note">Refund processing: {money(row.refundPending)}</small>}
                {row.refundUncertain > 0 && <small className="per-trip-cell-note per-trip-cell-note-danger">Refund needs checking: {money(row.refundUncertain)}</small>}
              </td>
              <td data-label="Cancellation decision">{decision.confirmedCancellation ? 'Confirmed' : 'Not confirmed'}</td>
              <td data-label="Confirmed retained fee" className="num">{money(decision.retainedFee)}</td>
              <td data-label="Amount still to refund" className="num">{money(decision.amountStillToRefund)}</td>
              <td data-label="Settlement status">
                <span className={`per-trip-pill ${statusClass(decision.settlementStatus)}`}>{decision.settlementStatus}</span>
              </td>
              <td data-label="Booking"><Link className="btn btn-ghost btn-sm" to={`/admin/orders/${row.id}`}>Open</Link></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const PerTripSalesPage = () => {
  usePageTitle('Sales & Reports');
  const { user, userProfile } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [trips, setTrips] = useState([]);
  const [selectedTripId, setSelectedTripId] = useState('');
  const [report, setReport] = useState(null);
  const [loadingTrips, setLoadingTrips] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);

  const loadTrips = useCallback(async () => {
    setLoadingTrips(true);
    setError(null);
    try {
      const result = await getAllTripsForReport();
      if (!mountedRef.current) return;
      setTrips(result);
      setSelectedTripId(current => current && result.some(trip => trip.id === current)
        ? current
        : (result[0]?.id || ''));
    } catch (loadError) {
      if (mountedRef.current) setError('Trips could not be loaded. Please try again.');
    } finally {
      if (mountedRef.current) setLoadingTrips(false);
    }
  }, []);

  const loadReport = useCallback(async (tripId, { background = false } = {}) => {
    if (!tripId) return;
    const sequence = ++requestSequenceRef.current;
    if (background) setRefreshing(true);
    else setLoadingReport(true);
    setError(null);

    try {
      const result = await getPerTripSalesReport(tripId);
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      setReport(result);
      setLastUpdated(new Date());
    } catch (loadError) {
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      setError('The trip report could not be refreshed. The last successful report remains on screen.');
    } finally {
      if (mountedRef.current && sequence === requestSequenceRef.current) {
        setLoadingReport(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadTrips();

    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, [loadTrips]);

  useEffect(() => {
    setReport(null);
    if (selectedTripId) void loadReport(selectedTripId);
  }, [selectedTripId, loadReport]);

  useEffect(() => {
    const refresh = () => {
      if (selectedTripId && report) void loadReport(selectedTripId, { background: true });
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [loadReport, report, selectedTripId]);

  const handleOrderChanges = useCallback(() => {
    if (selectedTripId) void loadReport(selectedTripId, { background: true });
  }, [loadReport, selectedTripId]);

  const handlePrint = () => {
    if (!selectedTripId || !report) return;
    const tripName = report.trip?.trip_number || 'Unknown Trip';
    logActivity({ module: 'Sales & Reports', action: 'Report Printed', details: `Printed report for trip ${tripName}` });
    const originalTitle = document.title;
    document.title = `CargoExpress PH Report (${tripName})`;
    const restore = () => {
      document.title = originalTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    requestAnimationFrame(() => window.print());
  };

  useRealtimeOrders({
    enabled: Boolean(user?.id) && Boolean(selectedTripId) && Boolean(report),
    channelName: `per_trip_sales_${selectedTripId || 'none'}`,
    userId: user?.id,
    debounceMs: 1200,
    onBatch: handleOrderChanges,
  });

  const selectedTrip = trips.find(trip => trip.id === selectedTripId) || report?.trip;
  const summary = report?.summary;

  return (
    <div className="page-transition per-trip-report">
      <div className="admin-page-header no-print">
        <div>
          <h1 className="admin-page-title"><FileText size={24} color="var(--primary)" aria-hidden="true" /> Sales & Reports</h1>
          <p className="admin-page-subtitle">Review shipping fees, payments, refunds, and balances per trip.</p>
        </div>
        <div className="flex gap-8">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => loadReport(selectedTripId, { background: true })}
            disabled={!selectedTripId || loadingReport || refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {report && (
            <button type="button" className="btn btn-primary btn-sm" onClick={handlePrint}>
              <Printer size={16} />
              Print Report
            </button>
          )}
        </div>
      </div>

      <div className="card per-trip-selector-card no-print flex items-center gap-16" style={{ padding: '16px 20px' }}>
        <div className="per-trip-selector-label fw-600 flex items-center gap-8" style={{ minWidth: 'fit-content' }}>
          <Search size={16} aria-hidden="true" /> Choose a trip
        </div>
        {loadingTrips ? <CenteredSpinner size={22} /> : trips.length === 0 ? (
          <p className="text-secondary mb-0">No trips are available.</p>
        ) : (
          <div className="form-group mb-0 per-trip-selector" style={{ flex: 1, minWidth: 0, width: '100%' }}>
            <CustomSelect
              className="form-control"
              value={selectedTripId}
              aria-label="Choose a trip"
              onChange={event => {
                setError(null);
                setSelectedTripId(event.target.value);
              }}
            >
              {trips.map(trip => (
                <option key={trip.id} value={trip.id}>
                  {trip.trip_number || 'Trip'} · {trip.origin || 'Origin not set'} -> {trip.destination || 'Destination not set'} · {tripDate(trip.departure_date)} · {tripStatusLabel(trip.status)}
                </option>
              ))}
            </CustomSelect>
          </div>
        )}
      </div>

      {error && (
        <div className="alert-banner alert-banner-error mt-16" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => selectedTripId ? loadReport(selectedTripId, { background: Boolean(report) }) : loadTrips()}>Try again</button>
        </div>
      )}

      {selectedTrip && (
        <div className="card per-trip-details-card mt-16">
          <div>
            <div className="per-trip-kicker">Selected trip</div>
            <h2>{selectedTrip.trip_number || 'Trip'}</h2>
            <p className="per-trip-route"><MapPin size={16} aria-hidden="true" /> {selectedTrip.origin || 'Origin not set'} → {selectedTrip.destination || 'Destination not set'}</p>
          </div>
          <div className="per-trip-detail-list">
            <span><CalendarDays size={15} aria-hidden="true" /> Scheduled {tripDate(selectedTrip.departure_date)}</span>
            <StatusBadge status={selectedTrip.status} size="sm" />
          </div>
        </div>
      )}

      {loadingReport && !report && <CenteredSpinner />}

      {report && summary && (
        <>
          <div className="per-trip-basis-card mt-16">
            <WalletCards size={18} aria-hidden="true" />
            <div>
              <strong>Report basis</strong>
              <p>{report.basis}</p>
              <p>{report.assignmentNote}</p>
            </div>
          </div>

          <div className="grid grid-4 report-summary-cards per-trip-summary-grid mt-16">
            <SummaryCard label="Cargo fees" value={summary.shippingFees} tone="info" />
            <SummaryCard label="Payments received" value={summary.paymentsReceived} tone="success" />
            <SummaryCard label="Money returned" value={summary.moneyReturned} tone="warning" />
            <SummaryCard label="Payments after refunds" value={summary.paymentsAfterRefunds} tone="primary" />
            <SummaryCard label="Amount still to collect" value={summary.amountStillToCollect} tone="error" />
          </div>

          <div className="per-trip-counts-card mt-16">
            <span><strong>{summary.activeBookingCount}</strong> active & completed</span>
            <span><strong>{summary.completedBookingCount}</strong> completed</span>
            <span><strong>{summary.cancelledBookingCount}</strong> cancelled</span>
            {summary.unpricedActiveCount > 0 && <span><strong>{summary.unpricedActiveCount}</strong> active booking{summary.unpricedActiveCount === 1 ? '' : 's'} not priced yet</span>}
          </div>

          <div className="per-trip-explanation mt-16">
            Payments after refunds includes cancelled-booking money. Cargo fees and amount still to collect exclude cancelled bookings. Cancelled money awaiting a decision: <strong>{money(summary.cancelledMoneyAwaitingDecision)}</strong> ({summary.cancelledReviewCount} booking{summary.cancelledReviewCount === 1 ? '' : 's'}).
          </div>

          {(summary.pendingRefundAmount > 0 || summary.uncertainRefundAmount > 0 || summary.failedRefundAmount > 0 || summary.dataInconsistent) && (
            <div className="alert-banner alert-banner-warning mt-16" role="status">
              <AlertTriangle size={18} />
              <span>
                {summary.pendingRefundAmount > 0 && <>Refunds still processing: {money(summary.pendingRefundAmount)}. </>}
                {summary.uncertainRefundAmount > 0 && <>Refunds needing verification: {money(summary.uncertainRefundAmount)}. </>}
                {summary.failedRefundAmount > 0 && <>Failed refunds: {money(summary.failedRefundAmount)}. </>}
                {summary.dataInconsistent && <>A cancellation settlement needs review before its amounts can be reported.</>}
              </span>
            </div>
          )}

          <div className="card admin-section-card admin-table-card mt-20">
            <div className="card-header">
              <div>
                <h3>Active & completed bookings ({summary.activeBookingCount})</h3>
                <p className="text-secondary fs-12 mb-0">Final cargo fees and active balances exclude cancelled bookings.</p>
              </div>
            </div>
            {report.activeRows.length > 0 ? <ActiveBookingsTable rows={report.activeRows} /> : <EmptyState title="No active or completed bookings" description="This trip has no non-cancelled bookings." />}
          </div>

          <div className="card admin-section-card admin-table-card mt-20">
            <div className="card-header">
              <div>
                <h3>Cancelled bookings ({summary.cancelledBookingCount})</h3>
                <p className="text-secondary fs-12 mb-0">Cancelled bookings stay separate. No fee or refund is assumed without a recorded decision.</p>
              </div>
            </div>
            {report.cancelledRows.length > 0 ? <CancelledBookingsTable rows={report.cancelledRows} /> : <EmptyState title="No cancelled bookings" description="No cancelled booking is currently assigned to this trip." />}
          </div>

          <p className="per-trip-last-updated text-secondary fs-12 mt-16 no-print">
            {lastUpdated ? `Last updated ${formatPhDateTime(lastUpdated)}.` : 'Not updated yet.'} Changes are refreshed from the authorized backend view without reloading the page.
          </p>

          <PrintDocument 
            title={`Trip Report: ${selectedTrip.trip_number || 'Unknown Trip'}`}
            subtitle={`${selectedTrip.origin || 'Origin'} → ${selectedTrip.destination || 'Destination'} (Scheduled ${tripDate(selectedTrip.departure_date)})`}
            generatedAt={lastUpdated ? formatPhDateTime(lastUpdated) : ''}
            preparedBy={userProfile?.name}
          >
            <div className="pd-section">
              <div className="pd-summary-grid" style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
                <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#000' }}>Cargo Fees</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#000' }}>{formatMoney(summary.shippingFees)}</div>
                </div>
                <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#000' }}>Payments Received</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#000' }}>{formatMoney(summary.paymentsReceived)}</div>
                </div>
                <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#000' }}>Money Returned</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#000' }}>{formatMoney(summary.moneyReturned)}</div>
                </div>
                <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#000' }}>Amount Still to Collect</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#000' }}>{formatMoney(summary.amountStillToCollect)}</div>
                </div>
              </div>
            </div>

            {report.activeRows.length > 0 && (
              <div className="pd-section">
                <h4 className="pd-section-title">Active & Completed Bookings ({summary.activeBookingCount})</h4>
                <table className="pd-table" style={{ fontSize: '11px' }}>
                  <thead>
                    <tr>
                      <th scope="col">Tracking #</th>
                      <th scope="col">Customer</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Final Cargo Fee</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Payments</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Returned</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.activeRows.map(row => (
                      <tr key={row.id}>
                        <td>{row.trackingNumber || '—'}</td>
                        <td>{row.customerName}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.shippingFee)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.paymentsReceived)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.moneyReturned)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.amountStillToPay)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            
            {report.cancelledRows.length > 0 && (
              <div className="pd-section">
                <h4 className="pd-section-title">Cancelled Bookings ({summary.cancelledBookingCount})</h4>
                <table className="pd-table" style={{ fontSize: '11px' }}>
                  <thead>
                    <tr>
                      <th scope="col">Tracking #</th>
                      <th scope="col">Customer</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Payments</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Returned</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Retained Fee</th>
                      <th scope="col" style={{ textAlign: 'right' }}>To Refund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.cancelledRows.map(row => (
                      <tr key={row.id}>
                        <td>{row.trackingNumber || '—'}</td>
                        <td>{row.customerName}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.paymentsReceived)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.moneyReturned)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.cancellation?.retainedFee)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.cancellation?.amountStillToRefund)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PrintDocument>
        </>
      )}
    </div>
  );
};

export default PerTripSalesPage;
