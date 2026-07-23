import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { getActivityLogsByRecord } from '../../lib/database';
import { deriveStatusTimestamps } from '../../utils/statusTimestamps';
import {
  Container, Search, Loader, Package, MapPin, ArrowRight,
  CheckCircle2, XCircle, Clock, Weight, User, Coins,
  RefreshCw, AlertTriangle, Truck, Calendar, Info, ClipboardCheck, Building2, Bike,
} from 'lucide-react';
import { STATUS_TIMELINE, TRACKING_STATUS_TONES, STATUS_ICONS, ORDER_STATUS } from '../../constants/status';
import TrackingTimeline from '../../components/ui/TrackingTimeline';
import usePageTitle from '../../hooks/usePageTitle';

/* ── Status icon resolver ─────────────────────────────────────────────
   Complete coverage for every ORDER_STATUS value — previously only 4 of
   the 9 statuses had a dedicated icon and the rest silently fell back to
   a generic Package icon on the hero status banner. */
const ICON_COMPONENTS = {
  clipboardCheck: ClipboardCheck,
  clock: Clock,
  package: Package,
  truck: Truck,
  building: Building2,
  bike: Bike,
  checkCircle: CheckCircle2,
  xCircle: XCircle,
};
const getStatusIcon = (status) =>
  (status && ICON_COMPONENTS[STATUS_ICONS[status]]) || Package;

/* ── Date helpers (locale unified to en-PH everywhere) ──────────────── */
const PH_LOCALE = 'en-PH';
const formatDate = (iso, withTime = false) => {
  if (!iso) return '—';
  const opts = { year: 'numeric', month: 'short', day: 'numeric' };
  if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
  try { return new Date(iso).toLocaleDateString(PH_LOCALE, opts); }
  catch { return new Date(iso).toLocaleDateString(undefined, opts); }
};

/* Auto-refresh cadence while the result is visible and the tab is focused.
   45s — frequent enough to feel "live", gentle on the anon RPC. */
const REFRESH_INTERVAL_MS = 45000;

/* ══════════════════════════════════════════════════════════════════════
   TrackingPage
══════════════════════════════════════════════════════════════════════ */
const TrackingPage = ({ embedded = false }) => {
  usePageTitle('Track Shipment');
  const [searchParams] = useSearchParams();
  const [trackingNumber, setTrackingNumber] = useState(searchParams.get('q') || '');
  const [order,   setOrder]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [searched, setSearched] = useState(false);
  const [activityLogs, setActivityLogs] = useState([]);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // Latest tracking number we are viewing — kept in a ref so the
  // visibilitychange/polling callbacks always read the current value
  // without re-subscribing on every render.
  const activeQueryRef = useRef(null);
  const intervalRef = useRef(null);

  const stepTimestamps = useMemo(
    () => deriveStatusTimestamps(activityLogs, order?.created_at, order?.status),
    [activityLogs, order?.created_at, order?.status]
  );

  /* fetchOrder: single source of truth for hitting the (now hardened)
     public RPC. `silent=true` skips loading/error UI so background
     refreshes don't flicker the page. */
  const fetchOrder = useCallback(async (tn, { silent = false } = {}) => {
    if (!silent) {
      setLoading(true); setError(''); setOrder(null); setSearched(true); setActivityLogs([]);
    }
    try {
      const { data, error: fetchError } = await supabase
        .rpc('track_order_public', { p_tracking_number: tn })
        .maybeSingle();
      if (fetchError || !data) {
        if (!silent) setError('No shipment found with this tracking number. Please double-check and try again.');
        return;
      }
      setOrder(data);
      setLastRefreshed(new Date());
      if (data?.id) {
        try {
          const logs = await getActivityLogsByRecord(data.id);
          setActivityLogs(logs || []);
        } catch {
          // Non-admin public query fallback handled by deriveStatusTimestamps baseline
        }
      }
    } catch {
      if (!silent) setError('Something went wrong. Please try again later.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Initial load from ?q= querystring
  useEffect(() => {
    const q = searchParams.get('q');
    if (q?.trim()) {
      const tn = q.trim().toUpperCase();
      setTrackingNumber(tn);
      activeQueryRef.current = tn;
      fetchOrder(tn);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Auto-refresh: poll while the tab is visible AND we are showing a
     non-terminal result. Stops entirely when the tab is hidden or the
     shipment reaches Delivered/Cancelled. */
  useEffect(() => {
    const isTerminal = order?.status === ORDER_STATUS.DELIVERED || order?.status === ORDER_STATUS.CANCELLED;
    const tn = activeQueryRef.current;

    const tick = () => {
      if (document.visibilityState === 'visible' && tn && !isTerminal) {
        fetchOrder(tn, { silent: true });
      }
    };

    // Clear any prior interval before (re)arming.
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (tn && !isTerminal) {
      intervalRef.current = setInterval(tick, REFRESH_INTERVAL_MS);
    }
    const onVisibility = () => {
      // Refresh immediately when returning to the tab, then let the interval resume.
      if (document.visibilityState === 'visible' && tn && !isTerminal) tick();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [order?.status, fetchOrder]);

  const handleSearch = (e) => {
    e.preventDefault();
    const tn = trackingNumber.trim().toUpperCase();
    if (!tn) return;
    activeQueryRef.current = tn;
    fetchOrder(tn);
  };

  const handleReset = () => {
    activeQueryRef.current = null;
    setTrackingNumber('');
    setOrder(null);
    setError('');
    setSearched(false);
    setLastRefreshed(null);
  };

  const StatusIcon = getStatusIcon(order?.status);
  const statusColor = order ? TRACKING_STATUS_TONES[order.status] : null;
  const completedSteps = order ? STATUS_TIMELINE.indexOf(order.status) : -1;
  const progressPct = order?.status === 'Cancelled' ? 0
    : order ? Math.round(((completedSteps) / (STATUS_TIMELINE.length - 1)) * 100)
    : 0;

  // ETA: only meaningful before delivery. trip.arrival_date from the RPC.
  const estimatedDelivery = order?.estimated_delivery || null;
  const showEta = estimatedDelivery
    && order?.status !== ORDER_STATUS.DELIVERED
    && order?.status !== ORDER_STATUS.CANCELLED;

  return (
    <div className={`trk-page${embedded ? ' trk-page--embedded' : ''}`}>

      {/* ── Decorative orbs ── */}
      {!embedded && (
        <>
          <div className="trk-orb trk-orb-1" aria-hidden="true" />
          <div className="trk-orb trk-orb-2" aria-hidden="true" />
          <div className="trk-orb trk-orb-3" aria-hidden="true" />
        </>
      )}

      {/* ══════════ HEADER ══════════ */}
      <header className="trk-header animate-fade-in">
        {!embedded && (
          <Link to="/login" className="trk-brand" aria-label="CargoExpress Home" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
            <Container size={24} color="var(--primary)" />
            <span className="trk-brand-name" style={{ display: 'inline-flex', gap: 4, fontSize: '1.25rem', fontWeight: 900 }}>
              <span style={{ color: 'var(--accent)' }}>CARGO</span>
              <span style={{ color: 'var(--primary)' }}>EXPRESS</span>
            </span>
          </Link>
        )}
        <h1 className="trk-headline">Track Your Shipment</h1>
        <p className="trk-subheadline">Live status updates — know exactly where your package is</p>
      </header>

      {/* ══════════ SEARCH ══════════ */}
      <form className="trk-search-form" onSubmit={handleSearch} role="search">
        <div className={`trk-search-box ${loading ? 'trk-search-box--loading' : ''}`}>
          <Search size={18} className="trk-search-icon" aria-hidden="true" />
          <input
            id="tracking-input"
            type="text"
            className="trk-search-input"
            placeholder="Enter tracking number (e.g. CE-20240101-001)"
            value={trackingNumber}
            onChange={e => setTrackingNumber(e.target.value.toUpperCase())}
            aria-label="Tracking number"
            autoComplete="off"
            spellCheck="false"
          />
          {trackingNumber && !loading && (
            <button
              type="button"
              className="trk-clear-btn"
              onClick={handleReset}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
          <button
            type="submit"
            className="trk-search-btn"
            disabled={loading || !trackingNumber.trim()}
            aria-label="Track shipment"
            aria-busy={loading}
          >
            {loading
              ? <Loader size={16} className="animate-spin" />
              : <><Search size={15} /> Track</>
            }
          </button>
        </div>
      </form>

      {/* ══════════ ERROR STATE ══════════ */}
      {error && !loading && (
        <div className="trk-not-found animate-slide-up" role="alert">
          <div className="trk-not-found-icon">
            <AlertTriangle size={28} />
          </div>
          <h3 className="trk-not-found-title">Shipment Not Found</h3>
          <p className="trk-not-found-msg">{error}</p>
          <button className="trk-retry-btn" onClick={handleReset}>
            <RefreshCw size={14} /> Try Another
          </button>
        </div>
      )}

      {/* ══════════ RESULT CARD ══════════ */}
      {order && !loading && (
        <div className="trk-card animate-slide-up" role="main">

          {/* ── Status Banner ── */}
          <div
            className="trk-status-banner"
            style={{
              background: statusColor?.bg || 'var(--bg-secondary)',
              borderColor: statusColor?.border || 'var(--border)',
            }}
          >
            <div className="trk-status-left">
              <div
                className="trk-status-icon-wrap"
                style={{ background: statusColor?.iconBg || 'var(--bg-secondary)' }}
              >
                <StatusIcon size={22} style={{ color: statusColor?.text }} />
              </div>
              <div>
                <p className="trk-status-label">Current Status</p>
                <p className="trk-status-value" style={{ color: statusColor?.text }}>
                  {order.status}
                </p>
              </div>
            </div>
            <div className="trk-tracking-num">
              <p className="trk-tracking-num-label">Tracking No.</p>
              <p className="trk-tracking-num-value">{order.tracking_number}</p>
            </div>
          </div>

          {/* ── ETA banner (pre-delivery only) ── */}
          {showEta && (
            <div className="trk-eta-banner" role="status">
              <div className="trk-eta-icon" aria-hidden="true">
                <Calendar size={16} />
              </div>
              <div className="trk-eta-text">
                <span className="trk-eta-label">Estimated Delivery</span>
                <span className="trk-eta-value">{formatDate(estimatedDelivery)}</span>
              </div>
              <span className="trk-eta-caveat">Estimated</span>
            </div>
          )}

          {/* ── Progress bar ── */}
          {order.status !== 'Cancelled' && (
            <div className="trk-progress-wrap">
              <div className="trk-progress-bar">
                <div
                  className="trk-progress-fill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="trk-progress-pct">{progressPct}% Complete</span>
            </div>
          )}

          {/* ── Timeline ── */}
          <div className="trk-timeline-wrap">
            <p className="trk-section-label">Shipment Journey</p>
            <TrackingTimeline currentStatus={order.status} stepTimestamps={stepTimestamps} />
          </div>

          {/* ── Info grid ── */}
          <div className="trk-info-section">
            <p className="trk-section-label">Shipment Details</p>
            <div className="trk-info-grid">

              {/* Route */}
              <div className="trk-info-tile">
                <div className="trk-info-tile-icon">
                  <MapPin size={14} />
                </div>
                <div>
                  <p className="trk-info-tile-label">Route</p>
                  <p className="trk-info-tile-value">
                    {order.origin || '—'}
                    <ArrowRight size={13} className="trk-route-arrow" />
                    {order.destination || '—'}
                  </p>
                </div>
              </div>

              {/* Package */}
              <div className="trk-info-tile">
                <div className="trk-info-tile-icon">
                  <Package size={14} />
                </div>
                <div>
                  <p className="trk-info-tile-label">Package</p>
                  <p className="trk-info-tile-value">{order.package_description || 'No description'}</p>
                  <p className="trk-info-tile-meta">
                    <Weight size={11} /> {order.actual_weight || order.package_weight || '—'} kg
                  </p>
                </div>
              </div>

              {/* Sender */}
              <div className="trk-info-tile">
                <div className="trk-info-tile-icon">
                  <User size={14} />
                </div>
                <div>
                  <p className="trk-info-tile-label">Sender</p>
                  <p className="trk-info-tile-value">{order.sender_name || '—'}</p>
                </div>
              </div>

              {/* Receiver */}
              <div className="trk-info-tile">
                <div className="trk-info-tile-icon">
                  <User size={14} />
                </div>
                <div>
                  <p className="trk-info-tile-label">Receiver</p>
                  <p className="trk-info-tile-value">{order.receiver_name || '—'}</p>
                </div>
              </div>

              {/* Shipping cost */}
              {order.shipping_cost && (
                <div className="trk-info-tile">
                  <div className="trk-info-tile-icon">
                    <Coins size={14} />
                  </div>
                  <div>
                    <p className="trk-info-tile-label">Shipping Cost</p>
                    <p className="trk-info-tile-value trk-cost">
                      ₱{parseFloat(order.shipping_cost).toFixed(2)}
                    </p>
                  </div>
                </div>
              )}

              {/* Booked date */}
              <div className="trk-info-tile">
                <div className="trk-info-tile-icon">
                  <Calendar size={14} />
                </div>
                <div>
                  <p className="trk-info-tile-label">Booked</p>
                  <p className="trk-info-tile-value">{formatDate(order.created_at)}</p>
                </div>
              </div>
            </div>
          </div>

          {/* ── Footer timestamps ── */}
          <div className="trk-card-footer">
            <span className="trk-timestamp">
              <Clock size={11} />
              Booked {formatDate(order.created_at)}
            </span>
            <span className="trk-timestamp trk-timestamp-live" title={lastRefreshed ? `Auto-refreshed ${formatDate(lastRefreshed.toISOString(), true)}` : undefined}>
              <RefreshCw size={11} />
              {order.status === ORDER_STATUS.DELIVERED || order.status === ORDER_STATUS.CANCELLED
                ? `Last updated ${formatDate(order.updated_at, true)}`
                : lastRefreshed
                  ? `Updated ${formatDate(lastRefreshed.toISOString(), true)} · auto-refresh on`
                  : `Last updated ${formatDate(order.updated_at, true)}`}
            </span>
          </div>
        </div>
      )}

      {/* ══════════ EMPTY STATE ══════════ */}
      {!searched && !order && !loading && (
        <div className="trk-empty">
          <div className="trk-empty-icon">
            <Package size={36} />
          </div>
          <h3 className="trk-empty-title">Enter Your Tracking Number</h3>
          <p className="trk-empty-sub">
            Paste or type your CargoExpress PH tracking number above to get live shipment updates.
          </p>
          <div className="trk-empty-tips">
            <div className="trk-empty-tip">
              <Info size={14} color="var(--primary)" style={{ flexShrink: 0 }} aria-hidden="true" />
              <span>Tracking numbers follow the format <strong>CE-YYYYMMDD-XXXX</strong></span>
            </div>
            <div className="trk-empty-tip">
              <Package size={14} color="var(--primary)" style={{ flexShrink: 0 }} aria-hidden="true" />
              <span>Contact CargoExpress PH staff if you need help locating it</span>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ PAGE FOOTER ══════════ */}
      {!embedded && (
      <footer className="trk-footer">
        <p>Have an account? <Link to="/login" className="trk-footer-link">Sign In</Link></p>
        <p className="trk-footer-copy">© {new Date().getFullYear()} CargoExpress PH</p>
      </footer>
      )}
    </div>
  );
};

export default TrackingPage;
