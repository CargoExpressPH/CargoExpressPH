import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTrips } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import { SkeletonOrderCard } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import { Calendar, Truck, AlertCircle, ChevronRight, RefreshCw } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

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

const formatTripDate = (value) => {
  if (!value) return { month: 'TBD', day: '--', full: 'Date not set' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { month: 'TBD', day: '--', full: 'Date not set' };
  return {
    month: date.toLocaleDateString('en-PH', { month: 'short' }).toUpperCase(),
    day: date.toLocaleDateString('en-PH', { day: 'numeric' }),
    full: date.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' }),
  };
};

const TripsPage = () => {
  usePageTitle('Trips');
  const navigate = useNavigate();
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
    <div className="page-transition customer-trips-page">
      <div className="customer-page-heading">
        <div>
          <h1 className="fw-800 mb-4">Available Trips</h1>
          <p className="text-sm text-secondary">Choose a route and reserve cargo space fast.</p>
        </div>
        {!loading && !error && <span className="badge badge-success">{trips.length} active</span>}
      </div>

      {loading ? (
        <div>
          {[0, 1, 2].map(i => (
            <div key={i} className="stagger-item mb-12" style={{ animationDelay: `${i * 60}ms` }}>
              <SkeletonOrderCard />
            </div>
          ))}
        </div>
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
        trips.map((trip, index) => {
          const tripDate = formatTripDate(trip.departure_date);
          return (
            <button
              key={trip.id}
              type="button"
              className="customer-trip-list-card card card-interactive stagger-item mb-12"
              style={{ animationDelay: `${index * 60}ms` }}
              onClick={() => navigate('/customer/book', { state: { preselectedRoute: `${trip.origin} → ${trip.destination}`, preselectedTripId: trip.id } })}
            >
              <div className="card-body p-16">
                <div className="customer-trip-row">
                  <div className="customer-trip-date-badge">
                    <span>{tripDate.month}</span>
                    <strong>{tripDate.day}</strong>
                  </div>
                  <div>
                    <div className="customer-list-card-top mb-6">
                      <span className="customer-list-card-title">{trip.origin} to {trip.destination}</span>
                      <StatusBadge status={trip.status} size="sm" />
                    </div>
                    <div className="customer-list-card-meta mb-4">
                      <Truck size={14} aria-hidden="true" />
                      <span>{trip.trip_number}</span>
                    </div>
                    <div className="customer-list-card-route mb-8">
                      <Calendar size={14} aria-hidden="true" />
                      <span>{tripDate.full}</span>
                    </div>
                    <div className="flex gap-8 items-center flex-wrap" style={{ gap: '6px' }}>
                      <span className="badge badge-info text-xs" style={{ padding: '3px 8px', borderRadius: '4px' }}>
                        <strong>{Math.max(0, (trip.capacity || 0) - (trip.current_weight || 0)).toLocaleString()} kg</strong> space left
                      </span>
                      <span className="badge badge-success text-xs" style={{ padding: '3px 8px', borderRadius: '4px' }}>
                        <strong>₱{parseFloat(trip.price_per_kg || 70).toFixed(2)}/kg</strong> rate
                      </span>
                    </div>
                  </div>
                  <ChevronRight size={18} className="customer-card-chevron" />
                </div>
              </div>
            </button>
          );
        })
      )}
    </div>
  );
};

export default TripsPage;
