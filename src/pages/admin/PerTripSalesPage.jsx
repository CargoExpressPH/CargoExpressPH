import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Calendar, CalendarDays, MapPin, RefreshCw, WalletCards, FileText, Printer, Search, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { rowLinkProps } from '../../utils/rowLink';
import { getAllTripsForReport, getMonthlySalesReport } from '../../lib/database';
import { aggregateMonthlySalesReports } from '../../lib/perTripSalesReport';
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
import DatePicker from '../../components/ui/DatePicker';
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

const ActiveBookingsTable = ({ rows }) => {
  const navigate = useNavigate();
  return (
  <div className="table-container">
    <table className="data-table data-table--wide per-trip-table per-trip-table--active">
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
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id} {...rowLinkProps(navigate, `/admin/orders/${row.id}`)}>
            <td data-label="Tracking number"><Link to={`/admin/orders/${row.id}`} className="report-mono">{row.trackingNumber || '—'}</Link></td>
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
          </tr>
        ))}
      </tbody>
    </table>
  </div>
  );
};

const CancelledBookingsTable = ({ rows }) => {
  const navigate = useNavigate();
  return (
  <div className="table-container">
    <table className="data-table data-table--wide per-trip-table per-trip-table--cancelled">
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
        </tr>
      </thead>
      <tbody>
        {rows.map(row => {
          const decision = row.cancellation;
          return (
            <tr key={row.id} {...rowLinkProps(navigate, `/admin/orders/${row.id}`)}>
              <td data-label="Tracking number"><Link to={`/admin/orders/${row.id}`} className="report-mono">{row.trackingNumber || '—'}</Link></td>
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
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
  );
};

// Print-only variants of the two tables above — plain pd-table markup
// instead of the data-table component, matching the rest of PrintDocument's
// content (see the printed section below).
// Sum of one numeric column for a subtotal row. Unpriced bookings have a null
// fee and count as zero here, the same as the on-screen totals.
const sumOf = (rows, pick) => rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);

const PrintTripTable = ({ trip, rows }) => {
  const tripRoute = `${trip.origin || 'Origin not set'} → ${trip.destination || 'Destination not set'}`;
  const departureText = tripDate(trip.departure_date);

  return (
    <table className="pd-table pd-trip-table">
      <thead>
        <tr className="pd-trip-banner-row">
          <th colSpan={3} className="pd-trip-banner-title">
            <span className="pd-trip-num">{trip.trip_number || 'Trip'}</span>
            <span className="pd-trip-sep">•</span>
            <span className="pd-trip-route">{tripRoute}</span>
          </th>
          <th colSpan={3} className="pd-trip-banner-date num">
            Departure: <strong>{departureText}</strong>
          </th>
        </tr>
        <tr className="pd-col-header-row">
          <th scope="col" style={{ width: '22%' }}>Tracking No.</th>
          <th scope="col" style={{ width: '28%' }}>Customer</th>
          <th scope="col" className="num" style={{ width: '13%' }}>Cargo Fee</th>
          <th scope="col" className="num" style={{ width: '13%' }}>Paid</th>
          <th scope="col" className="num" style={{ width: '12%' }}>Refund</th>
          <th scope="col" className="num" style={{ width: '12%' }}>Balance</th>
        </tr>
      </thead>
      <tbody>
        {rows.length > 0 ? (
          rows.map(row => (
            <tr key={row.id}>
              <td className="pd-mono">{row.trackingNumber || '—'}</td>
              <td>{row.customerName}</td>
              <td className="num">{money(row.shippingFee)}</td>
              <td className="num">{money(row.paymentsReceived)}</td>
              <td className="num">{money(row.moneyReturned)}</td>
              <td className="num">{money(row.amountStillToPay)}</td>
            </tr>
          ))
        ) : (
          <tr>
            <td colSpan={6} className="pd-empty-cell">
              No bookings assigned to this trip.
            </td>
          </tr>
        )}
      </tbody>
      {rows.length > 0 && (
        <tfoot>
          <tr className="pd-subtotal">
            <td colSpan={2}>Trip Subtotal ({rows.length} {rows.length === 1 ? 'booking' : 'bookings'})</td>
            <td className="num">{money(sumOf(rows, row => row.shippingFee))}</td>
            <td className="num">{money(sumOf(rows, row => row.paymentsReceived))}</td>
            <td className="num">{money(sumOf(rows, row => row.moneyReturned))}</td>
            <td className="num">{money(sumOf(rows, row => row.amountStillToPay))}</td>
          </tr>
        </tfoot>
      )}
    </table>
  );
};

const PrintCancelledBookingsTable = ({ rows }) => (
  <table className="pd-table pd-cancelled-table">
    <thead>
      <tr className="pd-col-header-row">
        <th scope="col" style={{ width: '22%' }}>Tracking No.</th>
        <th scope="col" style={{ width: '28%' }}>Customer</th>
        <th scope="col" className="num" style={{ width: '13%' }}>Paid</th>
        <th scope="col" className="num" style={{ width: '13%' }}>Refund</th>
        <th scope="col" className="num" style={{ width: '12%' }}>Retained</th>
        <th scope="col" className="num" style={{ width: '12%' }}>To Refund</th>
      </tr>
    </thead>
    <tbody>
      {rows.map(row => (
        <tr key={row.id}>
          <td className="pd-mono">{row.trackingNumber || '—'}</td>
          <td>{row.customerName}</td>
          <td className="num">{money(row.paymentsReceived)}</td>
          <td className="num">{money(row.moneyReturned)}</td>
          <td className="num">{money(row.cancellation?.retainedFee)}</td>
          <td className="num">{money(row.cancellation?.amountStillToRefund)}</td>
        </tr>
      ))}
    </tbody>
    <tfoot>
      <tr className="pd-subtotal">
        <td colSpan={2}>Cancelled Subtotal ({rows.length})</td>
        <td className="num">{money(sumOf(rows, row => row.paymentsReceived))}</td>
        <td className="num">{money(sumOf(rows, row => row.moneyReturned))}</td>
        <td className="num">{money(sumOf(rows, row => row.cancellation?.retainedFee))}</td>
        <td className="num">{money(sumOf(rows, row => row.cancellation?.amountStillToRefund))}</td>
      </tr>
    </tfoot>
  </table>
);

const PerTripSalesPage = () => {
  usePageTitle('Sales & Reports');
  const { user, userProfile } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [trips, setTrips] = useState([]);
  const [dateMode, setDateMode] = useState('month'); // 'month' | 'range'
  const [selectedMonth, setSelectedMonth] = useState(currentMonthValue());
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [monthlyReport, setMonthlyReport] = useState(null);
  const [reportScope, setReportScope] = useState(null);
  // Long date shown on the printed document; set when a report is generated.
  const [printDate, setPrintDate] = useState('');
  // Client-side filter over the generated report's per-trip list only. Grand
  // totals and the printed report always cover every trip in the period.
  const [tripSearch, setTripSearch] = useState('');
  const rangeError = (rangeStart || rangeEnd)
    ? (!rangeStart || !rangeEnd
      ? 'Pick both a start and an end date.'
      : rangeEnd < rangeStart ? 'The end date must be the same as or after the start date.' : null)
    : null;
  // An explicit toggle determines whether the month or the custom range supplies the scope.
  const activeScope = useMemo(() => {
    if (dateMode === 'range') {
      if (rangeError) return null;
      if (rangeStart && rangeEnd) {
        return {
          start: rangeStart,
          end: rangeEnd,
          key: `range:${rangeStart}|${rangeEnd}`,
          label: `${formatPhDate(`${rangeStart}T00:00:00+08:00`)} – ${formatPhDate(`${rangeEnd}T00:00:00+08:00`)}`,
        };
      }
      return null;
    }
    if (!selectedMonth) return null;
    const [year, month] = selectedMonth.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      start: `${selectedMonth}-01`,
      end: `${selectedMonth}-${String(lastDay).padStart(2, '0')}`,
      key: `month:${selectedMonth}`,
      isMonth: true,
      label: monthLabel(selectedMonth),
    };
  }, [dateMode, rangeStart, rangeEnd, rangeError, selectedMonth]);
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
  // Desktop starts with every trip expanded; phones start collapsed so the
  // page reads as a list of trips rather than a wall of booking cards.
  const [isDesktopLayout] = useState(() => window.matchMedia('(min-width: 901px)').matches);
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
  const loadMonthlyReport = useCallback(async (scope, { background = false } = {}) => {
    if (!scope) return;
    const sequence = ++requestSequenceRef.current;
    if (background) setRefreshing(true);
    else setLoadingReport(true);
    setError(null);

    try {
      const tripIds = trips
        .filter(trip => {
          const departure = phDateKey(trip.departure_date);
          return departure >= scope.start && departure <= scope.end;
        })
        .map(trip => trip.id);
      // A period with no departures is a valid, all-zero report (the page
      // renders "No trips this month"), not an error.
      const result = tripIds.length
        ? await getMonthlySalesReport(tripIds)
        : aggregateMonthlySalesReports([]);
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return;
      setMonthlyReport(result);
      setReportScope(scope);
      setPrintDate(new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }));
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

  // Changing the month or the date range never fetches by itself — it only
  // clears whatever report was on screen so it can't be mistaken for a match
  // to the new filter. Fetching happens only from handleGenerate (the
  // "Generate Report" click) below.
  const scopeKey = activeScope?.key ?? '';
  useEffect(() => {
    setHasGenerated(false);
    setMonthlyReport(null);
    setReportScope(null);
    setError(null);
  }, [scopeKey]);

  const handleGenerate = useCallback(() => {
    if (!activeScope) return;
    setTripSearch('');
    void loadMonthlyReport(activeScope);
  }, [activeScope, loadMonthlyReport]);

  const normalizedTripSearch = tripSearch.trim().toLowerCase();
  const filteredTripReport = useMemo(() => {
    if (!monthlyReport) return [];
    if (!normalizedTripSearch) return monthlyReport.tripBreakdown;
    return monthlyReport.tripBreakdown.filter(({ trip }) =>
      [trip.trip_number, trip.origin, trip.destination]
        .some(value => String(value || '').toLowerCase().includes(normalizedTripSearch))
    );
  }, [monthlyReport, normalizedTripSearch]);

  // Open on the current month's numbers instead of an empty page. Runs once,
  // after the trip list is in; changing the filter afterwards still waits for
  // "Generate Report", as described above.
  useEffect(() => {
    if (!tripsReady || autoGeneratedRef.current || !activeScope) return;
    autoGeneratedRef.current = true;
    void loadMonthlyReport(activeScope);
  }, [tripsReady, activeScope, loadMonthlyReport]);

  // Background refresh of an ALREADY-generated report (realtime order
  // changes, tab refocus, coming back online) is not gated behind another
  // Generate click — only the initial load on a filter change is.
  useEffect(() => {
    const refresh = () => {
      if (!hasGenerated || !activeScope) return;
      void loadMonthlyReport(activeScope, { background: true });
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [hasGenerated, activeScope, loadMonthlyReport]);

  const handleOrderChanges = useCallback(() => {
    if (!hasGenerated || !activeScope) return;
    void loadMonthlyReport(activeScope, { background: true });
  }, [hasGenerated, activeScope, loadMonthlyReport]);

  const handlePrint = () => {
    if (!hasGenerated || !monthlyReport || !reportScope) return;
    const reportLabel = reportScope.label;
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

  const canGenerate = Boolean(activeScope);

  return (
    <div className="page-transition per-trip-report">
      <div className="admin-page-header no-print">
        <div>
          <h1 className="admin-page-title"><FileText size={24} color="var(--primary)" aria-hidden="true" /> Sales & Reports</h1>
          <p className="admin-page-subtitle">Review shipping fees, payments, refunds, and balances for every trip in a month.</p>
        </div>
        <div className="flex items-center gap-8">
          {hasGenerated && (
            <button
              type="button"
              className="btn btn-outline btn-sm per-trip-header-print-btn"
              onClick={handlePrint}
              disabled={loadingReport || refreshing}
              title="Print official report"
            >
              <Printer size={15} aria-hidden="true" />
              <span className="per-trip-btn-text">Print Report</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm per-trip-icon-btn"
            onClick={handleGenerate}
            disabled={!canGenerate || loadingReport || refreshing}
            aria-label="Refresh report"
            title="Refresh report"
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
            <span className="per-trip-btn-text">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* ── Modern Streamlined Filter Card ──────────────────────── */}
      <div className="card per-trip-filter-card no-print">
        <div className="per-trip-filter-bar">
          {/* Segmented Filter Mode Pill */}
          <div className="report-segmented-control" role="group" aria-label="Date filter mode">
            <button
              type="button"
              className={`report-segmented-item ${dateMode === 'month' ? 'is-active' : ''}`}
              onClick={() => {
                setDateMode('month');
                setError(null);
              }}
            >
              <CalendarDays size={14} aria-hidden="true" />
              <span>By Month</span>
            </button>
            <button
              type="button"
              className={`report-segmented-item ${dateMode === 'range' ? 'is-active' : ''}`}
              onClick={() => {
                setDateMode('range');
                setError(null);
              }}
            >
              <Calendar size={14} aria-hidden="true" />
              <span>Custom Range</span>
            </button>
          </div>

          {/* Filter Pickers & Action */}
          <div className="per-trip-filter-inputs-group">
            {dateMode === 'month' ? (
              <div className="per-trip-input-inline">
                <input
                  id="per-trip-month"
                  type="month"
                  className="form-input report-month-input"
                  value={selectedMonth}
                  aria-label="Choose report month"
                  onChange={event => {
                    setError(null);
                    setSelectedMonth(event.target.value);
                  }}
                />
              </div>
            ) : (
              <div className="per-trip-range-pickers-inline">
                <DatePicker
                  id="per-trip-range-start"
                  aria-label="Range start date"
                  placeholder="Start date"
                  value={rangeStart}
                  max={rangeEnd || undefined}
                  onChange={val => { setError(null); setRangeStart(val); }}
                />
                <span className="range-separator">to</span>
                <DatePicker
                  id="per-trip-range-end"
                  aria-label="Range end date"
                  placeholder="End date"
                  value={rangeEnd}
                  min={rangeStart || undefined}
                  onChange={val => { setError(null); setRangeEnd(val); }}
                />
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary btn-sm per-trip-generate-btn"
              onClick={handleGenerate}
              disabled={!canGenerate || loadingReport}
              title="Generate report"
            >
              {loadingReport
                ? <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
                : <FileText size={15} aria-hidden="true" />}
              <span>Generate Report</span>
            </button>
          </div>
        </div>

        {dateMode === 'range' && rangeError && (
          <p className="form-error mt-8 mb-0" role="alert">{rangeError}</p>
        )}
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
          <div className="per-trip-scope-strip mt-16 mb-16">
            <div className="scope-strip-main">
              <span className="scope-period-tag">
                <CalendarDays size={13} aria-hidden="true" /> {reportScope?.label}
              </span>
              <span className="scope-trips-tag">
                <strong>{monthlyReport.grandTotal.tripCount}</strong> trip{monthlyReport.grandTotal.tripCount === 1 ? '' : 's'} included
              </span>
            </div>
            <span className="scope-note-tag">
              Computed per single-trip report calculation
            </span>
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

          <div className="per-trip-section-header no-print mt-24 mb-16">
            <div>
              <h3 className="mb-2">Per-trip Breakdown</h3>
              <p className="text-secondary text-xs mb-0">
                Individual booking fees and settlement records for trips departing in {reportScope?.label}
              </p>
            </div>
            <div className="per-trip-search-wrap">
              <Search size={14} className="search-icon" aria-hidden="true" />
              <input
                id="per-trip-search"
                type="search"
                className="form-input per-trip-search-input"
                placeholder="Search trip number, route..."
                value={tripSearch}
                onChange={event => setTripSearch(event.target.value)}
              />
              {tripSearch && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setTripSearch('')}
                  title="Clear search"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          {normalizedTripSearch && (
            <p className="text-xs text-secondary mt-n8 mb-12" role="status">
              Showing {filteredTripReport.length} of {monthlyReport.tripBreakdown.length} trip{monthlyReport.tripBreakdown.length === 1 ? '' : 's'}
            </p>
          )}
          {monthlyReport.tripBreakdown.length === 0 ? (
            <EmptyState title="No trips this month" description="No trip departed in this month." />
          ) : filteredTripReport.length === 0 ? (
            <EmptyState title="No matching trips" description={`No trip in ${reportScope?.label} matches “${tripSearch.trim()}”.`} />
          ) : (
            filteredTripReport.map((tripReport) => {
              const { trip, summary: tripSummary, activeRows, cancelledRows } = tripReport;
              return (
                <details key={trip.id} className="per-trip-disclosure mt-16" open={isDesktopLayout}>
                  <summary className="per-trip-disclosure-summary">
                    <span className="per-trip-disclosure-title">
                      {trip.trip_number || 'Trip'} · {trip.origin || 'Origin not set'} → {trip.destination || 'Destination not set'}
                    </span>
                    <span className="per-trip-disclosure-meta">
                      <span><CalendarDays size={14} aria-hidden="true" /> {tripDate(trip.departure_date)}</span>
                      <StatusBadge status={trip.status} size="sm" />
                      <span>{tripSummary.activeBookingCount} active · {tripSummary.cancelledBookingCount} cancelled</span>
                    </span>
                  </summary>

                  <div className="per-trip-disclosure-body">
                  <div className="flex justify-end">
                    <Link className="btn btn-outline btn-sm" to={`/admin/trips/${trip.id}`}>Open trip</Link>
                  </div>

                  <div className="card admin-section-card admin-table-card mt-12">
                    <div className="card-header">
                      <div>
                        <h4>Active & completed bookings ({tripSummary.activeBookingCount})</h4>
                        <p className="text-secondary text-xs mb-0">Final cargo fees and active balances exclude cancelled bookings.</p>
                      </div>
                    </div>
                    {activeRows.length > 0 ? <ActiveBookingsTable rows={activeRows} /> : <EmptyState title="No active or completed bookings" description="This trip has no non-cancelled bookings." className="empty-state-compact" />}
                  </div>

                  {/* A trip with no cancellations gets one quiet line, not a
                      full card with an empty-state illustration. */}
                  {cancelledRows.length > 0 ? (
                    <div className="card admin-section-card admin-table-card mt-20">
                      <div className="card-header">
                        <div>
                          <h4>Cancelled bookings ({tripSummary.cancelledBookingCount})</h4>
                          <p className="text-secondary text-xs mb-0">Cancelled bookings stay separate. No fee or refund is assumed without a recorded decision.</p>
                        </div>
                      </div>
                      <CancelledBookingsTable rows={cancelledRows} />
                    </div>
                  ) : (
                    <p className="per-trip-empty-note mt-12">No cancelled bookings on this trip.</p>
                  )}
                  </div>
                </details>
              );
            })
          )}

          <p className="per-trip-last-updated text-secondary text-xs mt-16 no-print">
            {lastUpdated ? `Last updated ${formatPhDateTime(lastUpdated)}.` : 'Not updated yet.'} Changes are refreshed from the authorized backend view without reloading the page.
          </p>

          <PrintDocument
            title={`${reportScope?.isMonth ? 'Monthly Sales Report' : 'Sales Report'}: ${reportScope?.label}`}
            subtitle={`${monthlyReport.grandTotal.tripCount} trip${monthlyReport.grandTotal.tripCount === 1 ? '' : 's'} departing in ${reportScope?.label}`}
            generatedAt={lastUpdated ? formatPhDateTime(lastUpdated) : ''}
            preparedBy={userProfile?.name}
          >
            <div className="pd-section pd-executive-summary" data-print-date={printDate}>
              <table className="pd-table pd-summary-table">
                <thead>
                  <tr>
                    <th colSpan={2} className="pd-summary-th">
                      FINANCIAL SUMMARY &mdash; {reportScope?.label?.toUpperCase()} ({monthlyReport.grandTotal.tripCount} {monthlyReport.grandTotal.tripCount === 1 ? 'TRIP' : 'TRIPS'})
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Total Cargo Fees (Gross Revenue)</td>
                    <td className="num">{money(monthlyReport.grandTotal.shippingFees)}</td>
                  </tr>
                  <tr>
                    <td>Total Payments Received</td>
                    <td className="num">{money(monthlyReport.grandTotal.paymentsReceived)}</td>
                  </tr>
                  <tr>
                    <td>Less: Refunds & Returns</td>
                    <td className="num">
                      {monthlyReport.grandTotal.moneyReturned > 0 ? `(${money(monthlyReport.grandTotal.moneyReturned)})` : '₱0.00'}
                    </td>
                  </tr>
                  <tr className="pd-summary-highlight">
                    <td><strong>Net Collections (Payments after Refunds)</strong></td>
                    <td className="num"><strong>{money(monthlyReport.grandTotal.paymentsAfterRefunds)}</strong></td>
                  </tr>
                  <tr className="pd-summary-highlight">
                    <td><strong>Total Outstanding Receivables (Balance to Collect)</strong></td>
                    <td className="num"><strong>{money(monthlyReport.grandTotal.amountStillToCollect)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>

            {monthlyReport.tripBreakdown.map((tripReport) => {
              const { trip, activeRows, cancelledRows } = tripReport;
              const hasActive = activeRows && activeRows.length > 0;
              const hasCancelled = cancelledRows && cancelledRows.length > 0;

              return (
                <div className="pd-section pd-trip-section" key={trip.id}>
                  {hasActive && (
                    <PrintTripTable trip={trip} rows={activeRows} />
                  )}

                  {!hasActive && hasCancelled && (
                    <table className="pd-table pd-trip-table" style={{ marginBottom: '4pt' }}>
                      <thead>
                        <tr className="pd-trip-banner-row">
                          <th colSpan={3} className="pd-trip-banner-title">
                            <span className="pd-trip-num">{trip.trip_number || 'Trip'}</span>
                            <span className="pd-trip-sep">•</span>
                            <span className="pd-trip-route">{trip.origin || 'Origin not set'} → {trip.destination || 'Destination not set'}</span>
                            <span style={{ marginLeft: '6pt', fontSize: '7.5pt', color: '#991b1b', fontWeight: 'bold' }}>
                              [CANCELLED TRIP — REFUNDS]
                            </span>
                          </th>
                          <th colSpan={3} className="pd-trip-banner-date num">
                            Departure: <strong>{tripDate(trip.departure_date)}</strong>
                          </th>
                        </tr>
                      </thead>
                    </table>
                  )}

                  {hasCancelled && (
                    <div className="pd-cancelled-section">
                      <div className="pd-cancelled-title">Cancelled Bookings & Refunds ({cancelledRows.length})</div>
                      <PrintCancelledBookingsTable rows={cancelledRows} />
                    </div>
                  )}
                </div>
              );
            })}

            <div className="pd-grand-total-section">
              <table className="pd-table pd-grand-total-table">
                <thead>
                  <tr>
                    <th colSpan={2} style={{ width: '50%' }}>
                      GRAND TOTAL SUMMARY ({monthlyReport.grandTotal.tripCount} {monthlyReport.grandTotal.tripCount === 1 ? 'TRIP' : 'TRIPS'})
                    </th>
                    <th className="num" style={{ width: '13%' }}>Total Cargo Fees</th>
                    <th className="num" style={{ width: '13%' }}>Total Paid</th>
                    <th className="num" style={{ width: '12%' }}>Total Refund</th>
                    <th className="num" style={{ width: '12%' }}>Total Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="pd-grand-total-row">
                    <td colSpan={2}>
                      <strong>Total All Trips</strong>
                    </td>
                    <td className="num"><strong>{money(monthlyReport.grandTotal.shippingFees)}</strong></td>
                    <td className="num"><strong>{money(monthlyReport.grandTotal.paymentsReceived)}</strong></td>
                    <td className="num"><strong>{money(monthlyReport.grandTotal.moneyReturned)}</strong></td>
                    <td className="num"><strong>{money(monthlyReport.grandTotal.amountStillToCollect)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="pd-printed-on">Prepared by: CargoExpress PH Admin · Printed on: {printDate || '—'}</p>
          </PrintDocument>
        </>
      )}
    </div>
  );
};

export default PerTripSalesPage;
