import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import { getOrders, getAnnouncements, getTripCapacitySummary } from '../../lib/database';
import { isTripBookable } from '../../constants/status';
import StatusBadge from '../../components/ui/StatusBadge';
import RouteProgressLine from '../../components/ui/RouteProgressLine';
import { CenteredSpinner } from '../../components/ui/Loader';
import EmptyState from '../../components/ui/EmptyState';
import PageTransition, { StaggerItem } from '../../components/ui/PageTransition';
import PullToRefresh from '../../components/ui/PullToRefresh';
import {
  Package, Search, Plus, ArrowRight,
  Container, MapPin, Calendar, Weight, ChevronRight,
  Truck, CheckCircle, Zap, AlertTriangle, Bell, Megaphone, Clock,
  Sun, CloudSun, Moon, LayoutDashboard,
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { formatMoney } from '../../utils/currencyInput';
import { getAnnouncementCategoryInfo } from '../../lib/announcements';
import AnnouncementComments from '../../components/ui/AnnouncementComments';
import { formatPhDate } from '../../utils/datetime';
import { isOrderPriced } from '../../constants/status';
import { isScheduledTripOverdue } from '../../lib/tripCapacitySelection';
import useRealtimeTripCapacity from '../../hooks/useRealtimeTripCapacity';
import { orderPartyName } from '../../lib/orderParties';

const HomePage = () => {
  usePageTitle('Home');
  const { user, userProfile } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [orders, setOrders]           = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [activeTrip, setActiveTrip]   = useState(null);
  const [capacityLoading, setCapacityLoading] = useState(true);
  const [capacityError, setCapacityError] = useState(null);
  const [trackingSearch, setTrackingSearch] = useState('');
  const [loading, setLoading]         = useState(true);
  const homeLoadSequence = useRef(0);
  const capacityRequestSequence = useRef(0);
  const isMountedRef = useRef(false);
  const trackingInputRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    if (user) loadData();
    return () => {
      isMountedRef.current = false;
      homeLoadSequence.current += 1;
      capacityRequestSequence.current += 1;
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshCapacity = async () => {
    const request = ++capacityRequestSequence.current;
    try {
      const selectedTrip = await getTripCapacitySummary();
      if (!isMountedRef.current || request !== capacityRequestSequence.current) return null;
      setActiveTrip(selectedTrip);
      setCapacityError(null);
      return true;
    } catch (error) {
      if (!isMountedRef.current || request !== capacityRequestSequence.current) return null;
      setActiveTrip(null);
      setCapacityError(error?.message || 'Trip capacity could not be loaded.');
      return false;
    } finally {
      if (isMountedRef.current && request === capacityRequestSequence.current) setCapacityLoading(false);
    }
  };

  useRealtimeTripCapacity(refreshCapacity, Boolean(user?.id));

  const loadData = async () => {
    const request = ++homeLoadSequence.current;
    void refreshCapacity();
    try {
      const [ordersData, annData] = await Promise.all([
        getOrders(user.id, false, { limit: 50 }),
        getAnnouncements(),
      ]);
      if (isMountedRef.current && request === homeLoadSequence.current) {
        setOrders(ordersData || []);
        setAnnouncements(annData || []);
      }
    } catch (err) {
      if (isMountedRef.current && request === homeLoadSequence.current) {
        toast.error('Failed to load data. Please refresh the page or try again later.');
      }
    } finally {
      if (isMountedRef.current && request === homeLoadSequence.current) setLoading(false);
    }
  };

  const activeOrders = orders.filter(o => !['Delivered', 'Cancelled'].includes(o.status));
  const deliveredOrders = orders.filter(o => o.status === 'Delivered');

  const getGreetingData = () => {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return { text: 'Good Morning', icon: Sun, period: 'morning' };
    if (h >= 12 && h < 18) return { text: 'Good Afternoon', icon: CloudSun, period: 'afternoon' };
    if (h >= 18 && h < 22) return { text: 'Good Evening', icon: Moon, period: 'evening' };
    return { text: 'Good Evening', icon: Moon, period: 'night' };
  };

  // Pinned to Asia/Manila — an ETA stored as 6:00 PM PH time must not render as
  // the following day just because the viewer's machine is on another zone.
  const fmtDate = (iso) => formatPhDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });

  // Track shipment — navigates to tracking page with query
  const handleTrack = (e) => {
    e.preventDefault();
    const q = trackingSearch.trim();
    // The button stays enabled so it reads as a real action over the hero
    // photo; an empty submit just returns focus to the field.
    if (!q) {
      trackingInputRef.current?.focus();
      return;
    }
    navigate(`/customer/track?q=${encodeURIComponent(q)}`);
  };

  // Book Cargo button click — pre-selects route + trip on BookShipmentPage
  const handleBookFromTrip = (trip) => {
    const routeLabel = trip.origin === 'Bohol' ? 'Bohol → Manila' : 'Manila → Bohol';
    navigate('/customer/book', {
      state: { preselectedRoute: routeLabel, preselectedTripId: trip.id },
    });
  };

  const totalCapacity = Number(activeTrip?.capacity) || 0;
  const currentWeight = Number(activeTrip?.current_weight) || 0;
  const availableSlots = activeTrip ? Math.max(0, totalCapacity - currentWeight) : 0;
  const bookedPct = totalCapacity > 0 ? Math.min(100, Math.max(0, Math.round((currentWeight / totalCapacity) * 100))) : 0;
  const activeTripOverdue = isScheduledTripOverdue(activeTrip);
  const activeTripCanBook = isTripBookable(activeTrip);

  const greetingInfo = getGreetingData();
  const GreetingIcon = greetingInfo.icon;

  return (
    <PullToRefresh onRefresh={loadData}>
      <PageTransition className="customer-home-page">

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <div className={`hero customer-home-hero hero-${greetingInfo.period} animate-slide-up`}>
        <span className="text-sm">
          <GreetingIcon size={14} aria-hidden="true" />
          {greetingInfo.text},
        </span>
        <h1>{userProfile?.name || (user?.email?.split('@')[0]) || 'Welcome'}</h1>
        <p className="mt-8">Track and manage your shipments with ease.</p>
        {orders.length >= 50 && (
          <span className="text-xs text-tertiary">Showing your latest 50 bookings — older shipments live in Bookings.</span>
        )}
        <form onSubmit={handleTrack} className="customer-track-form flex gap-10 mt-20 relative">
          <div className="search-box flex-1">
            <Search size={16} className="search-icon" />
            <input
              ref={trackingInputRef}
              id="home-tracking-search"
              name="tracking_number"
              aria-label="Tracking number"
              placeholder="Enter tracking number (CE-YYYYMMDD-XXXX)"
              value={trackingSearch}
              onChange={e => setTrackingSearch(e.target.value)}
              className="hero-search-input"
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary flex-shrink-0"
            style={{ borderRadius: 10 }}
          >
            Track
          </button>
        </form>
      </div>

      {!loading && (
        <StaggerItem delay={30}>
          <h3 className="customer-section-title fw-700 mb-12 flex items-center gap-8">
            <LayoutDashboard size={18} color="var(--primary)" /> Overview
          </h3>
          <div className="customer-home-snapshot" style={{ marginTop: 0 }}>
            <div className="customer-snapshot-pill stat-total">
              <div className="customer-snapshot-icon-chip chip-purple">
                <Package size={16} />
              </div>
              <div className="customer-snapshot-info">
                <div className="customer-snapshot-value">{orders.length}</div>
                <div className="customer-snapshot-label">
                  <span className="customer-snapshot-label-full">Total Bookings</span>
                  <span className="customer-snapshot-label-short">Bookings</span>
                </div>
              </div>
            </div>

            <div className="customer-snapshot-pill stat-active">
              <div className="customer-snapshot-icon-chip chip-blue">
                <Truck size={16} />
              </div>
              <div className="customer-snapshot-info">
                <div className="customer-snapshot-value">{activeOrders.length}</div>
                <div className="customer-snapshot-label">Active now</div>
              </div>
            </div>

            <div className="customer-snapshot-pill stat-delivered">
              <div className="customer-snapshot-icon-chip chip-green">
                <CheckCircle size={16} />
              </div>
              <div className="customer-snapshot-info">
                <div className="customer-snapshot-value">{deliveredOrders.length}</div>
                <div className="customer-snapshot-label">Delivered</div>
              </div>
            </div>
          </div>
        </StaggerItem>
      )}

      {/* ── Loading State ─────────────────────────────────────── */}
      {loading && <CenteredSpinner />}

      {/* ── Earliest scheduled / ongoing trip capacity summary ───── */}
      {!loading && (capacityError ? (
        <StaggerItem delay={0}>
          <div className="card admin-section-card" role="alert" style={{ padding: 20 }}>
            <h3 className="fw-700 mb-8">Trip capacity unavailable</h3>
            <p className="text-sm text-secondary mb-12">{capacityError}</p>
            <button type="button" className="btn btn-outline btn-sm" onClick={refreshCapacity}>Retry</button>
          </div>
        </StaggerItem>
      ) : capacityLoading && !activeTrip ? (
        <CenteredSpinner />
      ) : activeTrip ? (
        <StaggerItem delay={0}>
          <h3 className="customer-section-title fw-700 mb-12 flex items-center gap-8">
            <Truck size={18} color="var(--primary)" />
            {activeTripOverdue ? 'Overdue Trip Capacity' : activeTrip.status === 'in_progress' ? 'Ongoing Trip Capacity' : activeTrip.status === 'arrived' ? 'Trip at Destination Hub' : 'Next Scheduled Trip Capacity'}
          </h3>
          {/* Same surface language as shipment / snapshot cards (theme-aware panel). */}
          <div className="home-hero-trip-card">
            {/* Trip badge */}
            <div className="flex items-center justify-between mb-md">
              <StatusBadge status={activeTrip.status} />
              <span className="home-trip-badge-num">
                {activeTrip.trip_number}
              </span>
            </div>

            {/* Route */}
            <div className="flex items-center gap-10 mb-md">
              <div className="home-trip-route-icon">
                <MapPin size={20} color="var(--customer-green, var(--primary))" />
              </div>
              <div>
                <div className="home-trip-route-label">Route</div>
                <div className="home-trip-route-title">
                  {activeTrip.origin} → {activeTrip.destination}
                </div>
              </div>
            </div>

            {/* Dates + Capacity row */}
            <div className="home-trip-metrics-grid">
              <div className="home-trip-metric-box">
                <div className="flex items-center gap-6 mb-4">
                  <Calendar size={13} opacity={0.7} />
                  <span className="home-trip-metric-lbl">Scheduled departure</span>
                </div>
                <div className="home-trip-metric-val">{fmtDate(activeTrip.departure_date)}</div>
              </div>
              <div className="home-trip-metric-box">
                <div className="flex items-center gap-6 mb-4">
                  <Clock size={13} opacity={0.7} />
                  <span className="home-trip-metric-lbl">Estimated delivery</span>
                </div>
                <div className="home-trip-metric-val">{fmtDate(activeTrip.arrival_date)}</div>
              </div>
              <div className="home-trip-metric-box">
                <div className="flex items-center gap-6 mb-4">
                  <Weight size={13} opacity={0.7} />
                  <span className="home-trip-metric-lbl">{activeTripCanBook ? 'Available space' : 'Remaining physical space'}</span>
                </div>
                <div className="home-trip-metric-val font-bold text-success">
                  {availableSlots > 0 ? `${Math.round(availableSlots).toLocaleString()} kg` : 'Full'}
                </div>
              </div>
            </div>

            {activeTripOverdue && (
              <div className="alert-banner alert-banner-warning mb-12" role="status">
                Overdue — Reschedule Required. This trip can’t accept new bookings until it is rescheduled.
              </div>
            )}
            {activeTrip.status === 'in_progress' && (
              <div className="text-xs text-secondary mb-12" role="status">
                This is the ongoing trip. Remaining space does not mean new bookings are open.
              </div>
            )}
            {activeTrip.status === 'arrived' && (
              <div className="text-xs text-secondary mb-12" role="status">
                This trip has arrived at the destination hub and is awaiting completion. New bookings are closed.
              </div>
            )}

            {/* Live Capacity Progress Strip */}
            {totalCapacity > 0 && (
              <div className="home-trip-capacity-strip mb-16">
                <div className="flex items-center justify-between text-xs mb-6">
                  <span className="home-trip-capacity-lbl font-semibold">
                    Trip Load ({bookedPct}% booked)
                  </span>
                  <span className="home-trip-capacity-pct font-bold" style={{ color: availableSlots > 0 ? '#10b981' : '#ef4444' }}>
                    {availableSlots > 0
                      ? `${Math.round(availableSlots).toLocaleString()} kg ${activeTripCanBook ? 'Available' : 'Remaining'}`
                      : 'Fully Booked'}
                  </span>
                </div>
                <div className="home-trip-progress-track">
                  <div
                    className="home-trip-progress-bar"
                    style={{ width: `${bookedPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Price per kilo badge */}
            {activeTripCanBook && activeTrip.price_per_kg && (
              <div className="home-trip-price">
                {formatMoney(parseFloat(activeTrip.price_per_kg))} / kg
              </div>
            )}

            {/* Book Cargo CTA */}
            {activeTripCanBook && (
              <button
                type="button"
                onClick={() => handleBookFromTrip(activeTrip)}
                className="home-trip-cta"
              >
                <Package size={18} /> Book Cargo for This Trip
                <ChevronRight size={16} />
              </button>
            )}
          </div>
        </StaggerItem>
      ) : (
        <StaggerItem delay={0}>
          <EmptyState
            icon={Truck}
            title="No scheduled or ongoing trip available."
            description="A trip summary will appear here when a trip is scheduled or underway."
          />
        </StaggerItem>
      ))}

      {/* ── Announcements ────────────────────────────────────────── */}
      {!loading && announcements.length > 0 && (
        <StaggerItem delay={60}>
          <div className="flex items-center justify-between mb-md">
            <h3 className="customer-section-title fw-700">Announcements</h3>
            <span className="text-xs text-tertiary fw-600">{Math.min(announcements.length, 5)} Latest</span>
          </div>
          {announcements.slice(0, 5).map((a, index) => {
            const cat = getAnnouncementCategoryInfo(a);
            const CatIcon = cat.icon;
            return (
              <StaggerItem key={a.id} className="mb-12" delay={(index + 2) * 60}>
                <div
                  className="card customer-announcement-card"
                  style={{
                    transition: 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease',
                  }}
                >
                  <div className="card-body p-16">
                    <div className="flex items-center justify-between gap-8 mb-8">
                      <span
                        className="inline-flex items-center gap-6 px-8 py-2 rounded-full fw-700 text-uppercase"
                        style={{
                          fontSize: 'var(--text-12)',
                          letterSpacing: '0.04em',
                          background: cat.badgeBg,
                          color: cat.badgeColor,
                        }}
                      >
                        <CatIcon size={12} />
                        {cat.label}
                      </span>
                      <span className="inline-flex items-center gap-4 text-xs text-tertiary">
                        <Clock size={12} />
                        {new Date(a.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                    <div className="fw-700 text-base mb-6" style={{ color: 'var(--text)', lineHeight: 1.35 }}>
                      {a.title}
                    </div>
                    <div className="text-sm text-secondary" style={{ lineHeight: 1.5 }}>
                      {a.content}
                    </div>
                    <AnnouncementComments
                      announcementId={a.id}
                      comments={a.comments}
                      onCommentsChange={comments => setAnnouncements(prev =>
                        prev.map(item => (item.id === a.id ? { ...item, comments } : item))
                      )}
                    />
                  </div>
                </div>
              </StaggerItem>
            );
          })}
        </StaggerItem>
      )}

      {/* ── Active Shipments ─────────────────────────────────────── */}
      {!loading && activeOrders.length > 0 && (
        <StaggerItem delay={120}>
          <div className="flex items-center justify-between mb-md">
            <h3 className="customer-section-title fw-700">Active Shipments</h3>
            <Link to="/customer/orders" className="customer-inline-action text-sm text-primary font-medium">
              View All <ArrowRight size={14} />
            </Link>
          </div>
          {activeOrders.slice(0, 3).map((order, index) => (
            <StaggerItem key={order.id} delay={(index + 4) * 60} className="mb-12">
              <Link to={`/customer/orders/${order.id}`} className="customer-shipment-card customer-shipment-card-v2 card card-interactive block text-no-underline" style={{ color: 'inherit' }}>
                <div className="card-body p-16">
                  <div className="customer-list-card-top customer-list-card-top--status">
                    <div className="customer-list-card-status-row">
                      <StatusBadge status={order.status} />
                      <ChevronRight size={18} className="customer-card-chevron" aria-hidden="true" />
                    </div>
                    <div className="flex flex-col min-width-0">
                      <span className="customer-list-card-title flex items-center gap-6"><Package size={14} className="text-tertiary" aria-hidden="true" />{order.tracking_number}</span>
                      <span className="customer-list-card-booked-date">Booked: {fmtDate(order.created_at)}</span>
                    </div>
                  </div>
                  <div className="customer-list-card-route-visual">
                    <span className="customer-route-node origin inline-flex items-center gap-4"><Container size={14} className="text-tertiary" aria-hidden="true" />{order.origin || 'Not set'}</span>
                    <RouteProgressLine status={order.status} />
                    <span className="customer-route-node destination inline-flex items-center gap-4"><MapPin size={14} className="text-tertiary" aria-hidden="true" />{order.destination || 'Not set'}</span>
                  </div>
                  <div className="customer-list-card-footer flex items-center justify-between gap-8 flex-wrap">
                    <span className="inline-flex items-center gap-6 text-sm">To: {orderPartyName(order, 'receiver') || 'Receiver'}</span>
                    <span className="flex items-center gap-6">
                      {order.actual_weight && <span className="chip chip-info inline-flex items-center gap-4"><Weight size={12} aria-hidden="true" />{order.actual_weight}kg</span>}
                      <span className="chip chip-success">{isOrderPriced(order) ? formatMoney(parseFloat(order.shipping_cost || 0)) : 'Priced at pickup'}</span>
                    </span>
                  </div>
                </div>
              </Link>
            </StaggerItem>
          ))}
        </StaggerItem>
      )}

      {!loading && orders.length === 0 && !activeTrip && (
        <StaggerItem delay={60}>
          <EmptyState
            icon={Container}
            title="No Shipments Yet"
            description="Start by booking your first shipment! We'll handle the rest."
            actionLabel="Book Shipment"
            onAction={() => navigate('/customer/book')}
          />
        </StaggerItem>
      )}
    </PageTransition>
    </PullToRefresh>
  );
};

export default HomePage;
