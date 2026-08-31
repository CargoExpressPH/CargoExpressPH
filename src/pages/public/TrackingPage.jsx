import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getPublicOrderEvents, getPublicTrackingResult } from '../../lib/database';
import { buildStatusTimestamps } from '../../utils/statusTimestamps';
import { formatPhDate, formatPhDateTime } from '../../utils/datetime';
import {
  Search, Loader, Package, MapPin, ArrowRight,
  CheckCircle2, XCircle, Clock, Weight, User,
  RefreshCw, AlertTriangle, ShieldAlert, Truck, Calendar, Info, ClipboardCheck, Building2, Bike,
} from 'lucide-react';
import { STATUS_TIMELINE, TRACKING_STATUS_TONES, STATUS_ICONS, ORDER_STATUS, timelineStatus } from '../../constants/status';
import TrackingTimeline from '../../components/ui/TrackingTimeline';
import { CenteredSpinner } from '../../components/ui/Loader';
import usePageTitle from '../../hooks/usePageTitle';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { invalidClass } from '../../components/ui/FieldError';
import BrandLockup from '../../components/ui/BrandLogo';

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
// Zone is pinned to Asia/Manila, not left to the viewer's machine: the ETA is a
// PH wall-clock time, and an evening departure rendered in a western zone rolled
// back (or forward) a calendar day. See src/utils/datetime.js.
const formatDate = (iso, withTime = false) =>
  withTime ? formatPhDateTime(iso) : formatPhDate(iso);

/* Auto-refresh cadence while the result is visible and the tab is focused.
   45s — frequent enough to feel "live", gentle on the anon RPC. */
const REFRESH_INTERVAL_MS = 45000;
const DEFAULT_RETRY_AFTER_SEC = 30;
const RATE_LIMIT_USER_MSG =
  'Too many tracking requests. Please wait a moment before trying again.';

/**
 * Detect rate-limit / 429 style failures from Supabase client errors,
 * fetch wrappers ("HTTP Error 429"), or message text.
 * Returns { seconds } when limited, otherwise null.
 */
const detectRateLimit = (err) => {
  if (!err) return null;

  const status = err.status ?? err.statusCode ?? err.code;
  const blob = [err.message, err.details, err.hint, err.code, String(status ?? '')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const isRate =
    status === 429 ||
    status === '429' ||
    blob.includes('rate limit') ||
    blob.includes('over_request_rate_limit') ||
    blob.includes('too many requests') ||
    blob.includes('http error 429') ||
    /\b429\b/.test(blob);

  if (!isRate) return null;

  // Prefer explicit retry hints when present; otherwise default cooldown.
  const retryMatch =
    blob.match(/retry[\s_-]*after[:\s]*(\d+)/i) ||
    blob.match(/try again in\s+(\d+)/i) ||
    blob.match(/(\d+)\s*seconds?/);
  const seconds = retryMatch
    ? Math.min(300, Math.max(1, parseInt(retryMatch[1], 10)))
    : DEFAULT_RETRY_AFTER_SEC;

  return { seconds };
};

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
  const { errors, validate, clearError } = useFieldErrors();
  const [statusEvents, setStatusEvents] = useState([]);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);

  // Latest tracking number we are viewing — kept in a ref so the
  // visibilitychange/polling callbacks always read the current value
  // without re-subscribing on every render.
  const activeQueryRef = useRef(null);
  const intervalRef = useRef(null);
  // Mirror rate-limit flag for poll/fetch guards (avoids stale closures).
  const isRateLimitedRef = useRef(false);

  const stepTimestamps = useMemo(
    () => buildStatusTimestamps(statusEvents, order?.created_at, order?.status),
    [statusEvents, order?.created_at, order?.status]
  );

  const applyRateLimit = useCallback((seconds = DEFAULT_RETRY_AFTER_SEC) => {
    isRateLimitedRef.current = true;
    setIsRateLimited(true);
    setRetryAfterSeconds(seconds);
    setError(RATE_LIMIT_USER_MSG);
  }, []);

  const clearRateLimit = useCallback(() => {
    isRateLimitedRef.current = false;
    setIsRateLimited(false);
    setRetryAfterSeconds(0);
    setError(prev => (prev === RATE_LIMIT_USER_MSG ? '' : prev));
  }, []);

  // Countdown: tick once per second while limited; at 0 lift the cooldown.
  useEffect(() => {
    if (!isRateLimited) return undefined;

    if (retryAfterSeconds <= 0) {
      clearRateLimit();
      return undefined;
    }

    const timer = setTimeout(() => {
      setRetryAfterSeconds(prev => Math.max(0, prev - 1));
    }, 1000);

    return () => clearTimeout(timer);
  }, [isRateLimited, retryAfterSeconds, clearRateLimit]);

  /* fetchOrder: single source of truth for hitting the (now hardened)
     public RPC. `silent=true` skips loading/error UI so background
     refreshes don't flicker the page. */
  const fetchOrder = useCallback(async (tn, { silent = false } = {}) => {
    // Hard block while cooldown is active (ref is always current).
    if (isRateLimitedRef.current) {
      if (!silent) {
        setIsRateLimited(true);
        setError(RATE_LIMIT_USER_MSG);
      }
      return;
    }

    if (!silent) {
      setLoading(true);
      setError('');
      setOrder(null);
      setSearched(true);
      setStatusEvents([]);
    }
    try {
      let data = null;
      try {
        data = await getPublicTrackingResult(tn);
      } catch (fetchError) {
        const rate = detectRateLimit(fetchError);
        if (rate) {
          applyRateLimit(rate.seconds);
          // Silent poll: keep showing last good order; stop further spam via ref.
          if (!silent) {
            setOrder(null);
            setStatusEvents([]);
          }
          return;
        }
        if (!silent) {
          setError('No shipment found with this tracking number. Please double-check and try again.');
        }
        return;
      }
      if (!data) {
        if (!silent) {
          setError('No shipment found with this tracking number. Please double-check and try again.');
        }
        return;
      }
      // Successful lookup ends any prior cooldown.
      if (isRateLimitedRef.current) clearRateLimit();
      setOrder(data);
      setLastRefreshed(new Date());
      // Status history via a public RPC keyed on the tracking number.
      //
      // This previously called getActivityLogsByRecord(data.id) — which never
      // ran, because track_order_public() does not return `id`, and would have
      // been blocked by activity_logs' admin-only RLS even if it had. The
      // public timeline has therefore never shown real timestamps.
      try {
        const events = await getPublicOrderEvents(tn);
        setStatusEvents(events || []);
      } catch {
        // Fall back to the created_at baseline in buildStatusTimestamps.
        setStatusEvents([]);
      }
    } catch (err) {
      const rate = detectRateLimit(err);
      if (rate) {
        applyRateLimit(rate.seconds);
        if (!silent) {
          setOrder(null);
          setStatusEvents([]);
        }
      } else if (!silent) {
        setError('Something went wrong. Please try again later.');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [applyRateLimit, clearRateLimit]);

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
     non-terminal result and NOT rate-limited. */
  useEffect(() => {
    const isTerminal = order?.status === ORDER_STATUS.DELIVERED || order?.status === ORDER_STATUS.CANCELLED;
    const tn = activeQueryRef.current;

    const tick = () => {
      if (
        document.visibilityState === 'visible' &&
        tn &&
        !isTerminal &&
        !isRateLimitedRef.current
      ) {
        fetchOrder(tn, { silent: true });
      }
    };

    // Clear any prior interval before (re)arming.
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (tn && !isTerminal && !isRateLimited) {
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
  }, [order?.status, fetchOrder, isRateLimited]);

  const handleSearch = (e) => {
    e.preventDefault();
    if (isRateLimitedRef.current) return;
    const tn = trackingNumber.trim().toUpperCase();
    // An empty search used to be refused by a disabled button, which never said
    // a tracking number was what it wanted. The "Shipment Not Found" card below
    // is a result, not a validation message, so this is reported at the field.
    if (!validate({ tracking_number: !tn ? 'Enter a tracking number to search.' : null })) return;
    activeQueryRef.current = tn;
    fetchOrder(tn);
  };

  const handleReset = () => {
    activeQueryRef.current = null;
    setTrackingNumber('');
    setOrder(null);
    setStatusEvents([]);
    setSearched(false);
    setLastRefreshed(null);
    // Rate-limit cooldown is request-volume based: clearing the form does NOT
    // lift it. Only the countdown (or a successful request after expiry) does.
    if (!isRateLimitedRef.current) {
      setError('');
    }
  };

  const StatusIcon = getStatusIcon(order?.status);
  const statusColor = order ? TRACKING_STATUS_TONES[order.status] : null;
  // timelineStatus, not order.status: 'Pending Cancellation' is a hold, not a
  // place on the route, so indexOf returns -1 and the bar renders a NEGATIVE
  // width. The cargo has not moved backwards because a request is under review.
  const completedSteps = order ? STATUS_TIMELINE.indexOf(timelineStatus(order)) : -1;
  const progressPct = order?.status === 'Cancelled' ? 0
    : order ? Math.max(0, Math.round(((completedSteps) / (STATUS_TIMELINE.length - 1)) * 100))
    : 0;

  // ETA: only meaningful before delivery. trip.arrival_date from the RPC.
  const estimatedDelivery = order?.estimated_delivery || null;
  const showEta = estimatedDelivery
    && order?.status !== ORDER_STATUS.DELIVERED
    && order?.status !== ORDER_STATUS.CANCELLED;

  const RootTag = embedded ? 'div' : 'main';

  return (
    <RootTag id="main-content" tabIndex={-1} className={`trk-page${embedded ? ' trk-page--embedded' : ''}`}>
      {!embedded && (
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
      )}

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
          <Link to="/login" className="trk-brand text-no-underline" aria-label="CargoExpress PH home">
            <BrandLockup size={36} />
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
            className={`trk-search-input ${invalidClass('tracking_number', errors)}`}
            placeholder="Enter tracking number (e.g. CE-20270101-0001)"
            value={trackingNumber}
            onChange={e => {
              setTrackingNumber(e.target.value.toUpperCase());
              clearError('tracking_number');
              // Typing may clear a normal "not found" error, but never lifts
              // an active rate-limit cooldown (that would defeat the purpose).
              if (!isRateLimitedRef.current && error && error !== RATE_LIMIT_USER_MSG) {
                setError('');
              }
            }}
            aria-label="Tracking number"
            autoComplete="off"
            spellCheck="false"
            aria-invalid={Boolean(errors.tracking_number) || Boolean(error && !isRateLimited)}
            aria-describedby={
              errors.tracking_number ? 'tracking_number-error'
              : isRateLimited ? 'trk-rate-limit-status'
              : undefined
            }
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
            disabled={loading || isRateLimited}
            aria-label={isRateLimited ? `Rate limited. Retry in ${retryAfterSeconds}s` : 'Track shipment'}
            aria-busy={loading}
          >
            {loading
              ? <Loader size={16} className="animate-spin" />
              : <><Search size={15} /> Track</>
            }
          </button>
        </div>
        <FieldError name="tracking_number" errors={errors} />
      </form>

      {/* ══════════ RATE LIMIT CARD ══════════
          Shown when limited and there is no result to keep on screen.
          Silent auto-refresh 429s keep the last good order and only pause polling. */}
      {isRateLimited && !loading && !order && (
        <div
          id="trk-rate-limit-status"
          className="trk-rate-limit-card animate-slide-up"
          role="alert"
          aria-live="assertive"
        >
          <div className="trk-rate-limit-icon" aria-hidden="true">
            <ShieldAlert size={32} />
          </div>
          <h3 className="trk-rate-limit-title">Rate Limit Exceeded</h3>
          <p className="trk-rate-limit-msg">
            You have made too many tracking requests in a short period to protect system security.
          </p>
          <div className="trk-countdown-badge">
            <Clock size={14} aria-hidden="true" />
            {' '}Retry available in {retryAfterSeconds}s
          </div>
        </div>
      )}

      {/* ══════════ ERROR STATE ══════════ */}
      {error && !isRateLimited && !loading && (
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

      {/* ══════════ LOADING ══════════
          Until now the result area stayed blank while the lookup was in flight,
          so the page appeared to do nothing after submit. This is a public page
          reached from a tracking link, often by someone who is not a user and
          is already anxious about a parcel — silence is the wrong answer. */}
      {loading && (
        <div className="trk-card animate-slide-up" aria-hidden="true">
          <CenteredSpinner />
        </div>
      )}
      {/* Screen readers get the status as text rather than a decorative shape. */}
      <div className="sr-only" role="status" aria-live="polite">
        {loading ? 'Looking up your shipment…' : ''}
      </div>

      {/* ══════════ RESULT CARD ══════════ */}
      {order && !loading && (
        <div className="trk-card animate-slide-up">

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
            <TrackingTimeline currentStatus={timelineStatus(order)} />
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
                    <Weight size={11} /> {order.actual_weight || '—'} kg
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
    </RootTag>
  );
};

export default TrackingPage;
