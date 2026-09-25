import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, MapPin, RefreshCw, WalletCards, FileText, Printer } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getAllTripsForReport, getMonthlySalesReport } from '../../lib/database';
import { aggregateMonthlySalesReports, tripMonthKey } from '../../lib/perTripSalesReport';
import { logActivity } from '../../lib/activityLog';
import { useAuth } from '../../contexts/AuthContext';
import usePageTitle from '../../hooks/usePageTitle';
import useRealtimeOrders from '../../hooks/useRealtimeOrders';
import { formatMoney } from '../../utils/currencyInput';
import { formatPhDate, formatPhDateTime, phDateKey } from '../../utils/datetime';
import { CenteredSpinner } from '../../components/ui/Loader';
import EmptyState from '../../components/ui/EmptyState';
import StatusBadge from '../../components/ui/StatusBadge';
import PrintDocument from '../../components/ui/PrintDocument';
import { exportPrintDocumentToPdf } from '../../lib/exportPdf';
const tripDate = (value) => {
  if (!value) return 'Date not set';
  const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? `${value}T00:00:00+08:00`
    : value;
  return formatPhDate(dateValue);
};

const money = value => value === null || value === undefined ? '—' : formatMoney(value);

// 'YYYY-MM', matching what a month-type input produces/consumes. Taken from
// the Manila calendar, not UTC: between midnight and 8 AM on the 1st, UTC is
// still in the previous month.
const currentMonthValue = () => phDateKey(new Date().toISOString()).slice(0, 7);

const monthLabel = (monthValue) => {
  if (!monthValue) return '';
  // day: undefined drops formatPhDate's default day, so this reads
  // "September 2026" rather than "September 1, 2026".
  return formatPhDate(`${monthValue}-01T00:00:00+08:00`, { month: 'long', year: 'numeric', day: undefined });
};

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
            <td data-label="Booking"><Link className="btn btn-outline btn-sm" to={`/admin/orders/${row.id}`}>Open</Link></td>
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
              <td data-label="Booking"><Link className="btn btn-outline btn-sm" to={`/admin/orders/${row.id}`}>Open</Link></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

// Print-only variants of the two tables above — plain pd-table markup
// instead of the data-table component, matching the rest of PrintDocument's
// content (see the printed section below).
const PrintActiveBookingsTable = ({ rows }) => (
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
      {rows.map(row => (
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
);

const PrintCancelledBookingsTable = ({ rows }) => (
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
      {rows.map(row => (
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
);

const PerTripSalesPage = () => {
  usePageTitle('Sales & Reports');
  const { user, userProfile } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [trips, setTrips] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState(currentMonthValue());
  const [monthlyReport, setMonthlyReport] = useState(null);
  // Gates the dashboard AND the Print button — set only after a successful
  // "Generate Report" click (or a background refresh of one already shown).
  // Changing the month never sits on screen next to filters it no longer
  // matches — it clears hasGenerated first.
  const [hasGenerated, setHasGenerated] = useState(false);
  const [loadingTrips, setLoadingTrips] = useState(true);
  // True only after the trip list loaded successfully — the auto-generate
  // below must not run against an empty list after a failed load, or it would
  // replace the load error with a misleading empty report.
  const [tripsReady, setTripsReady] = useState(false);
  const autoGeneratedRef = useRef(false);
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
      setTripsReady(true);
    } catch (loadError) {
      if (mountedRef.current) setError('Trips could not be loaded. Please try again.');
    } finally {
      if (mountedRef.current) setLoadingTrips(false);
    }
  }, []);

  // Monthly Sales Report: aggregates every trip whose departure_date falls in
  // `monthValue`, reusing getPerTripSalesReport per trip (via
  // getMonthlySalesReport) so the grand total and each per-trip breakdown
  // share the exact same calculation as a single-trip report.
  const loadMonthlyReport = useCallback(async (monthValue, { background = false } = {}) => {
    if (!monthValue) return;
    const sequence = ++requestSequenceRef.current;
    if (background) setRefreshing(true);
    else setLoadingReport(true);
    setError(null);

    try {
      const tripIds = trips.filter(trip => tripMonthKey(trip) === monthValue).map(trip => trip.id);
      // A month with no departures is a valid, all-zero report (the page
      // renders "No trips this month"), not an error.
      const result = tripIds.length
        ? await getMonthlySalesReport(tripIds)
        : aggregateMonthlySalesReports([]);
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      setMonthlyReport(result);
      setHasGenerated(true);
      setLastUpdated(new Date());
    } catch (loadError) {
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      setError(loadError.message || 'The monthly report could not be refreshed. The last successful report remains on screen.');
    } finally {
      if (mountedRef.current && sequence === requestSequenceRef.current) {
        setLoadingReport(false);
        setRefreshing(false);
      }
    }
  }, [trips]);

  useEffect(() => {
    mountedRef.current = true;
    void loadTrips();

    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, [loadTrips]);

  // Selecting a month never fetches by itself — it only clears whatever
  // report was on screen so it can't be mistaken for a match to the new
  // month. Fetching happens only from handleGenerate (the "Generate Report"
  // click) below.
  useEffect(() => {
    setHasGenerated(false);
    setMonthlyReport(null);
    setError(null);
  }, [selectedMonth]);

  const handleGenerate = useCallback(() => {
    if (selectedMonth) void loadMonthlyReport(selectedMonth);
  }, [selectedMonth, loadMonthlyReport]);

  // Open on the current month's numbers instead of an empty page. Runs once,
  // after the trip list is in; picking a different month afterwards still
  // waits for "Generate Report", as described above.
  useEffect(() => {
    if (!tripsReady || autoGeneratedRef.current || !selectedMonth) return;
    autoGeneratedRef.current = true;
    void loadMonthlyReport(selectedMonth);
  }, [tripsReady, selectedMonth, loadMonthlyReport]);

  // Background refresh of an ALREADY-generated report (realtime order
  // changes, tab refocus, coming back online) is not gated behind another
  // Generate click — only the initial load on a month change is.
  useEffect(() => {
    const refresh = () => {
      if (!hasGenerated || !selectedMonth) return;
      void loadMonthlyReport(selectedMonth, { background: true });
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [hasGenerated, selectedMonth, loadMonthlyReport]);

  const handleOrderChanges = useCallback(() => {
    if (!hasGenerated || !selectedMonth) return;
    void loadMonthlyReport(selectedMonth, { background: true });
  }, [hasGenerated, selectedMonth, loadMonthlyReport]);

  const handlePrint = () => {
    if (!hasGenerated || !monthlyReport) return;
    const reportLabel = monthLabel(selectedMonth);
    logActivity({
      module: 'Sales & Reports',
      action: 'Report Printed',
      details: `Printed monthly report for ${reportLabel}`,
    });
    const originalTitle = document.title;
    document.title = `CargoExpress PH Report (${reportLabel})`;
    const restore = () => {
      document.title = originalTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    requestAnimationFrame(() => window.print());
  };

  useRealtimeOrders({
    enabled: Boolean(user?.id) && hasGenerated,
    channelName: `per_trip_sales_month_${selectedMonth}`,
    userId: user?.id,
    debounceMs: 1200,
    onBatch: handleOrderChanges,
  });

  const canGenerate = Boolean(selectedMonth);

  return (
    <div className="page-transition per-trip-report">
      <div className="admin-page-header no-print">
        <div>
          <h1 className="admin-page-title"><FileText size={24} color="var(--primary)" aria-hidden="true" /> Sales & Reports</h1>
          <p className="admin-page-subtitle">Review shipping fees, payments, refunds, and balances for every trip in a month.</p>
        </div>
        <div className="flex gap-8">
          <button
            type="button"
            className="btn btn-ghost btn-sm per-trip-icon-btn"
            onClick={handleGenerate}
            disabled={!canGenerate || loadingReport || refreshing}
            aria-label="Refresh report"
            title="Refresh report"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
            <span className="per-trip-btn-text">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
          </div>
      </div>

      <div className="card per-trip-selector-card no-print">
        {/* Two named groups, not one undifferentiated flex row. The month
            field and the actions can then be stacked independently on narrow
            screens instead of the field absorbing every pixel the buttons
            need — which is what collapsed the selected month to a bare
            dropdown arrow once Print Report appeared. */}
        <div className="per-trip-controls">
          <div className="per-trip-month-field">
            <label className="per-trip-selector-label fw-600" htmlFor="per-trip-month">
              <CalendarDays size={16} aria-hidden="true" /> Choose a month
            </label>
            {/* No inline flex/min-width here: the stylesheet owns the sizing,
                including the floor that keeps a long value like
                "September 2026" readable. */}
            <div className="form-group mb-0 per-trip-selector">
              <input
                id="per-trip-month"
                type="month"
                className="form-input"
                value={selectedMonth}
                onChange={event => {
                  setError(null);
                  setSelectedMonth(event.target.value);
                }}
              />
            </div>
          </div>

          <div className="per-trip-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm per-trip-generate-btn"
              onClick={handleGenerate}
              disabled={!canGenerate || loadingReport}
              title="Generate report"
            >
              {loadingReport
                ? <RefreshCw size={16} className="animate-spin" aria-hidden="true" />
                : <FileText size={16} aria-hidden="true" />}
              {/* One flex item, so the label reads "Generate Report" rather
                  than becoming two separately-gapped items. The " Report"
                  half is dropped on narrow screens. */}
              <span className="per-trip-generate-label">
                Generate<span className="per-trip-btn-text-rest"> Report</span>
              </span>
            </button>
            {hasGenerated && (
              <button
                type="button"
                className="btn btn-primary btn-sm per-trip-icon-btn"
                onClick={handlePrint}
                disabled={loadingReport || refreshing}
                aria-label="Print report"
                title="Print report"
              >
                <Printer size={16} aria-hidden="true" />
                <span className="per-trip-btn-text">Print Report</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="alert-banner alert-banner-error mt-16" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => (canGenerate ? handleGenerate() : loadTrips())}>Try again</button>
        </div>
      )}

      {loadingReport && !monthlyReport && <CenteredSpinner />}

      {hasGenerated && monthlyReport && (
        <>
          <div className="per-trip-basis-card mt-16">
            <WalletCards size={18} aria-hidden="true" />
            <div>
              <strong>Report basis</strong>
              <p>Grand total across every trip departing in {monthLabel(selectedMonth)} ({monthlyReport.grandTotal.tripCount} trip{monthlyReport.grandTotal.tripCount === 1 ? '' : 's'}), each computed the same way as a single-trip report.</p>
            </div>
          </div>

          <div className="grid grid-4 report-summary-cards per-trip-summary-grid mt-16">
            <SummaryCard label="Cargo fees" value={monthlyReport.grandTotal.shippingFees} tone="info" />
            <SummaryCard label="Payments received" value={monthlyReport.grandTotal.paymentsReceived} tone="success" />
            <SummaryCard label="Money returned" value={monthlyReport.grandTotal.moneyReturned} tone="warning" />
            <SummaryCard label="Payments after refunds" value={monthlyReport.grandTotal.paymentsAfterRefunds} tone="primary" />
            <SummaryCard label="Amount still to collect" value={monthlyReport.grandTotal.amountStillToCollect} tone="error" />
          </div>

          <div className="per-trip-counts-card mt-16">
            <span><strong>{monthlyReport.grandTotal.activeBookingCount}</strong> active & completed</span>
            <span><strong>{monthlyReport.grandTotal.completedBookingCount}</strong> completed</span>
            <span><strong>{monthlyReport.grandTotal.cancelledBookingCount}</strong> cancelled</span>
            {monthlyReport.grandTotal.unpricedActiveCount > 0 && <span><strong>{monthlyReport.grandTotal.unpricedActiveCount}</strong> active booking{monthlyReport.grandTotal.unpricedActiveCount === 1 ? '' : 's'} not priced yet</span>}
          </div>

          {(monthlyReport.grandTotal.pendingRefundAmount > 0 || monthlyReport.grandTotal.uncertainRefundAmount > 0 || monthlyReport.grandTotal.failedRefundAmount > 0 || monthlyReport.grandTotal.dataInconsistent) && (
            <div className="alert-banner alert-banner-warning mt-16" role="status">
              <AlertTriangle size={18} />
              <span>
                {monthlyReport.grandTotal.pendingRefundAmount > 0 && <>Refunds still processing: {money(monthlyReport.grandTotal.pendingRefundAmount)}. </>}
                {monthlyReport.grandTotal.uncertainRefundAmount > 0 && <>Refunds needing verification: {money(monthlyReport.grandTotal.uncertainRefundAmount)}. </>}
                {monthlyReport.grandTotal.failedRefundAmount > 0 && <>Failed refunds: {money(monthlyReport.grandTotal.failedRefundAmount)}. </>}
                {monthlyReport.grandTotal.dataInconsistent && <>A cancellation settlement needs review before its amounts can be reported.</>}
              </span>
            </div>
          )}

          <h3 className="mt-24 mb-8">Per-trip detail</h3>
          {monthlyReport.tripBreakdown.length === 0 ? (
            <EmptyState title="No trips this month" description="No trip departed in this month." />
          ) : (
            monthlyReport.tripBreakdown.map((tripReport) => {
              const { trip, summary: tripSummary, activeRows, cancelledRows } = tripReport;
              return (
                <div key={trip.id} className="mt-24">
                  <div className="flex items-center justify-between gap-16 flex-wrap">
                    <h3 className="mb-0">
                      {trip.trip_number || 'Trip'} ({trip.origin || 'Origin not set'} -&gt; {trip.destination || 'Destination not set'})
                    </h3>
                    <div className="per-trip-detail-list">
                      <span><CalendarDays size={15} aria-hidden="true" /> {tripDate(trip.departure_date)}</span>
                      <StatusBadge status={trip.status} size="sm" />
                      <Link className="btn btn-outline btn-sm" to={`/admin/trips/${trip.id}`}>Open trip</Link>
                    </div>
                  </div>

                  <div className="card admin-section-card admin-table-card mt-12">
                    <div className="card-header">
                      <div>
                        <h4>Active & completed bookings ({tripSummary.activeBookingCount})</h4>
                        <p className="text-secondary fs-12 mb-0">Final cargo fees and active balances exclude cancelled bookings.</p>
                      </div>
                    </div>
                    {activeRows.length > 0 ? <ActiveBookingsTable rows={activeRows} /> : <EmptyState title="No active or completed bookings" description="This trip has no non-cancelled bookings." />}
                  </div>

                  <div className="card admin-section-card admin-table-card mt-20">
                    <div className="card-header">
                      <div>
                        <h4>Cancelled bookings ({tripSummary.cancelledBookingCount})</h4>
                        <p className="text-secondary fs-12 mb-0">Cancelled bookings stay separate. No fee or refund is assumed without a recorded decision.</p>
                      </div>
                    </div>
                    {cancelledRows.length > 0 ? <CancelledBookingsTable rows={cancelledRows} /> : <EmptyState title="No cancelled bookings" description="No cancelled booking is currently assigned to this trip." />}
                  </div>
                </div>
              );
            })
          )}

          <p className="per-trip-last-updated text-secondary fs-12 mt-16 no-print">
            {lastUpdated ? `Last updated ${formatPhDateTime(lastUpdated)}.` : 'Not updated yet.'} Changes are refreshed from the authorized backend view without reloading the page.
          </p>

          <PrintDocument
            title={`Monthly Sales Report: ${monthLabel(selectedMonth)}`}
            subtitle={`${monthlyReport.grandTotal.tripCount} trip${monthlyReport.grandTotal.tripCount === 1 ? '' : 's'} departing in ${monthLabel(selectedMonth)}`}
            generatedAt={lastUpdated ? formatPhDateTime(lastUpdated) : ''}
            preparedBy={userProfile?.name}
          >
            <div className="pd-section">
              <div className="pd-summary-grid" style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
                <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#000' }}>Cargo Fees</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#000' }}>{formatMoney(monthlyReport.grandTotal.shippingFees)}</div>
                </div>
                <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#000' }}>Payments Received</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#000' }}>{formatMoney(monthlyReport.grandTotal.paymentsReceived)}</div>
                </div>
                <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#000' }}>Money Returned</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#000' }}>{formatMoney(monthlyReport.grandTotal.moneyReturned)}</div>
                </div>
                <div style={{ flex: 1, border: '1px solid #ddd', padding: '12px', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#000' }}>Amount Still to Collect</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#000' }}>{formatMoney(monthlyReport.grandTotal.amountStillToCollect)}</div>
                </div>
              </div>
            </div>

            {monthlyReport.tripBreakdown.map((tripReport) => {
              const { trip, summary: tripSummary, activeRows, cancelledRows } = tripReport;
              return (
                <div className="pd-section" key={trip.id}>
                  <h4 className="pd-section-title">
                    {trip.trip_number || 'Trip'} ({trip.origin || 'Origin not set'} -&gt; {trip.destination || 'Destination not set'})
                  </h4>
                  <p style={{ fontSize: '11px', color: '#000', margin: '0 0 8px' }}>
                    Scheduled {tripDate(trip.departure_date)} · {money(tripSummary.shippingFees)} cargo fees · {money(tripSummary.amountStillToCollect)} still to collect
                  </p>

                  {activeRows.length > 0 && (
                    <>
                      <p style={{ fontSize: '11px', fontWeight: 'bold', color: '#000', margin: '8px 0 4px' }}>Active & Completed Bookings ({tripSummary.activeBookingCount})</p>
                      <PrintActiveBookingsTable rows={activeRows} />
                    </>
                  )}

                  {cancelledRows.length > 0 && (
                    <>
                      <p style={{ fontSize: '11px', fontWeight: 'bold', color: '#000', margin: '8px 0 4px' }}>Cancelled Bookings ({tripSummary.cancelledBookingCount})</p>
                      <PrintCancelledBookingsTable rows={cancelledRows} />
                    </>
                  )}

                  {activeRows.length === 0 && cancelledRows.length === 0 && (
                    <p style={{ fontSize: '11px', color: '#000' }}>No bookings assigned to this trip.</p>
                  )}
                </div>
              );
            })}
          </PrintDocument>
        </>
      )}
    </div>
  );
};

export default PerTripSalesPage;
