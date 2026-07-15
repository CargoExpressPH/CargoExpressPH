import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import { getOrders, getAnnouncements, getTrips } from '../../lib/database';
import StatusBadge from '../../components/ui/StatusBadge';
import { SkeletonOrderCard, SkeletonStatCard } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import PageTransition, { StaggerItem } from '../../components/ui/PageTransition';
import {
  Package, Search, Plus, ArrowRight,
  Container, MapPin, Calendar, Weight, ChevronRight,
  Truck, CheckCircle,
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

const HomePage = () => {
  usePageTitle('Home');
  const { user, userProfile } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [orders, setOrders]           = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [activeTrip, setActiveTrip]   = useState(null);  // nearest upcoming trip
  const [trackingSearch, setTrackingSearch] = useState('');
  const [loading, setLoading]         = useState(true);

  useEffect(() => { if (user) loadData(); }, [user]);

  const loadData = async () => {
    try {
      const [ordersData, annData, tripsData] = await Promise.all([
        getOrders(user.id, false, { limit: 50 }),
        getAnnouncements(),
        // Fetch scheduled + in_progress trips (both may still accept bookings)
        getTrips('active'),
      ]);
      setOrders(ordersData || []);
      setAnnouncements(annData || []);

      // Sort trips ascending by departure_date → pick the earliest upcoming one
      const upcoming = (tripsData || [])
        .filter(t => t.status === 'scheduled' || t.status === 'in_progress')
        .filter(t => t.departure_date && new Date(t.departure_date) > new Date(Date.now() - 86400000))
        .sort((a, b) => new Date(a.departure_date) - new Date(b.departure_date));

      setActiveTrip(upcoming[0] || null);
    } catch (err) {
      toast.error('Failed to load data. Please refresh the page or try again later.');
    } finally {
      setLoading(false);
    }
  };

  const activeOrders = orders.filter(o => !['Delivered', 'Cancelled'].includes(o.status));
  const deliveredOrders = orders.filter(o => o.status === 'Delivered');
  const visibleAnnouncements = announcements;

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good Morning';
    if (h < 18) return 'Good Afternoon';
    return 'Good Evening';
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Track shipment — navigates to tracking page with query
  const handleTrack = (e) => {
    e.preventDefault();
    const q = trackingSearch.trim();
    if (q) navigate(`/customer/track?q=${encodeURIComponent(q)}`);
  };

  // Book Cargo button click — pre-selects route + trip on BookShipmentPage
  const handleBookFromTrip = (trip) => {
    const routeLabel = trip.origin === 'Bohol' ? 'Bohol → Manila' : 'Manila → Bohol';
    navigate('/customer/book', {
      state: { preselectedRoute: routeLabel, preselectedTripId: trip.id },
    });
  };

  const availableSlots = activeTrip
    ? Math.max(0, (activeTrip.capacity || 0) - (activeTrip.current_weight || 0))
    : 0;

  return (
    <PageTransition className="customer-home-page">

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <div className="hero customer-home-hero animate-slide-up mb-lg">
        <p className="text-sm mb-4">{greeting()},</p>
        <h2>{userProfile?.name || (user?.email?.split('@')[0]) || 'Welcome'}</h2>
        <p className="mt-8">Track and manage your shipments with ease.</p>
        <form onSubmit={handleTrack} className="customer-track-form flex gap-10 mt-20 relative">
          <div className="search-box flex-1">
            <Search size={16} className="search-icon" />
            <input
              aria-label="Tracking number"
              placeholder="Enter tracking number (CE-XXXXXXXX)"
              value={trackingSearch}
              onChange={e => setTrackingSearch(e.target.value)}
              style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: 'white' }}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary flex-shrink-0"
            disabled={!trackingSearch.trim()}
            style={{ borderRadius: 10 }}
          >
            Track
          </button>
        </form>
      </div>

      {!loading && (
        <StaggerItem delay={30} className="customer-home-snapshot">
          <div className="customer-snapshot-pill">
            <div className="customer-snapshot-value">
              <Package size={16} /> {orders.length}
            </div>
            <div className="customer-snapshot-label">Total orders</div>
          </div>
          <div className="customer-snapshot-pill">
            <div className="customer-snapshot-value">
              <Truck size={16} /> {activeOrders.length}
            </div>
            <div className="customer-snapshot-label">Active now</div>
          </div>
          <div className="customer-snapshot-pill">
            <div className="customer-snapshot-value">
              <CheckCircle size={16} /> {deliveredOrders.length}
            </div>
            <div className="customer-snapshot-label">Delivered orders</div>
          </div>
        </StaggerItem>
      )}

      {/* ── Loading Skeleton ─────────────────────────────────────── */}
      {loading && (
        <div>
          <StaggerItem delay={0} className="mb-md">
            <SkeletonStatCard />
          </StaggerItem>
          {[0, 1, 2].map(i => (
            <StaggerItem key={i} delay={(i + 1) * 60} className="mb-12">
              <SkeletonOrderCard />
            </StaggerItem>
          ))}
        </div>
      )}

      {/* ── Nearest Active / Scheduled Trip Card ────────────────── */}
      {!loading && activeTrip && (
        <StaggerItem delay={0} className="mb-lg">
          <h3 className="customer-section-title fw-700 mb-12 flex items-center gap-8">
            <Truck size={18} color="var(--primary)" /> Next Available Trip
          </h3>
          <div className="customer-trip-card rounded-lg p-20 text-inverse" style={{
            background: 'linear-gradient(135deg, var(--accent), #2D5A8A)',
            boxShadow: '0 8px 24px rgba(27,58,92,0.25)',
          }}>
            {/* Trip badge */}
            <div className="flex items-center justify-between mb-md">
              <span className="text-xs fw-700" style={{
                background: 'var(--primary-glow)', color: 'var(--primary-light)',
                padding: '4px 10px',
                borderRadius: 20, border: '1px solid rgba(22, 163, 74, 0.35)',
                letterSpacing: '0.04em',
              }}>
                {activeTrip.status === 'in_progress' ? 'In Progress' : 'Scheduled'}
              </span>
              <span className="text-xs fw-600" style={{ opacity: 0.7 }}>
                {activeTrip.trip_number}
              </span>
            </div>

            {/* Route */}
            <div className="flex items-center gap-10 mb-md">
              <div className="w-40 h-40 rounded-full flex items-center justify-center flex-shrink-0" style={{
                background: 'var(--primary-glow)',
              }}>
                <MapPin size={20} color="var(--primary-light)" />
              </div>
              <div>
                <div className="text-xs mb-2" style={{ opacity: 0.6 }}>Route</div>
                <div className="fw-800" style={{ fontSize: '1.0625rem' }}>
                  {activeTrip.origin} → {activeTrip.destination}
                </div>
              </div>
            </div>

            {/* Dates + Capacity row */}
            <div className="mb-20" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div className="customer-trip-metric rounded-md" style={{ background: 'rgba(255,255,255,0.08)', padding: '10px 12px' }}>
                <div className="flex items-center gap-6 mb-4">
                  <Calendar size={13} opacity={0.7} />
                  <span className="fw-600 text-uppercase" style={{ fontSize: '0.65rem', opacity: 0.65 }}>Departure</span>
                </div>
                <div className="fw-700" style={{ fontSize: '0.8125rem' }}>{fmtDate(activeTrip.departure_date)}</div>
              </div>
              <div className="customer-trip-metric rounded-md" style={{ background: 'rgba(255,255,255,0.08)', padding: '10px 12px' }}>
                <div className="flex items-center gap-6 mb-4">
                  <Calendar size={13} opacity={0.7} />
                  <span className="fw-600 text-uppercase" style={{ fontSize: '0.65rem', opacity: 0.65 }}>ETA</span>
                </div>
                <div className="fw-700" style={{ fontSize: '0.8125rem' }}>{fmtDate(activeTrip.arrival_date)}</div>
              </div>
              <div className="customer-trip-metric rounded-md" style={{ background: 'rgba(255,255,255,0.08)', padding: '10px 12px' }}>
                <div className="flex items-center gap-6 mb-4">
                  <Weight size={13} opacity={0.7} />
                  <span className="fw-600 text-uppercase" style={{ fontSize: '0.65rem', opacity: 0.65 }}>Avail.</span>
                </div>
                <div className="fw-700" style={{ fontSize: '0.8125rem' }}>
                  {availableSlots > 0 ? `${availableSlots.toFixed(0)} kg` : 'Full'}
                </div>
              </div>
            </div>

            {/* Price per kilo badge */}
            {activeTrip.price_per_kg && (
              <div className="mb-12 fw-600" style={{
                fontSize: '0.8125rem', opacity: 0.8,
              }}>
                ₱{parseFloat(activeTrip.price_per_kg).toFixed(2)} / kg
              </div>
            )}

            {/* Book Cargo CTA */}
            <button
              type="button"
              onClick={() => handleBookFromTrip(activeTrip)}
              className="customer-trip-cta w-full border-none fw-700 cursor-pointer flex items-center justify-center gap-8 rounded-md"
              style={{
                padding: '13px',
                background: 'linear-gradient(135deg, var(--primary), var(--primary-light))',
                color: 'white', fontSize: '0.9375rem',
                boxShadow: '0 4px 16px var(--primary-glow)',
              }}
            >
              <Package size={18} /> Book Cargo for This Trip
              <ChevronRight size={16} />
            </button>
          </div>
        </StaggerItem>
      )}

      {/* ── Active Shipments ─────────────────────────────────────── */}
      {!loading && activeOrders.length > 0 && (
        <StaggerItem delay={60} className="mb-lg">
          <div className="flex items-center justify-between mb-md">
            <h3 className="customer-section-title fw-700">Active Shipments</h3>
            <Link to="/customer/orders" className="customer-inline-action text-sm text-primary font-medium">
              View All <ArrowRight size={14} />
            </Link>
          </div>
          {activeOrders.slice(0, 3).map((order, index) => (
            <StaggerItem key={order.id} delay={(index + 2) * 60} className="mb-12">
              <Link to={`/customer/orders/${order.id}`} className="customer-shipment-card card card-interactive block text-no-underline" style={{ color: 'inherit' }}>
                <div className="card-body p-16">
                  <div className="customer-list-card-top">
                    <span className="customer-list-card-title">{order.tracking_number}</span>
                    <div className="flex items-center gap-8">
                      <StatusBadge status={order.status} />
                      <ChevronRight size={18} className="customer-card-chevron" />
                    </div>
                  </div>
                  <div className="customer-list-card-route">
                    <MapPin size={14} />
                    <span>{order.origin || 'Not set'} to {order.destination || 'Not set'}</span>
                  </div>
                  <div className="customer-list-card-footer">
                    <span>To: {order.receiver_name || 'Receiver'}</span>
                    <span className="customer-list-card-price">PHP {parseFloat(order.shipping_cost || 0).toFixed(2)}</span>
                  </div>
                </div>
              </Link>
            </StaggerItem>
          ))}
        </StaggerItem>
      )}

      {/* ── Announcements ────────────────────────────────────────── */}
      {!loading && visibleAnnouncements.length > 0 && (
        <StaggerItem delay={120}>
          <h3 className="fw-700 mb-12">
            Announcements
          </h3>
          {visibleAnnouncements.slice(0, 3).map((a, index) => (
            <StaggerItem key={a.id} className="customer-announcement-card card mb-12" delay={(index + 4) * 60}>
              <div className="card-body p-16">
                <div className="fw-600 mb-4">{a.title}</div>
                <div className="text-sm text-secondary">{a.content}</div>
                <div className="text-xs text-tertiary mt-8">
                  {new Date(a.created_at).toLocaleDateString()}
                </div>
              </div>
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
  );
};

export default HomePage;
