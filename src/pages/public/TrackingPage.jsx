import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { getActivityLogsByRecord } from '../../lib/database';
import { deriveStatusTimestamps } from '../../utils/statusTimestamps';
import {
  Container, Search, Loader, Package, MapPin, ArrowRight,
  CheckCircle2, XCircle, Clock, Weight, User, Coins,
  RefreshCw, AlertTriangle, Truck, Calendar, Info,
} from 'lucide-react';
import { STATUS_TIMELINE, STATUS_COLORS } from '../../constants/status';
import TrackingTimeline from '../../components/ui/TrackingTimeline';
import usePageTitle from '../../hooks/usePageTitle';

const TRACKING_STATUS_TONES = {
  Pending: {
    bg: 'var(--trk-status-warning-bg)',
    text: 'var(--trk-status-warning-text)',
    border: 'var(--trk-status-warning-border)',
    iconBg: 'var(--trk-status-warning-icon-bg)',
  },
  Assigned: {
    bg: 'var(--trk-status-info-bg)',
    text: 'var(--trk-status-info-text)',
    border: 'var(--trk-status-info-border)',
    iconBg: 'var(--trk-status-info-icon-bg)',
  },
  'Picked Up': {
    bg: 'var(--trk-status-success-bg)',
    text: 'var(--trk-status-success-text)',
    border: 'var(--trk-status-success-border)',
    iconBg: 'var(--trk-status-success-icon-bg)',
  },
  'In Transit': {
    bg: 'var(--trk-status-info-bg)',
    text: 'var(--trk-status-info-text)',
    border: 'var(--trk-status-info-border)',
    iconBg: 'var(--trk-status-info-icon-bg)',
  },
  'Arrived at Hub': {
    bg: 'var(--trk-status-success-bg)',
    text: 'var(--trk-status-success-text)',
    border: 'var(--trk-status-success-border)',
    iconBg: 'var(--trk-status-success-icon-bg)',
  },
  'Out for Delivery': {
    bg: 'var(--trk-status-purple-bg)',
    text: 'var(--trk-status-purple-text)',
    border: 'var(--trk-status-purple-border)',
    iconBg: 'var(--trk-status-purple-icon-bg)',
  },
  Delivered: {
    bg: 'var(--trk-status-success-bg)',
    text: 'var(--trk-status-success-text)',
    border: 'var(--trk-status-success-border)',
    iconBg: 'var(--trk-status-success-icon-bg)',
  },
  Cancelled: {
    bg: 'var(--trk-status-error-bg)',
    text: 'var(--trk-status-error-text)',
    border: 'var(--trk-status-error-border)',
    iconBg: 'var(--trk-status-error-icon-bg)',
  },
};

/* ── Status display helpers ────────────────────────────────────────── */
const getStatusIcon = (status) => {
  if (status === 'Delivered')  return CheckCircle2;
  if (status === 'Cancelled')  return XCircle;
  if (status === 'In Transit') return Truck;
  return Package;
};

const formatDate = (iso, withTime = false) => {
  if (!iso) return '—';
  const opts = { year: 'numeric', month: 'short', day: 'numeric' };
  if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
  return new Date(iso).toLocaleDateString('en-PH', opts);
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
  const [activityLogs, setActivityLogs] = useState([]);

  const stepTimestamps = useMemo(
    () => deriveStatusTimestamps(activityLogs, order?.created_at, order?.status),
    [activityLogs, order?.created_at, order?.status]
  );

  useEffect(() => {
    const q = searchParams.get('q');
    if (q?.trim()) {
      const tn = q.trim().toUpperCase();
      setTrackingNumber(tn);
      doSearch(tn);
    }
  }, []);

  const doSearch = async (tn) => {
    setLoading(true); setError(''); setOrder(null); setSearched(true); setActivityLogs([]);
    try {
      const { data, error: fetchError } = await supabase
        .rpc('track_order_public', { p_tracking_number: tn })
        .maybeSingle();
      if (fetchError || !data) {
        setError('No shipment found with this tracking number. Please double-check and try again.');
      } else {
        setOrder(data);
        if (data?.id) {
          try {
            const logs = await getActivityLogsByRecord(data.id);
            setActivityLogs(logs || []);
          } catch {
            // Non-admin public query fallback handled by deriveStatusTimestamps baseline
          }
        }
      }
    } catch {
      setError('Something went wrong. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    if (!trackingNumber.trim()) return;
    doSearch(trackingNumber.trim().toUpperCase());
  };

  const handleReset = () => {
    setTrackingNumber('');
    setOrder(null);
    setError('');
    setSearched(false);
  };

  const StatusIcon = getStatusIcon(order?.status);
  const statusColor = order ? (TRACKING_STATUS_TONES[order.status] || STATUS_COLORS[order.status]) : null;
  const completedSteps = order ? STATUS_TIMELINE.indexOf(order.status) : -1;
  const progressPct = order?.status === 'Cancelled' ? 0
    : order ? Math.round(((completedSteps) / (STATUS_TIMELINE.length - 1)) * 100)
    : 0;

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
        <p className="trk-subheadline">Real-time updates — know exactly where your package is</p>
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
            <span className="trk-timestamp">
              Last updated {formatDate(order.updated_at, true)}
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
