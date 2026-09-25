import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { getTrips } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import { CenteredSpinner } from '../../components/ui/Loader';
import EmptyState from '../../components/ui/EmptyState';
import { Calendar, Truck, AlertCircle, ChevronRight, RefreshCw, ArrowRight } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import PullToRefresh from '../../components/ui/PullToRefresh';
import { formatMoney } from '../../utils/currencyInput';
import { formatPhDate, formatTripScheduleDate } from '../../utils/datetime';
import { useTripBooking } from '../../hooks/useTripBooking';
import { PUBLIC_PAGES } from '../../seo/publicPages';

// Max ms to wait before showing an error instead of an infinite spinner.
const LOAD_TIMEOUT_MS = 15000;

// Translate Supabase / network errors into friendly messages.
const normalizeError = (err) => {
  const msg = err?.message || String(err || '');
  if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('failed to fetch')) return 'Network error. Please check your internet connection and try again.';
  if (msg.toLowerCase().includes('timeout') || msg.includes('AbortError')) return 'The request timed out. Please try again.';
  if (msg.includes('JWT') || msg.toLowerCase().includes('unauthorized')) return 'Your session has expired. Please refresh the page.';
  return msg || 'Failed to load trips. Please try again.';
};

const TripsPage = () => {
  usePageTitle('Trips');
  const selectTrip = useTripBooking();
  // Guests see this page at /schedules. There it uses the heading and summary
  // the build writes into the crawlable HTML, so the page a search engine
  // reads is the page a visitor sees.
  const { pathname } = useLocation();
  const publicPage = pathname === '/schedules' ? PUBLIC_PAGES['/schedules'] : null;
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const timeoutRef = useRef(null);
  const isMountedRef = useRef(true);

  const clearLoadTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const loadTrips = useCallback(async () => {
    setError(null);
    setLoading(true);

    // Timeout guard — never show an infinite spinner
    clearLoadTimeout();
    timeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setLoading(false);
        setError('Loading took too long. Please check your connection and try again.');
      }
    }, LOAD_TIMEOUT_MS);

    try {
      const data = await getTrips('active');
      clearLoadTimeout();
      if (isMountedRef.current) {
        setTrips(data || []);
        setLoading(false);
      }
    } catch (err) {
      clearLoadTimeout();
      if (isMountedRef.current) {
        setError(normalizeError(err));
        setLoading(false);
      }
    }
  }, [clearLoadTimeout]);

  useEffect(() => {
    isMountedRef.current = true;
    loadTrips();
    return () => {
      isMountedRef.current = false;
      clearLoadTimeout();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PullToRefresh onRefresh={loadTrips}>
      <div className="page-transition customer-trips-page">
      <div className="customer-page-heading">
        <div>
          {/* The count sits beside the title it counts, not alone at the far edge. */}
          <div className="customer-trips-title-row">
            <h1 className="fw-700 mb-4">{publicPage?.heading || 'Available Trips'}</h1>
            {!loading && !error && trips.length > 0 && (
              <span className="badge badge-success">{trips.length} open</span>
            )}
          </div>
          <p className="text-sm text-secondary">{publicPage?.summary || 'Choose a route and reserve cargo space fast.'}</p>
        </div>
      </div>

      {loading ? (
        <CenteredSpinner />
      ) : error ? (
        <div className="card animate-scale-in text-center" role="alert" style={{ padding: 40 }}>
          <div className="flex items-center justify-center mx-auto mb-16" style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--error-bg)' }}>
            <AlertCircle size={28} color="var(--error)" aria-hidden="true" />
          </div>
          <h3 className="mb-8" style={{ color: 'var(--error-dark)' }}>Error Loading Trips</h3>
          <p className="text-secondary text-sm mb-20">{error}</p>
          <button
            className="btn btn-primary flex items-center gap-8 mx-auto"
            onClick={loadTrips}
          >
            <RefreshCw size={16} />
            Try Again
          </button>
        </div>
      ) : trips.length === 0 ? (
        <div className="animate-scale-in">
          <EmptyState
            icon={Truck}
            title="No Active Trips"
            description="There are no scheduled trips at the moment. Check back later for available trips."
          />
        </div>
      ) : (
        <div className="customer-trip-grid">
          {trips.map((trip, index) => {
            const tripDate = formatTripScheduleDate(trip.departure_date);
            const capacity = Number(trip.capacity) || 0;
            const booked = Number(trip.current_weight) || 0;
            const spaceLeft = Math.max(0, capacity - booked);
            // Capacity is company-wide (Company Information); with none set
            // there is nothing meaningful to draw, so the meter is omitted.
            const usedPct = capacity > 0 ? Math.min(100, Math.round((booked / capacity) * 100)) : null;
            const fillingUp = usedPct !== null && usedPct >= 85;
            return (
              <button
                key={trip.id}
                type="button"
                className="customer-trip-list-card card card-interactive stagger-item"
                style={{ animationDelay: `${index * 60}ms` }}
                onClick={() => selectTrip(trip)}
                aria-label={`Book trip ${trip.trip_number}, ${trip.origin} to ${trip.destination}, departing ${tripDate.full}`}
              >
                <div className="ctrip-top">
                  <div className="customer-trip-date-badge" aria-hidden="true">
                    <span>{tripDate.month}</span>
                    <strong>{tripDate.day}</strong>
                  </div>
                  <div className="ctrip-heading">
                    {/* "Scheduled" is the admin's word; to a customer this list
                        is simply trips they can still book on. */}
                    <div className="ctrip-badges">
                      {trip.status === 'scheduled'
                        ? <span className="badge badge-success text-xs">Open for booking</span>
                        : <StatusBadge status={trip.status} size="sm" />}
                      {fillingUp && <span className="badge badge-warning text-xs">Filling up</span>}
                    </div>
                    <p className="ctrip-route">
                      <span>{trip.origin}</span>
                      <ArrowRight size={16} aria-hidden="true" className="ctrip-route-arrow" />
                      <span>{trip.destination}</span>
                    </p>
                    <p className="ctrip-when">
                      <Calendar size={14} aria-hidden="true" />
                      {formatPhDate(trip.departure_date, { weekday: 'short', month: 'short' })}
                    </p>
                  </div>
                </div>

                <div className="ctrip-stats">
                  <div className={`ctrip-stat${fillingUp ? ' is-filling' : ''}`}>
                    <span className="ctrip-stat-label">Space left</span>
                    <strong className="ctrip-stat-value">{spaceLeft.toLocaleString()} kg</strong>
                    {usedPct !== null && (
                      <span className="ctrip-meter" aria-hidden="true">
                        <span style={{ width: `${usedPct}%` }} />
                      </span>
                    )}
                  </div>
                  <div className="ctrip-stat">
                    <span className="ctrip-stat-label">Rate</span>
                    <strong className="ctrip-stat-value">{formatMoney(parseFloat(trip.price_per_kg || 70))}/kg</strong>
                    <span className="ctrip-stat-sub">Weighed at pickup</span>
                  </div>
                </div>

                <div className="ctrip-footer">
                  <span className="ctrip-number"><Truck size={14} aria-hidden="true" /> {trip.trip_number}</span>
                  {/* The whole card is the button; this is its visible label. */}
                  <span className="customer-trip-book-cta" aria-hidden="true">
                    Book this trip <ChevronRight size={16} />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {!loading && !error && trips.length > 0 && (
        <p className="customer-trips-note">
          New trips are added regularly. You can also book without choosing a trip, and we&apos;ll assign your shipment to the next available one.
        </p>
      )}
    </div>
    </PullToRefresh>
  );
};

export default TripsPage;
