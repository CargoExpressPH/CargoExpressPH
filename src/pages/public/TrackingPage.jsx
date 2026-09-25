import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getPublicOrderEvents, getPublicTrackingResult } from '../../lib/database';
import { buildStatusTimestamps } from '../../utils/statusTimestamps';
import { formatPhDate, formatPhDateTime } from '../../utils/datetime';
import {
  Search, Loader, Package, MapPin, Check, MessageCircle,
  CheckCircle2, XCircle, Clock, Weight, User,
  RefreshCw, AlertTriangle, ShieldAlert, Truck, Calendar, Info, ClipboardCheck, Building2, Bike,
} from 'lucide-react';
import {
  STATUS_TIMELINE, TRACKING_STATUS_TONES, STATUS_ICONS, STATUS_DESCRIPTIONS, ORDER_STATUS, timelineStatus,
} from '../../constants/status';
import { CenteredSpinner } from '../../components/ui/Loader';
import usePageTitle from '../../hooks/usePageTitle';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { invalidClass } from '../../components/ui/FieldError';
import BrandLockup from '../../components/ui/BrandLogo';
import { useDashboardPath } from '../../hooks/useDashboardPath';

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
// "Sep 25, 10:58 AM" — journey steps and trip times, where the year is noise.
const formatStepTime = (iso) => (iso ? formatPhDateTime(iso, { year: undefined, hour: 'numeric' }) : null);

/* Auto-refresh cadence while the result is visible and the tab is focused.
   45s — frequent enough to feel "live", gentle on the anon RPC. */
const REFRESH_INTERVAL_MS = 45000;
const DEFAULT_RETRY_AFTER_SEC = 30;
const TRACKING_ERROR_COPY = {
  not_found: {
    title: 'Shipment Not Found',
    message: 'No shipment found with this tracking number. Please double-check and try again.',
    action: 'Try Another',
  },
  network: {
    title: 'Unable to Check Tracking',
    message: 'We could not connect to the tracking service. Check your internet connection and try again.',
    action: 'Try Again',
  },
  unavailable: {
    title: 'Tracking Temporarily Unavailable',
    message: 'The tracking service is temporarily unavailable. Please try again in a moment.',
    action: 'Try Again',
  },
};

const getTrackingErrorType = (err) => {
  if (!err) return 'unavailable';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'network';

  const message = [err.message, err.details, err.hint, err.code, err.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /network offline|failed to fetch|fetch failed|networkerror|load failed|connection (?:failed|reset|refused)|econn|enotfound|eai_again|etimedout|socket|timeout|timed out|aborted/.test(message)
    ? 'network'
    : 'unavailable';
};

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
  const dashboardPath = useDashboardPath();
  const [searchParams] = useSearchParams();
  const [trackingNumber, setTrackingNumber] = useState(searchParams.get('q') || '');
  const [order,   setOrder]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorKind, setErrorKind] = useState(null);
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

  const setTrackingError = useCallback((kind) => {
    setErrorKind(kind);
  }, []);

  // timelineStatus, not order.status: 'Pending Cancellation' is a hold, not a
  // place on the route, so the journey keeps the step the cargo actually
  // reached while a cancellation request is under review.
  const journeyStatus = order ? timelineStatus(order) : undefined;
  const stepTimestamps = useMemo(
    () => buildStatusTimestamps(statusEvents, order?.created_at, journeyStatus),
    [statusEvents, order?.created_at, journeyStatus]
  );

  const applyRateLimit = useCallback((seconds = DEFAULT_RETRY_AFTER_SEC) => {
    isRateLimitedRef.current = true;
    setIsRateLimited(true);
    setRetryAfterSeconds(seconds);
    setErrorKind('rate_limit');
  }, []);

  const clearRateLimit = useCallback(() => {
    isRateLimitedRef.current = false;
    setIsRateLimited(false);
    setRetryAfterSeconds(0);
    setErrorKind(prev => (prev === 'rate_limit' ? null : prev));
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
        setErrorKind('rate_limit');
      }
      return;
    }

    if (!silent) {
      setLoading(true);
      setTrackingError(null);
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
          setTrackingError(getTrackingErrorType(fetchError));
        }
        return;
      }
      if (!data) {
        if (!silent) {
          setTrackingError('not_found');
        }
        return;
      }
      // Successful lookup ends any prior cooldown.
      if (isRateLimitedRef.current) clearRateLimit();
      setTrackingError(null);
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
        setTrackingError(getTrackingErrorType(err));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [applyRateLimit, clearRateLimit, setTrackingError]);

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

  const handleRetry = () => {
    const tn = activeQueryRef.current || trackingNumber.trim().toUpperCase();
    if (!tn || isRateLimitedRef.current) return;
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
      setTrackingError(null);
    }
  };

  const StatusIcon = getStatusIcon(order?.status);
  const statusColor = order ? TRACKING_STATUS_TONES[order.status] : null;
  // One tone per status, used by the hero, the route truck and the current
  // journey step, so the whole card tells the same story in the same colour.
  const toneStyle = statusColor ? {
    '--trk-tone': statusColor.text,
    '--trk-tone-bg': statusColor.bg,
    '--trk-tone-border': statusColor.border,
    '--trk-tone-icon-bg': statusColor.iconBg,
  } : undefined;
  const isCancelled = order?.status === ORDER_STATUS.CANCELLED;
  const isDelivered = order?.status === ORDER_STATUS.DELIVERED;
  const currentStep = STATUS_TIMELINE.indexOf(journeyStatus);

  // The one date the visitor came for, shown in the hero.
  const keyDate = !order || isCancelled ? null
    : isDelivered
      ? { label: 'Delivered', value: formatDate(stepTimestamps[ORDER_STATUS.DELIVERED] || order.updated_at, true) }
      : order.estimated_delivery
        ? { label: 'Estimated delivery', value: formatDate(order.estimated_delivery) }
        : null;

  // Route: where the trip is between the two hubs. Status is the fallback for
  // trips that predate the departure/arrival timestamps.
  const departed = Boolean(order?.trip_departure_at)
    || currentStep >= STATUS_TIMELINE.indexOf(ORDER_STATUS.IN_TRANSIT);
  const arrived = Boolean(order?.trip_arrived_at)
    || currentStep >= STATUS_TIMELINE.indexOf(ORDER_STATUS.ARRIVED_HUB);
  const routeStage = arrived ? 'arrived' : departed ? 'moving' : 'waiting';
  // { label, time } — shown on two lines so a date never breaks mid-way.
  const originWhen = order?.trip_departure_at ? { label: 'Departed', time: formatStepTime(order.trip_departure_at) }
    : departed ? { label: 'Departed', time: null }
    : order?.trip_departure_date ? { label: 'Departs', time: formatDate(order.trip_departure_date) }
    : { label: 'Departure date to be set', time: null };
  const destinationWhen = order?.trip_arrived_at ? { label: 'Arrived', time: formatStepTime(order.trip_arrived_at) }
    : arrived ? { label: 'Arrived', time: null }
    : order?.trip_estimated_arrival_at ? { label: 'Expected', time: formatStepTime(order.trip_estimated_arrival_at) }
    : { label: 'Arrival to be confirmed', time: null };

  // A cancelled order lists only the steps it really reached, then the
  // cancellation itself; every other order shows the full route ahead.
  const journeySteps = !order ? []
    : isCancelled
      ? [
        ...STATUS_TIMELINE.filter(status => stepTimestamps[status]).map(status => ({ status, state: 'done' })),
        { status: ORDER_STATUS.CANCELLED, state: 'cancelled' },
      ]
      : STATUS_TIMELINE.map((status, index) => ({
        status,
        state: index < currentStep ? 'done' : index === currentStep ? 'current' : 'upcoming',
      }));
  const journeyTime = (status) => (
    status === ORDER_STATUS.CANCELLED
      ? formatStepTime(stepTimestamps[ORDER_STATUS.CANCELLED] || order?.updated_at)
      : formatStepTime(stepTimestamps[status])
  );

  const supportPath = dashboardPath === '/customer' ? '/customer/support' : '/about#contact';
  const RootTag = embedded ? 'div' : 'main';
  const errorCopy = errorKind ? TRACKING_ERROR_COPY[errorKind] : null;
  const LookupErrorIcon = errorKind === 'not_found' ? XCircle : AlertTriangle;

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
          <Link to="/" className="trk-brand text-no-underline" aria-label="CargoExpress PH home">
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
            placeholder="Enter tracking number"
            value={trackingNumber}
            onChange={e => {
              setTrackingNumber(e.target.value.toUpperCase());
              clearError('tracking_number');
              // Typing may clear a normal lookup error, but never lifts
              // an active rate-limit cooldown (that would defeat the purpose).
              if (!isRateLimitedRef.current && errorKind) {
                setTrackingError(null);
              }
            }}
            aria-label="Tracking number"
            autoComplete="off"
            spellCheck="false"
            aria-invalid={Boolean(errors.tracking_number) || errorKind === 'not_found'}
            aria-describedby={
              errors.tracking_number ? 'tracking_number-error'
              : isRateLimited ? 'trk-rate-limit-status'
              : errorKind === 'not_found' ? 'trk-lookup-error'
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
      {errorCopy && !isRateLimited && !loading && (
        <div
          id="trk-lookup-error"
          className={`trk-not-found trk-lookup-error--${errorKind} animate-slide-up`}
          role="alert"
        >
          <div className="trk-not-found-icon" aria-hidden="true">
            <LookupErrorIcon size={28} />
          </div>
          <h3 className="trk-not-found-title">{errorCopy.title}</h3>
          <p className="trk-not-found-msg">{errorCopy.message}</p>
          {errorKind === 'not_found' && (
            <ul className="trk-not-found-tips">
              <li><Check size={14} aria-hidden="true" /><span>Check every character, including the dashes: <strong>CE-YYYYMMDD-XXXX</strong></span></li>
              <li><Check size={14} aria-hidden="true" /><span>Copy the number straight from your booking confirmation</span></li>
            </ul>
          )}
          <div className="trk-not-found-actions">
            <button
              type="button"
              className="trk-retry-btn"
              onClick={errorKind === 'not_found' ? handleReset : handleRetry}
            >
              <RefreshCw size={14} /> {errorCopy.action}
            </button>
            <Link to={supportPath} className="trk-contact-btn">
              <MessageCircle size={14} aria-hidden="true" /> Contact us
            </Link>
          </div>
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
        <div className="trk-card trk-result animate-slide-up" style={toneStyle}>

          {/* ── Hero: status, plain-language meaning, the date that matters ── */}
          <section className="trk-hero" aria-labelledby="trk-hero-status">
            <div className="trk-hero-top">
              <div className="trk-hero-status">
                <div className="trk-hero-icon" aria-hidden="true">
                  <StatusIcon size={24} />
                </div>
                <div className="trk-hero-status-text">
                  <p className="trk-eyebrow">Current status</p>
                  <p id="trk-hero-status" className="trk-hero-status-value">{order.status}</p>
                </div>
              </div>
              <div className="trk-hero-number">
                <p className="trk-eyebrow">Tracking No.</p>
                <p className="trk-hero-number-value">{order.tracking_number}</p>
              </div>
            </div>
            {STATUS_DESCRIPTIONS[order.status] && (
              <p className="trk-hero-message">{STATUS_DESCRIPTIONS[order.status]}</p>
            )}
            {keyDate && (
              <div className="trk-hero-date">
                <Calendar size={18} aria-hidden="true" />
                <span className="trk-hero-date-label">{keyDate.label}</span>
                <span className="trk-hero-date-value">{keyDate.value}</span>
              </div>
            )}
          </section>

          <div className="trk-result-body">
            {/* ── Route: origin hub → destination hub ── */}
            {!isCancelled && (
              <section className="trk-section trk-route" aria-labelledby="trk-route-title">
                <p id="trk-route-title" className="trk-section-label">Trip</p>
                {/* One continuous rail from hub to hub, the truck riding on it. */}
                <div className={`trk-route-rail trk-route-rail--${routeStage}`} aria-hidden="true">
                  <span className={`trk-route-dot${departed ? ' is-reached' : ''}`} />
                  <span className="trk-route-line">
                    <span className="trk-route-line-fill" />
                    <span className="trk-route-truck"><Truck size={16} /></span>
                  </span>
                  <span className={`trk-route-dot${arrived ? ' is-reached' : ''}`} />
                </div>
                <div className="trk-route-stops">
                  {[
                    [order.origin || 'Origin', originWhen, ''],
                    [order.destination || 'Destination', destinationWhen, ' trk-route-stop--end'],
                  ].map(([city, when, modifier]) => (
                    <div key={modifier || 'start'} className={`trk-route-stop${modifier}`}>
                      <p className="trk-route-city">{city}</p>
                      <p className="trk-route-when">{when.label}</p>
                      {when.time && <p className="trk-route-time">{when.time}</p>}
                    </div>
                  ))}
                </div>
                <p className="trk-route-note">Times are Philippine time (Manila).</p>
              </section>
            )}

            {/* ── Journey: every step, with the date it was reached ── */}
            <section className="trk-section trk-journey" aria-labelledby="trk-journey-title">
              <p id="trk-journey-title" className="trk-section-label">Shipment journey</p>
              <ol className="trk-journey-list">
                {journeySteps.map(({ status, state }) => {
                  const StepIcon = state === 'cancelled' ? XCircle : getStatusIcon(status);
                  const time = state === 'upcoming' ? null : journeyTime(status);
                  return (
                    <li
                      key={status}
                      className={`trk-journey-step is-${state}`}
                      aria-current={state === 'current' ? 'step' : undefined}
                    >
                      <span className="trk-journey-node" aria-hidden="true">
                        {state === 'done' ? <Check size={14} strokeWidth={3} /> : <StepIcon size={14} />}
                      </span>
                      <div className="trk-journey-text">
                        <span className="trk-journey-label">{status}</span>
                        {time && <span className="trk-journey-time">{time}</span>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>

            {/* ── Details ── */}
            <section className="trk-section trk-details" aria-labelledby="trk-details-title">
              <p id="trk-details-title" className="trk-section-label">Shipment details</p>
              <div className="trk-details-grid">
                <div className="trk-detail">
                  <div className="trk-detail-icon" aria-hidden="true"><User size={15} /></div>
                  <div className="trk-detail-text">
                    <p className="trk-detail-label">From</p>
                    <p className="trk-detail-value">{order.sender_name || '—'}</p>
                    <p className="trk-detail-meta"><MapPin size={12} aria-hidden="true" /> {order.origin || '—'}</p>
                  </div>
                </div>
                <div className="trk-detail">
                  <div className="trk-detail-icon" aria-hidden="true"><User size={15} /></div>
                  <div className="trk-detail-text">
                    <p className="trk-detail-label">To</p>
                    <p className="trk-detail-value">{order.receiver_name || '—'}</p>
                    <p className="trk-detail-meta"><MapPin size={12} aria-hidden="true" /> {order.destination || '—'}</p>
                  </div>
                </div>
                <div className="trk-detail trk-detail--wide">
                  <div className="trk-detail-icon" aria-hidden="true"><Package size={15} /></div>
                  <div className="trk-detail-text">
                    <p className="trk-detail-label">Package</p>
                    <p className="trk-detail-value">{order.package_description || 'No description'}</p>
                    {/* A booking has no weight until it is put on the scale at
                        pickup — say so instead of showing "— kg". */}
                    <p className="trk-detail-meta">
                      <Weight size={12} aria-hidden="true" />
                      {order.actual_weight ? `${order.actual_weight} kg` : isCancelled ? 'Not weighed' : 'Weighed at pickup'}
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* ── Footer timestamps ── */}
          <div className="trk-card-footer">
            <span className="trk-timestamp">
              <Clock size={11} />
              Booked {formatDate(order.created_at)}
            </span>
            <span className="trk-timestamp trk-timestamp-live" title={lastRefreshed ? `Auto-refreshed ${formatDate(lastRefreshed.toISOString(), true)}` : undefined}>
              <RefreshCw size={11} />
              {isDelivered || isCancelled
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
        {dashboardPath ? (
          <p><Link to={dashboardPath} className="trk-footer-link">Go to Dashboard</Link></p>
        ) : (
          <p>Have an account? <Link to="/login" className="trk-footer-link">Sign In</Link></p>
        )}
        <p className="trk-footer-copy">© {new Date().getFullYear()} CargoExpress PH</p>
      </footer>
      )}
    </RootTag>
  );
};

export default TrackingPage;
