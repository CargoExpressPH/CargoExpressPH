import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { 
  createContactInquiry, 
  getCompanyInformation,
  getCoverageAreas,
  getPublicFeedback,
  getFeaturedDeliveries
} from '../../lib/database';
import { resolvePhotoUrls } from '../../lib/storage';
import { getFeatureIcon } from '../../lib/featureIcons';
import {
  ArrowUp, Phone, MapPin, Globe, Loader, Send,
  Mail, Clock, Calendar, CheckCircle2,
  Navigation, Award, ChevronRight, ChevronDown, ChevronLeft, X, Play, Building2, TrendingUp, Users, MessageSquare,
  Star, Package, Search, Sparkles, Image
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import FocusTrap from '../../components/ui/FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { fieldAttrs, invalidClass } from '../../components/ui/FieldError';
import { motion, useScroll, useTransform, AnimatePresence, MotionConfig } from 'framer-motion';
import { BrandLogo, BrandWordmark } from '../../components/ui/BrandLogo';
import L from 'leaflet';
import {
  AttributionControl,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  ZoomControl,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
  PHILIPPINES_MAP_BOUNDS,
  PHILIPPINES_MAP_CENTER,
  PHILIPPINES_MAP_REGIONS,
  PHILIPPINES_MAP_ZOOM,
} from '../../constants/phMapCoordinates';

const getGoogleMapsSearchUrl = (address) => (
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address?.trim() || '')}`
);

// ─── Lightbox Component (with prev/next navigation) ───
const Lightbox = ({ images, currentIndex, onClose, onNavigate }) => {
  // Shared hook: ref-counted and iOS-safe. The previous inline version reset
  // body overflow to 'unset' rather than restoring the prior value.
  useScrollLock(currentIndex >= 0);

  useEffect(() => {
    if (currentIndex < 0) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onNavigate(-1);
      if (e.key === 'ArrowRight') onNavigate(1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentIndex, onClose, onNavigate]);

  if (currentIndex < 0 || !images?.length) return null;
  const image = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;

  return (
    <FocusTrap active={currentIndex >= 0}>
      <div className="about-lightbox-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Image gallery lightbox">
        <button className="about-lightbox-close" onClick={onClose} aria-label="Close lightbox">
          <X size={24} />
        </button>

        {hasPrev && (
          <button 
            className="about-lightbox-nav prev" 
            onClick={(e) => { e.stopPropagation(); onNavigate(-1); }}
            aria-label="Previous image"
          >
            <ChevronLeft size={28} />
          </button>
        )}

        {hasNext && (
          <button 
            className="about-lightbox-nav next" 
            onClick={(e) => { e.stopPropagation(); onNavigate(1); }}
            aria-label="Next image"
          >
            <ChevronRight size={28} />
          </button>
        )}

        <img 
          src={image.image_url} 
          alt={image.title || 'Delivery photo'} 
          className="about-lightbox-img"
          onClick={(e) => e.stopPropagation()}
        />
        {(image.title || image.description) && (
          <div className="about-lightbox-info" onClick={(e) => e.stopPropagation()}>
            {image.title && <div className="about-lightbox-info-title">{image.title}</div>}
            {image.description && <div className="about-lightbox-info-desc">{image.description}</div>}
            {images.length > 1 && (
              <div className="about-lightbox-info-counter">
                {currentIndex + 1} / {images.length}
              </div>
            )}
          </div>
        )}
      </div>
    </FocusTrap>
  );
};

// ─── Interactive Map Component ───
const DEFAULT_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_MAP_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CONFIGURED_MAP_TILE_URL = import.meta.env.VITE_MAP_TILE_URL?.trim();
const MAP_TILE_URL = CONFIGURED_MAP_TILE_URL || DEFAULT_MAP_TILE_URL;
const MAP_TILE_ATTRIBUTION = CONFIGURED_MAP_TILE_URL
  ? (import.meta.env.VITE_MAP_TILE_ATTRIBUTION?.trim() || DEFAULT_MAP_TILE_ATTRIBUTION)
  : DEFAULT_MAP_TILE_ATTRIBUTION;
const BOHOL_MAP_REGION = PHILIPPINES_MAP_REGIONS.find(region => region.name === 'Bohol');
const BOHOL_POSITION = BOHOL_MAP_REGION.position;

const getCoverageMatch = (coverage, mapRegion) => (
  coverage.find(region => {
    const regionName = region?.name?.toLowerCase() || '';
    return mapRegion.aliases.some(alias => regionName.includes(alias));
  })
);

const createMapPinIcon = (isOrigin, isActive) => L.divIcon({
  className: 'about-leaflet-marker',
  html: '<span class="about-leaflet-marker-shell'
    + (isOrigin ? ' is-origin' : '')
    + (isActive ? ' is-active' : '')
    + '"><span class="about-leaflet-marker-dot"></span></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const buildShippingRoute = (from, to) => {
  const control = [
    (from[0] + to[0]) / 2 + 1.4,
    (from[1] + to[1]) / 2 - 1,
  ];

  return Array.from({ length: 25 }, (_, index) => {
    const t = index / 24;
    const inverse = 1 - t;
    return [
      inverse * inverse * from[0] + 2 * inverse * t * control[0] + t * t * to[0],
      inverse * inverse * from[1] + 2 * inverse * t * control[1] + t * t * to[1],
    ];
  });
};

const InteractiveMap = ({ coverage, selectedRegionId, onSelectRegion }) => {
  const [hoveredPin, setHoveredPin] = useState(null);
  const mappedRegions = PHILIPPINES_MAP_REGIONS
    .map(mapRegion => ({
      mapRegion,
      coverageRegion: getCoverageMatch(coverage, mapRegion),
    }))
    .filter(({ coverageRegion }) => coverageRegion);

  const selectedMapRegion = mappedRegions.find(
    ({ coverageRegion }) => coverageRegion.id === selectedRegionId
  )?.mapRegion || null;
  const selectedDestination = selectedMapRegion?.name === 'Bohol' ? null : selectedMapRegion;
  const defaultRouteRegion = PHILIPPINES_MAP_REGIONS.find(
    mapRegion => mapRegion.name === 'Batangas'
  ) || null;
  const routeRegion = selectedDestination || defaultRouteRegion;
  const tooltipRegion = hoveredPin
    ? mappedRegions.find(({ mapRegion }) => mapRegion.name === hoveredPin)?.mapRegion
    : selectedMapRegion;

  return (
    <div className="about-map-box">
      <MapContainer
        className="about-leaflet-map"
        center={PHILIPPINES_MAP_CENTER}
        zoom={PHILIPPINES_MAP_ZOOM}
        maxBounds={PHILIPPINES_MAP_BOUNDS}
        maxBoundsViscosity={1}
        minZoom={PHILIPPINES_MAP_ZOOM}
        maxZoom={13}
        worldCopyJump={false}
        scrollWheelZoom={false}
        zoomControl={false}
        attributionControl={false}
      >
        <TileLayer
          url={MAP_TILE_URL}
          attribution={MAP_TILE_ATTRIBUTION}
          bounds={PHILIPPINES_MAP_BOUNDS}
          noWrap
          maxZoom={19}
        />
        <AttributionControl prefix={false} position="bottomright" />
        <ZoomControl position="topright" />

        {routeRegion && (
          <Polyline
            positions={buildShippingRoute(BOHOL_POSITION, routeRegion.position)}
            pathOptions={{
              color: '#22c55e',
              weight: selectedDestination ? 4 : 3,
              opacity: selectedDestination ? 0.84 : 0.38,
              dashArray: selectedDestination ? '8 10' : '5 9',
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
        )}

        {mappedRegions.map(({ mapRegion, coverageRegion }) => {
          const isSelected = selectedRegionId === coverageRegion.id;
          const isActive = isSelected || hoveredPin === mapRegion.name;

          return (
            <Marker
              key={mapRegion.name}
              position={mapRegion.position}
              icon={createMapPinIcon(mapRegion.isOrigin, isActive)}
              keyboard
              title={'Select ' + mapRegion.name + ' region'}
              alt={'Select ' + mapRegion.name + ' region'}
              autoPanOnFocus={false}
              zIndexOffset={isActive ? 1000 : 0}
              eventHandlers={{
                click: () => onSelectRegion(isSelected ? null : coverageRegion.id),
                keydown: (event) => {
                  const key = event.originalEvent?.key;
                  if (key !== 'Enter' && key !== ' ') return;
                  event.originalEvent.preventDefault();
                  onSelectRegion(isSelected ? null : coverageRegion.id);
                },
                mouseover: () => setHoveredPin(mapRegion.name),
                mouseout: () => setHoveredPin(null),
                focus: () => setHoveredPin(mapRegion.name),
                blur: () => setHoveredPin(null),
              }}
            />
          );
        })}
      </MapContainer>

      <div className="about-coverage-tag">
        <span className="about-green-dot" /> COVERAGE EXPLORER
      </div>
      <div className="about-map-hint">
        Real Philippine map · Select a hub for route details
      </div>

      <AnimatePresence>
        {tooltipRegion && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            className="about-map-tooltip"
          >
            <div className="about-map-tooltip-dot" />
            <div className="about-map-tooltip-body">
              <div className="about-map-tooltip-name">{tooltipRegion.name}</div>
              <div className="about-map-tooltip-detail">{tooltipRegion.details}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const AnimatedCounter = ({ value }) => {
  const [count, setCount] = useState(0);
  const elementRef = useRef(null);

  useEffect(() => {
    let start = 0;
    const end = parseInt(value, 10);
    if (isNaN(end) || end === 0) {
      setCount(value);
      return;
    }

    let observer;
    let animationFrameId;
    let startTime = null;
    const duration = 1200;

    const animate = (timestamp) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const easeOutQuad = progress * (2 - progress);
      const currentCount = Math.floor(easeOutQuad * (end - start) + start);
      setCount(currentCount);

      if (progress < 1) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        setCount(end);
      }
    };

    observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        animationFrameId = requestAnimationFrame(animate);
        observer.disconnect();
      }
    }, { threshold: 0.1 });

    if (elementRef.current) {
      observer.observe(elementRef.current);
    }

    return () => {
      if (observer) observer.disconnect();
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [value]);

  return <span ref={elementRef}>{typeof count === 'number' ? count.toLocaleString() : count}</span>;
};

// ─── Loading Skeleton ───
const LoadingSkeleton = () => (
  <div className="about-skel-wrapper">
    {/* Skeleton Hero */}
    <div className="about-skel-hero">
      <div className="about-skeleton about-skel-hero-bg" />
      <div className="about-skel-center">
        <div className="about-skeleton about-skeleton-text about-skel-badge" />
        <div className="about-skeleton about-skeleton-title about-skel-title-lg" />
        <div className="about-skeleton about-skeleton-text about-skel-subtitle" />
      </div>
    </div>
    {/* Skeleton Stats */}
    <div className="about-skel-stats">
      <div className="about-skeleton about-skeleton-block about-skel-stats-block" />
    </div>
    {/* Skeleton Content */}
    <div className="about-skel-content">
      <div className="about-skel-grid-2">
        <div>
          <div className="about-skeleton about-skeleton-title about-skel-text-80" />
          <div className="about-skeleton about-skeleton-text about-skel-text-100" />
          <div className="about-skeleton about-skeleton-text about-skel-text-90" />
          <div className="about-skeleton about-skeleton-text about-skel-text-95" />
          <div className="about-skeleton about-skeleton-text about-skel-text-70" />
        </div>
        <div className="about-skeleton about-skeleton-card" />
      </div>
      <div className="about-skel-grid-3">
        {[1, 2, 3].map(i => <div key={i} className="about-skeleton about-skeleton-card" />)}
      </div>
    </div>
  </div>
);

// ─── Section anchor IDs and labels ───
// Height reserved by the fixed glass nav — anchors must clear it or the section
// header lands underneath the bar and the click looks like it hit blank space.
const NAV_OFFSET = 88;

const SECTIONS = [
  { id: 'hero', label: 'Home' },
  { id: 'story', label: 'Our Story' },
  { id: 'features', label: 'Features' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'highlights', label: 'Gallery' },
  { id: 'feedback', label: 'Reviews' },
  { id: 'contact', label: 'Contact' },
];

// ═══════════════════════════════════════════════════════════
// MAIN ABOUT PAGE COMPONENT
// ═══════════════════════════════════════════════════════════
const AboutPage = () => {
  usePageTitle('About Us');
  const toast = useToast();
  
  const [scrolled, setScrolled] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [activeSection, setActiveSection] = useState('hero');
  const [form, setForm] = useState({ name: '', phone: '', message: '' });
  const { errors, validate, clearError } = useFieldErrors();
  const [loading, setLoading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [selectedRegionId, setSelectedRegionId] = useState(null);
  const [selectedRating, setSelectedRating] = useState('all');
  const [citySearchQuery, setCitySearchQuery] = useState('');
  
  const { scrollY } = useScroll();
  const yHero = useTransform(scrollY, [0, 600], [0, 200]);
  const opacityHero = useTransform(scrollY, [0, 450], [1, 0.2]);
  
  const [data, setData] = useState({
    info: null, features: [], highlights: [], coverage: [], feedback: []
  });
  const [fetching, setFetching] = useState(true);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [systemStatus, setSystemStatus] = useState(() =>
    typeof navigator === 'undefined' || navigator.onLine ? 'checking' : 'offline'
  );

  // ─── Scroll handling (scroll progress, active section, back-to-top) ───
  useEffect(() => {
    const handleScroll = () => {
      const y = window.scrollY;
      // The nav sits on the dark hero, so its links are white there. Flip to the
      // solid/dark treatment only once the nav has actually cleared the hero —
      // switching at a fixed 50px left dark text on the dark hero (and, on the way
      // back, white text on the light sections below it).
      const hero = document.getElementById('hero');
      const heroBottom = hero ? hero.offsetTop + hero.offsetHeight : 0;
      setScrolled(y + NAV_OFFSET >= heroBottom);
      setShowBackToTop(y > 400);
      
      // Calculate scroll progress
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      setScrollProgress(docHeight > 0 ? (y / docHeight) * 100 : 0);

      // Determine active section
      const sectionIds = SECTIONS.map(s => s.id);
      let currentActive = 'hero';
      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= 150) {
            currentActive = id;
          }
        }
      }
      setActiveSection(currentActive);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // ─── Data loading ───
  useEffect(() => {
    let isMounted = true;
    let requestSequence = 0;

    const loadData = async ({ initial = false } = {}) => {
      const requestId = ++requestSequence;
      const browserOnline = typeof navigator === 'undefined' || navigator.onLine;

      if (!browserOnline) {
        if (!isMounted || requestId !== requestSequence) return;
        setIsOnline(false);
        setSystemStatus('offline');
        if (initial) setFetching(false);
        return;
      }

      try {
        if (initial) setFetching(true);
        setSystemStatus('checking');
        const [info, highlights, coverage, feedback] = await Promise.all([
          getCompanyInformation(), getFeaturedDeliveries(),
          getCoverageAreas(), getPublicFeedback()
        ]);
        const features = info?.features || [];

        // Resolve highlight photos — RPC now returns a single `featured_photo` path
        const resolvedHighlights = await Promise.all(highlights.map(async (h) => {
          const path = h.featured_photo || null;
          if (!path) return { ...h, resolved_image: null };
          try {
            const urls = await resolvePhotoUrls([path]);
            return { ...h, resolved_image: urls[0] };
          } catch (e) {
            return { ...h, resolved_image: null };
          }
        }));

        // Resolve feedback photos — RPC now returns a single `featured_photo` path
        const resolvedFeedback = await Promise.all(feedback.map(async (fb) => {
          const order = fb.orders;
          if (!order || !order.featured_on_website) return { ...fb, resolved_image: null };
          const path = order.featured_photo || null;
          if (!path) return { ...fb, resolved_image: null };
          try {
            const urls = await resolvePhotoUrls([path]);
            return { ...fb, resolved_image: urls[0] };
          } catch (e) {
            return { ...fb, resolved_image: null };
          }
        }));

        if (isMounted && requestId === requestSequence) {
          setIsOnline(true);
          setData({ info, features, highlights: resolvedHighlights.filter(h => h.resolved_image), coverage, feedback: resolvedFeedback });
          setSystemStatus('online');
        }
      } catch (err) {
        console.error('Failed to load company info', err);
        if (isMounted && requestId === requestSequence) {
          const stillOnline = typeof navigator === 'undefined' || navigator.onLine;
          setIsOnline(stillOnline);
          setSystemStatus(stillOnline ? 'unavailable' : 'offline');
        }
      } finally {
        if (isMounted && requestId === requestSequence) setFetching(false);
      }
    };

    const updateOnlineState = () => {
      const online = navigator.onLine;
      setIsOnline(online);

      if (!online) {
        requestSequence += 1;
        setSystemStatus('offline');
        setFetching(false);
        return;
      }

      // Re-check the backend when the connection returns instead of leaving
      // the footer stuck on the previous offline/unavailable result.
      loadData();
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) loadData();
    };

    loadData({ initial: true });
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      isMounted = false;
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  // ─── Form handlers ───
  const PHONE_RE = /^09\d{9}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const handleContactInput = (e) => {
    let val = e.target.value;
    if (/^\d+$/.test(val) && val.length > 11) {
      val = val.slice(0, 11);
    }
    setForm(p => ({ ...p, phone: val.slice(0, 60) }));
  };

  const normalizePhone = (value) => {
    let digits = String(value).replace(/[\s\-().]/g, '');
    if (digits.startsWith('+63')) return `0${digits.slice(3)}`;
    if (digits.startsWith('63') && digits.length === 12) return `0${digits.slice(2)}`;
    return digits;
  };

  /**
   * The contact field takes either a mobile number or an email, so its rule
   * has to decide which the visitor meant before it can say what is wrong
   * with it. Returns the message, or null when it is acceptable.
   */
  const contactFieldError = (contact) => {
    if (!contact) return 'Enter a mobile number or an email address so we can reply.';
    if (contact.includes('@')) {
      return EMAIL_RE.test(contact) ? null : 'Please enter a valid email address.';
    }
    if (!/\d/.test(contact)) return 'Please enter a valid mobile number or email address.';
    return PHONE_RE.test(normalizePhone(contact))
      ? null
      : 'Mobile number must be exactly 11 digits and start with 09.';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const contact = form.phone.trim();
    const ok = validate({
      name: !form.name.trim() ? 'Please enter your name.' : null,
      phone: contactFieldError(contact),
      message: !form.message.trim() ? 'Please write your message.' : null,
    });
    if (!ok) return;

    const isEmail = contact.includes('@');
    const storedContact = isEmail ? contact : normalizePhone(contact);

    setLoading(true);
    try {
      // The form accepts either a mobile number or an email in one field.
      // Which one it is has already been determined above, so record it in
      // the matching column rather than in a single polymorphic one.
      await createContactInquiry({
        name: form.name.trim(),
        message: form.message.trim(),
        contact_phone: isEmail ? null : storedContact,
        contact_email: isEmail ? storedContact : null,
      });
      toast.success('Message sent! We will contact you soon.');
      setForm({ name: '', phone: '', message: '' });
    } catch (err) {
      toast.error(err.message || 'Failed to send message. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ─── Lightbox navigation ───
  const lightboxImages = data.highlights.map(h => ({
    image_url: h.resolved_image,
    title: h.featured_title,
    description: h.featured_caption,
  }));
  const handleLightboxNavigate = useCallback((direction) => {
    setLightboxIndex(prev => {
      const next = prev + direction;
      if (next < 0 || next >= lightboxImages.length) return prev;
      return next;
    });
  }, [lightboxImages.length]);

  // ─── Section scroll helper ───
  const scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'hero') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Offset by the fixed nav so the section header lands just under the bar
    // instead of behind it (which read as scrolling into empty whitespace).
    const top = el.getBoundingClientRect().top + window.scrollY - NAV_OFFSET;
    window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
  };

  const { info, features, highlights, coverage, feedback } = data;
  const resolvedSystemStatus = !isOnline ? 'offline' : systemStatus;
  const systemStatusLabel = {
    checking: 'Checking System',
    online: 'System Online',
    offline: 'System Offline',
    unavailable: 'System Unavailable',
  }[resolvedSystemStatus] || 'Checking System';

  // Filter feedback by rating state
  const filteredFeedback = feedback?.filter(fb => {
    if (selectedRating === 'all') return true;
    return fb.rating === parseInt(selectedRating, 10);
  }) || [];

  // ─── Loading state ───
  if (fetching) return <LoadingSkeleton />;

  const companyName = info?.name || 'CargoExpress PH';
  const bannerImage = info?.banner_image_url || 'https://images.unsplash.com/photo-1586528116311-ad8ed3891db8?auto=format&fit=crop&q=80&w=2000';

  // Framer motion variants for staggered children
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.1, delayChildren: 0.1 }
    }
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 24 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } }
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="public-about-page">
      <a href="#hero" className="skip-link">Skip to main content</a>

      {/* --- Scroll Progress Bar --- */}
      <div className="about-scroll-progress" style={{ width: `${scrollProgress}%` }} />

      {/* --- 1. Navigation --- */}
      <nav className={`about-glass-nav ${scrolled ? 'scrolled' : ''}`}>
        <div className="about-nav-container">
          <div className="about-nav-brand">
            <BrandLogo size={36} decorative />
            <h1>
              <BrandWordmark tone={scrolled ? 'default' : 'on-dark'} />
            </h1>
          </div>

          {/* Section navigation links */}
          <div className="about-nav-links">
            {SECTIONS.filter(s => s.id !== 'hero').map(s => (
              <button
                key={s.id}
                className={`about-nav-link ${scrolled ? 'scrolled' : 'transparent'} ${activeSection === s.id ? 'active' : ''}`}
                onClick={() => scrollToSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <Link 
            to="/login" 
            className={`about-login-btn ${scrolled ? 'scrolled' : 'transparent'}`}
          >
            Sign In <ChevronRight size={16} />
          </Link>
        </div>
      </nav>

      {/* ═══ 2. Hero Section ═══ */}
      <section id="hero" className="about-hero" tabIndex={-1}>
        <motion.div 
          className="about-hero-bg"
          style={{ 
            backgroundImage: `url(${bannerImage})`,
            y: yHero,
            opacity: opacityHero
          }}
        />
        <div className="about-hero-overlay" />
        
        {/* Decorative gradient orbs */}
        <div className="about-gradient-orb about-gradient-orb-primary" />
        <div className="about-gradient-orb about-gradient-orb-accent" />

        <motion.div 
          className="about-hero-content"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="about-hero-badge">
            Trusted Logistics Partner
          </div>
          <h2 className="about-hero-heading">
            {info?.banner_title || 'Deliveries Made Simple.'}
          </h2>
          <p className="about-hero-subtext">
            {info?.banner_description || info?.short_description || 'Connecting businesses and families through reliable logistics.'}
          </p>
          <div className="about-hero-cta-row">
            <a href="#contact" className="about-hero-cta-primary">
              Contact Us <Send size={18} />
            </a>
            {info?.banner_button_text && info?.banner_button_link && (
              <Link to={info.banner_button_link} className="about-hero-cta-secondary">
                {info.banner_button_text}
              </Link>
            )}
          </div>
        </motion.div>

        {/* Scroll Down Indicator */}
        <button className="about-scroll-hint" onClick={() => scrollToSection('story')} aria-label="Scroll down">
          <ChevronDown size={28} />
        </button>

      </section>

      {/* ═══ Main Content ═══ */}
      <div className="about-content-wrapper">

        {/* ═══ 4. Our Story ═══ */}
        <motion.section 
          id="story"
          className="about-section"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          <div className="about-grid-2">
            <div>
              <h2 className="about-story-heading">
                About <span className="about-text-gradient">CargoExpress PH</span>.
              </h2>
              <p className="about-story-body">
                {info?.long_description || 'We are a dedicated logistics provider ensuring safe and timely delivery of your cargo.'}
              </p>

              {/* Timeline milestones */}
              <div className="about-timeline">
                {[
                  { year: 'Founded', text: `${companyName} began operations, connecting Manila to Bohol` },
                  { year: 'Growth', text: 'Expanded coverage to Cavite, Laguna, Bulacan & Batangas' },
                  { year: 'Our Promise', text: 'Committed to delivering every package with care, speed, and reliability across every route we serve' },
                ].map((item, i) => (
                  <motion.div 
                    key={i} 
                    className="about-timeline-item"
                    initial={{ opacity: 0, x: -20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.15, duration: 0.5 }}
                  >
                    <div className="about-timeline-dot" />
                    <div className="about-timeline-year">{item.year}</div>
                    <div className="about-timeline-text">{item.text}</div>
                  </motion.div>
                ))}
              </div>
            </div>
            
            {/* Image collage */}
            <div className="about-story-image-container">
              {/* Decorative dot pattern */}
              <div className="about-dot-pattern about-dot-top" />
              <div className="about-dot-pattern about-dot-bottom" />
              
              <div className="about-story-img-wrap">
                <div className="about-story-img-glow" />
                <img 
                  src={bannerImage} 
                  alt={`${companyName} Logistics`} 
                  className="about-story-main-img"
                  fetchPriority="high"
                />
                <img 
                  src={bannerImage} 
                  alt={`${companyName} Delivery`} 
                  className="about-story-overlay-img"
                  fetchPriority="high"
                />
              </div>
            </div>
          </div>
        </motion.section>

        {/* ═══ 5. Features Grid ═══ */}
        <motion.section
          id="features"
          className="about-section"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          {features?.length > 0 ? (
            <>
              <div className="about-section-header">
                <div className="about-section-label">Why Choose Us</div>
                <h2 className="about-section-title">The CargoExpress Advantage</h2>
              </div>
              <motion.div
                className="about-features-grid"
                variants={containerVariants}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-80px" }}
              >
                {features.map((f) => {
                  const Icon = getFeatureIcon(f.icon);
                  return (
                    <motion.div
                      key={f.id}
                      className="about-bento-card"
                      variants={itemVariants}
                    >
                      <div className="about-feature-icon">
                        <Icon size={28} />
                      </div>
                      <div>
                        <h3 className="about-feature-title">{f.title}</h3>
                        <p className="about-feature-desc">{f.description}</p>
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>
            </>
          ) : (
            <div className="about-empty-state">
              <Sparkles size={48} className="about-empty-icon" />
              <div className="about-empty-text">Our feature details are being updated. Check back soon.</div>
            </div>
          )}
        </motion.section>

        {/* ═══ 6. Coverage Areas ═══ */}
        <motion.section
          id="coverage"
          className="about-section"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          {coverage?.length > 0 ? (
            <>
          <div className="about-bento-card about-coverage-header-card">
              <div className="about-coverage-grid">
                <div>
                  <div className="about-coverage-icon-box">
                    <MapPin size={28} />
                  </div>
                  <h2 className="about-coverage-heading">Where We Deliver</h2>
                  <p className="about-coverage-desc">Explore the destinations we serve from Bohol. Select a destination on the map or a coverage card to preview its route.</p>
                  
                  <InteractiveMap 
                    coverage={coverage} 
                    selectedRegionId={selectedRegionId} 
                    onSelectRegion={setSelectedRegionId} 
                  />
                </div>
                
                <div className="about-coverage-regions">
                  <div className="about-coverage-search-wrap">
                    <div className="about-coverage-search-inner">
                      <Search size={18} className="about-coverage-search-icon" />
                      <input 
                        id="about-coverage-search"
                        name="qmunicipality"
                        type="search"
                        maxLength={100}
                        enterKeyHint="search"
                        placeholder="Search municipalities..."
                        aria-label="Search municipalities"
                        value={citySearchQuery}
                        onChange={(e) => setCitySearchQuery(e.target.value)}
                        className="about-coverage-search-input"
                      />
                    </div>
                  </div>
                  {citySearchQuery && !coverage.some(region =>
                    region.municipalities?.some(m => m.name.toLowerCase().includes(citySearchQuery.toLowerCase()))
                  ) && (
                    <div className="about-region-card about-coverage-no-result">
                      <Search size={22} className="about-coverage-no-result-icon" aria-hidden="true" />
                      <p className="about-coverage-no-result-title">No municipalities found</p>
                      <p className="about-coverage-no-result-desc">
                        Nothing matches “{citySearchQuery}”. Try a different spelling or a nearby town.
                      </p>
                    </div>
                  )}
                  {coverage.map((region) => {
                    const filteredMunis = region.municipalities?.filter(m => 
                      m.name.toLowerCase().includes(citySearchQuery.toLowerCase())
                    ) || [];

                    if (citySearchQuery && filteredMunis.length === 0) return null;

                    const isSelected = selectedRegionId === region.id;
                    const isExpanded = isSelected || citySearchQuery.length > 0;

                    return (
                      <div 
                        key={region.id} 
                        className={`about-region-card ${isSelected ? 'selected' : ''}`}
                        onClick={() => setSelectedRegionId(isExpanded && !citySearchQuery ? null : region.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedRegionId(isExpanded && !citySearchQuery ? null : region.id); } }}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                      >
                        <h4>
                          <span className="about-region-label-wrap">
                            <MapPin size={18} className="about-region-pin-icon" /> {region.name}
                          </span>
                          <ChevronDown size={18} className="about-region-chevron" />
                        </h4>
                        
                        <AnimatePresence initial={false}>
                          {isExpanded && (
                            <motion.div 
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: 'easeInOut' }}
                            >
                              <div className="about-region-munis">
                                {filteredMunis.map(muni => (
                                  <div key={muni.id} className="about-muni-tag">
                                    {muni.name}
                                  </div>
                                ))}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            </>
          ) : (
            <div className="about-empty-state">
              <MapPin size={48} className="about-empty-icon" />
              <div className="about-empty-text">Coverage information is being updated. Check back soon.</div>
            </div>
          )}
        </motion.section>

        {/* ═══ 7. Delivery Highlights Gallery ═══ */}
        <motion.section
          id="highlights"
          className="about-section"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          {highlights?.length > 0 ? (
            <>
          <div className="about-section-header">
              <div className="about-section-label">Delivery Highlights</div>
              <h2 className="about-section-title">Featured Shipments</h2>
            </div>
            
            <motion.div 
              className="about-highlights-grid"
              variants={containerVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-60px" }}
            >
              {highlights.map((highlight, idx) => (
                <motion.button 
                  type="button"
                  key={highlight.id} 
                  className="about-highlight-card"
                  onClick={() => setLightboxIndex(idx)}
                  aria-label={`View delivery photo for ${highlight.featured_title}`}
                  variants={itemVariants}
                >
                  <img 
                    src={highlight.resolved_image} 
                    alt={highlight.featured_title || 'Delivery photo'} 
                    loading="lazy" 
                    onError={(e) => {
                      e.target.closest('.about-highlight-card').style.display = 'none';
                    }}
                  />
                  <div className="about-highlight-overlay">
                    <div className="about-highlight-title about-highlight-title-inner">
                      <Package size={18} className="about-highlight-pkg-icon" />
                      <span>{highlight.featured_title}</span>
                    </div>
                    {highlight.featured_caption && (
                      <div className="about-highlight-caption">
                        {highlight.featured_caption}
                      </div>
                    )}
                    <div className="about-highlight-meta">
                      <span>{highlight.receiver_city}{highlight.receiver_province ? `, ${highlight.receiver_province}` : ''}</span>
                      {highlight.updated_at && <span>Delivered: {new Date(highlight.updated_at).toLocaleDateString()}</span>}
                    </div>
                  </div>
                </motion.button>
              ))}
            </motion.div>
            </>
          ) : (
            <div className="about-empty-state">
              <Image size={48} className="about-empty-icon" />
              <div className="about-empty-text">Featured delivery photos will appear here soon.</div>
            </div>
          )}
        </motion.section>

        {/* ═══ 8. Customer Feedback ═══ */}
        <motion.section 
          id="feedback"
          className="about-section"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          <div className="about-section-header-sm">
            <div className="about-section-label">Feedback</div>
            <h2 className="about-section-title">What Our Customers Say</h2>
          </div>

          {/* Feedback Star Filter Chips */}
          <div className="about-feedback-filters">
            {['all', '5', '4', '3', '2', '1'].map(rating => {
              const isActive = selectedRating === rating;
              return (
                <button
                  key={rating}
                  type="button"
                  className={`about-filter-chip ${isActive ? 'active' : ''}`}
                  onClick={() => setSelectedRating(rating)}
                >
                  {rating === 'all' ? 'All Reviews' : `${rating} Star${rating !== '1' ? 's' : ''}`}
                  {rating !== 'all' && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill={isActive ? "#fff" : "var(--warning)"} stroke="none">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
          
          {(!feedback || feedback.length === 0) ? (
            <div className="about-empty-state about-empty-state-lg">
              <MessageSquare size={48} className="about-empty-icon" />
              <div className="about-empty-text">No customer feedback has been submitted yet.</div>
            </div>
          ) : filteredFeedback.length === 0 ? (
            <div className="about-empty-state about-empty-state-lg">
              <MessageSquare size={48} className="about-empty-icon" />
              <div className="about-empty-text">No {selectedRating}-star reviews found.</div>
            </div>
          ) : (
            <motion.div 
              className="about-reviews-grid"
              variants={containerVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-60px" }}
            >
              {filteredFeedback.map((fb, idx) => {
                const firstName = fb.profiles?.name?.split(' ')[0] || 'Customer';
                const isHero = idx === 0 && filteredFeedback.length > 2;
                return (
                  <motion.div 
                    key={fb.id} 
                    className={`about-feedback-card ${isHero ? 'hero-testimonial' : ''}`}
                    variants={itemVariants}
                  >
                    {/* Decorative quote mark */}
                    <div className="about-quote-mark">"</div>
                    
                    <div>
                      <div className="about-review-stars">
                        {[1, 2, 3, 4, 5].map(star => (
                          <svg key={star} width="20" height="20" viewBox="0 0 24 24" fill={star <= fb.rating ? "var(--warning)" : "var(--border)"} stroke="none">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                          </svg>
                        ))}
                      </div>
                      <p className="about-review-text">"{fb.message}"</p>
                      
                      {fb.resolved_image && (
                        <div className="about-review-photo">
                          <img 
                            src={fb.resolved_image} 
                            alt="Delivery Proof" 
                            loading="lazy" 
                            onError={(e) => {
                              const photoContainer = e.target.closest('.about-review-photo');
                              if (photoContainer) photoContainer.style.display = 'none';
                            }}
                          />
                        </div>
                      )}

                      <div className="about-reviewer-row">
                        <div className="about-reviewer-avatar">
                          {firstName[0].toUpperCase()}
                        </div>
                        <div>
                          <div className="about-reviewer-name">
                            {'\u2014'} {firstName}
                          </div>
                          {fb.orders?.receiver_city && (
                            <div className="about-reviewer-location">
                              Delivered to {fb.orders.receiver_city}{fb.orders.receiver_province ? `, ${fb.orders.receiver_province}` : ''}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </motion.section>

        {/* ═══ 9. Contact Section ═══ */}
        <motion.section 
          id="contact"
          className="about-section"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          <div className="about-contact-card">
            <div className="about-contact-grid">
              
              {/* Left: Contact Info */}
              <div className="about-contact-info">
                <h2 className="about-contact-heading">Get in Touch.</h2>
                <p className="about-contact-subtext">
                  Have questions about our services? Need a quote? Our team is ready to assist you 24/7.
                </p>

                <div className="about-contact-blocks">
                  {(info?.smart_phone || info?.globe_phone) && (
                    <div className="about-contact-block">
                      <div className="about-contact-icon-box"><Phone size={20} /></div>
                      <div>
                        <div className="about-contact-block-title">Call Us</div>
                        <div className="about-contact-block-body">
                          {info.smart_phone && (
                            <div>Smart: <a href={`tel:${info.smart_phone}`} className="about-contact-link">{info.smart_phone}</a></div>
                          )}
                          {info.globe_phone && (
                            <div>Globe: <a href={`tel:${info.globe_phone}`} className="about-contact-link">{info.globe_phone}</a></div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {info?.email && (
                    <div className="about-contact-block">
                      <div className="about-contact-icon-box"><Mail size={20} /></div>
                      <div>
                        <div className="about-contact-block-title">Email Us</div>
                        <a href={`mailto:${info.email}`} className="about-contact-link">{info.email}</a>
                      </div>
                    </div>
                  )}

                  {(info?.manila_address || info?.bohol_address) && (
                    <div className="about-contact-block">
                      <div className="about-contact-icon-box"><MapPin size={20} /></div>
                      <div>
                        <div className="about-contact-block-title">Visit Our Hubs</div>
                        <div className="about-contact-block-body about-contact-block-body-lg">
                          {info.manila_address && (
                            <a
                              href={getGoogleMapsSearchUrl(info.manila_address)}
                              className="about-contact-link"
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Open Manila Hub in Google Maps"
                            >
                              <strong>Manila:</strong> {info.manila_address}
                            </a>
                          )}
                          {info.bohol_address && (
                            <a
                              href={getGoogleMapsSearchUrl(info.bohol_address)}
                              className="about-contact-link"
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Open Bohol Hub in Google Maps"
                            >
                              <strong>Bohol:</strong> {info.bohol_address}
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Form */}
              <div className="about-contact-form">
                <h3 className="about-contact-form-title">Send a Message</h3>
                {/* noValidate, as every other form in the app is: the browser's
                    native bubble would otherwise intercept the submit and this
                    form's own inline errors would never render. */}
                <form onSubmit={handleSubmit} noValidate className="about-contact-form-body">
                  <div>
                    <label htmlFor="contact-name" className="about-form-label">Full Name</label>
                    <input 
                      id="contact-name"
                      className={`about-premium-input ${invalidClass('name', errors)}`}
                      placeholder="Juan Dela Cruz"
                      value={form.name}
                      onChange={e => { setForm(p => ({ ...p, name: e.target.value })); clearError('name'); }}
                      required
                      {...fieldAttrs('name', errors)}
                    />
                    <FieldError name="name" errors={errors} />
                  </div>
                  <div>
                    <label htmlFor="contact-phone" className="about-form-label">Mobile Number or Email</label>
                    <input
                      id="contact-phone"
                      type="text"
                      className={`about-premium-input ${invalidClass('phone', errors)}`}
                      placeholder="Mobile Number or Email"
                      maxLength={60}
                      value={form.phone}
                      onChange={e => { handleContactInput(e); clearError('phone'); }}
                      {...fieldAttrs('phone', errors)}
                    />
                    <FieldError name="phone" errors={errors} />
                  </div>
                  <div>
                    <label htmlFor="contact-message" className="about-form-label">Message</label>
                    <textarea 
                      id="contact-message"
                      className={`about-premium-input about-form-textarea ${invalidClass('message', errors)}`}
                      placeholder="How can we help you?"
                      value={form.message}
                      onChange={e => { setForm(p => ({ ...p, message: e.target.value })); clearError('message'); }}
                      required
                      {...fieldAttrs('message', errors)}
                    />
                    <FieldError name="message" errors={errors} />
                  </div>
                  <button 
                    type="submit" 
                    className="about-submit-btn"
                    disabled={loading}
                  >
                    {loading ? <Loader size={20} className="animate-spin" /> : <><Send size={18} /> Send Message</>}
                  </button>
                </form>
              </div>

            </div>
          </div>
        </motion.section>

      </div>

      {/* ═══ Wave Divider ═══ */}
      <div className="about-wave-divider">
        <svg viewBox="0 0 1440 100" preserveAspectRatio="none" className="about-wave-svg">
          <path d="M0,40 C320,100 440,0 720,50 C1000,100 1120,10 1440,60 L1440,100 L0,100 Z" />
        </svg>
      </div>
      
      {/* ═══ 10. Footer ═══ */}
      <footer className="about-footer">
        <div className="about-footer-grid">
          {/* Brand Column */}
          <div>
            <div className="about-footer-brand">
              <BrandLogo size={34} decorative />
              <h3>{companyName}</h3>
            </div>
            <p className="about-footer-desc">
              {info?.short_description || 'Reliable logistics and cargo delivery services across the Philippines.'}
            </p>
            {/* Social Media */}
            <div className="about-footer-social">
              {info?.facebook && (
                <a href={info.facebook} target="_blank" rel="noreferrer" className="about-social-btn" title="Facebook">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                  </svg>
                </a>
              )}
              {info?.messenger && (
                <a href={info.messenger} target="_blank" rel="noreferrer" className="about-social-btn" title="Messenger">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.477 2 2 6.145 2 11.243c0 2.91 1.448 5.503 3.7 7.208V22l3.355-1.84c.88.243 1.81.378 2.775.378 5.523 0 10-4.146 10-9.243S17.523 2 12 2zm1.13 12.374L10.91 12.05l-4.24 2.32 4.655-4.945 2.22 2.324 4.24-2.32-4.655 4.945z"/>
                  </svg>
                </a>
              )}
              {info?.email && (
                <a href={`mailto:${info.email}`} className="about-social-btn" title="Email">
                  <Mail size={18} />
                </a>
              )}
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="about-footer-heading">Quick Links</h4>
            <div className="about-footer-links">
              <Link to="/track" className="about-footer-link">Track Your Order</Link>
              <Link to="/login" className="about-footer-link">Customer Portal</Link>
              <a href="#features" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('features'); }}>Our Services</a>
              <a href="#coverage" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('coverage'); }}>Coverage Areas</a>
            </div>
          </div>

          {/* Company */}
          <div>
            <h4 className="about-footer-heading">Company</h4>
            <div className="about-footer-links">
              <a href="#story" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('story'); }}>About Us</a>
              <a href="#feedback" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('feedback'); }}>Customer Reviews</a>
              <a href="#highlights" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('highlights'); }}>Gallery</a>
              <a href="#contact" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('contact'); }}>Contact Us</a>
            </div>
          </div>
        </div>

          <div className="about-footer-bottom">
            <span>&copy; {new Date().getFullYear()} {companyName}. All rights reserved.</span>
            <span className="about-footer-legal-links" aria-label="Legal information">
              <Link to="/terms" className="about-footer-link">Terms of Service</Link>
              <Link to="/privacy" className="about-footer-link">Privacy Policy</Link>
            </span>
            <span
            className={`about-footer-status about-footer-status-${resolvedSystemStatus}`}
            role="status"
            aria-live="polite"
            aria-label={`Service status: ${systemStatusLabel}`}
          >
            <span className="about-footer-status-dot">{'\u25CF'}</span> {systemStatusLabel}
          </span>
        </div>
      </footer>

      {/* ═══ Lightbox ═══ */}
      {lightboxIndex >= 0 && (
        <Lightbox 
          images={lightboxImages} 
          currentIndex={lightboxIndex} 
          onClose={() => setLightboxIndex(-1)} 
          onNavigate={handleLightboxNavigate} 
        />
      )}

      {/* ═══ Back to Top ═══ */}
      <AnimatePresence>
        {showBackToTop && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="about-back-to-top"
            aria-label="Back to top"
          >
            <ArrowUp size={24} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
};

export default AboutPage;

