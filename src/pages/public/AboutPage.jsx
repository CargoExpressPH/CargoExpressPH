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
import * as LucideIcons from 'lucide-react';
import {
  Container, ArrowUp, Phone, MapPin, Globe, Loader, Send,
  Mail, Clock, Calendar, CheckCircle2,
  Navigation, Award, ChevronRight, ChevronDown, ChevronLeft, X, Play, Building2, TrendingUp, Users, MessageSquare,
  Star, Package
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { motion, useScroll, useTransform, AnimatePresence, MotionConfig } from 'framer-motion';

// â”€â”€â”€ Lightbox Component (with prev/next navigation) â”€â”€â”€
const Lightbox = ({ images, currentIndex, onClose, onNavigate }) => {
  useEffect(() => {
    if (currentIndex < 0) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onNavigate(-1);
      if (e.key === 'ArrowRight') onNavigate(1);
    };
    window.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset';
    };
  }, [currentIndex, onClose, onNavigate]);

  if (currentIndex < 0 || !images?.length) return null;
  const image = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;

  return (
    <div className="about-lightbox-overlay" onClick={onClose}>
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
  );
};

// â”€â”€â”€ Interactive Map Component â”€â”€â”€
const InteractiveMap = ({ coverage, selectedRegionId, onSelectRegion }) => {
  const mapPins = [
    { name: 'Metro Manila', x: 150, y: 115, details: 'Manila Hub (Sea Freight Terminal)' },
    { name: 'Bulacan', x: 148, y: 100, details: 'Bulacan Distribution Network' },
    { name: 'Cavite', x: 140, y: 125, details: 'Cavite Logistics Center' },
    { name: 'Laguna', x: 160, y: 130, details: 'Laguna Delivery Hub' },
    { name: 'Batangas', x: 148, y: 145, details: 'Batangas Shipping Hub' },
    { name: 'Bohol', x: 193, y: 281, details: 'Bohol Distribution Terminal', isOrigin: true }
  ];

  const [hoveredPin, setHoveredPin] = useState(null);

  const BOHOL = { x: 193, y: 281 };

  // Compute dynamic shipping route from Bohol to the selected non-Bohol pin
  const selectedPin = selectedRegionId
    ? mapPins.find(p => {
        const r = coverage.find(r => r.name.toLowerCase().includes(p.name.toLowerCase()));
        return r?.id === selectedRegionId && p.name !== 'Bohol';
      })
    : null;

  const buildRoute = (from, to) => {
    // Quadratic bezier control point: midpoint offset left for a graceful arc
    const cx = (from.x + to.x) / 2 - 22;
    const cy = (from.y + to.y) / 2;
    return `M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`;
  };

  // Arrowhead at destination pointing toward it from the control point
  const buildArrow = (from, to) => {
    const cx = (from.x + to.x) / 2 - 22;
    const cy = (from.y + to.y) / 2;
    // Direction from ctrl point to destination
    const dx = to.x - cx;
    const dy = to.y - cy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    const px = -ny;
    const py = nx;
    const base = 6;
    const tip = 9;
    return [
      `${to.x + nx * tip},${to.y + ny * tip}`,
      `${to.x - nx * 0 + px * base},${to.y - ny * 0 + py * base}`,
      `${to.x - nx * 0 - px * base},${to.y - ny * 0 - py * base}`,
    ].join(' ');
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: 460, borderRadius: 24, overflow: 'hidden', marginTop: 24, boxShadow: 'var(--shadow-lg)', border: '1px solid rgba(255,255,255,0.08)', background: '#0b2540' }}>
      <svg viewBox="0 0 280 420" style={{ width: '100%', height: '100%', display: 'block' }} xmlns="http://www.w3.org/2000/svg">
        <defs>
          {/* Ocean: deep navy â†’ tropical teal */}
          <linearGradient id="oceanGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stopColor="#0b2540" />
            <stop offset="35%"  stopColor="#0d3f61" />
            <stop offset="70%"  stopColor="#0e5577" />
            <stop offset="100%" stopColor="#136e8f" />
          </linearGradient>
          {/* Land: tropical forest green */}
          <linearGradient id="landGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#52b87a" />
            <stop offset="45%"  stopColor="#3da066" />
            <stop offset="100%" stopColor="#2d7a4f" />
          </linearGradient>
          {/* Fine contour lines make the land read like a topographic map. */}
          <pattern id="terrainContours" x="0" y="0" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M-2,12 C3,7 8,15 18,8 M-2,4 C4,-1 11,8 18,1" fill="none" stroke="rgba(236,247,214,0.18)" strokeWidth="0.55" />
          </pattern>
          <pattern id="terrainGrain" x="0" y="0" width="7" height="7" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.5" fill="rgba(255,255,255,0.11)" />
            <circle cx="5" cy="4" r="0.42" fill="rgba(7,42,26,0.19)" />
          </pattern>          {/* Bohol: vivid highlight green */}
          <linearGradient id="boholGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#4ade80" />
            <stop offset="100%" stopColor="#16a34a" />
          </linearGradient>
          {/* Vignette */}
          <radialGradient id="vigGrad" cx="50%" cy="50%" r="72%">
            <stop offset="0%"   stopColor="transparent" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.42)" />
          </radialGradient>
          {/* Ocean wave texture */}
          <pattern id="wavePattern" x="0" y="0" width="22" height="22" patternUnits="userSpaceOnUse">
            <path d="M0,11 Q5.5,8 11,11 Q16.5,14 22,11" fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="0.7"/>
            <path d="M0,18 Q5.5,15 11,18 Q16.5,21 22,18" fill="none" stroke="rgba(255,255,255,0.03)"  strokeWidth="0.5"/>
          </pattern>
          {/* Drop shadow for land masses */}
          <filter id="landShadow" x="-12%" y="-12%" width="130%" height="130%">
            <feDropShadow dx="1.5" dy="3" stdDeviation="3.5" floodColor="#000" floodOpacity="0.45" />
          </filter>
          {/* Green glow for Bohol */}
          <filter id="boholGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#22c55e" floodOpacity="0.55" />
          </filter>
          {/* Pin glow */}
          <filter id="pinGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="#22c55e" floodOpacity="0.9" />
          </filter>
          <filter id="labelShadow" x="-30%" y="-50%" width="160%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.4" floodColor="#031324" floodOpacity="0.95" />
          </filter>        </defs>

        {/* â”€â”€ Ocean base â”€â”€ */}
        <rect x="0" y="0" width="280" height="420" fill="url(#oceanGrad)" />
        <rect x="0" y="0" width="280" height="420" fill="url(#wavePattern)" />
        <rect x="0" y="0" width="280" height="420" fill="url(#vigGrad)" />

        {/* â”€â”€ Graticule / grid â”€â”€ */}
        <g stroke="rgba(255,255,255,0.07)" strokeWidth="0.55" strokeDasharray="4 5" fill="none">
          <line x1="0" y1="55"  x2="280" y2="55" />
          <line x1="0" y1="160" x2="280" y2="160" />
          <line x1="0" y1="265" x2="280" y2="265" />
          <line x1="0" y1="370" x2="280" y2="370" />
          <line x1="55"  y1="0" x2="55"  y2="420" />
          <line x1="140" y1="0" x2="140" y2="420" />
          <line x1="225" y1="0" x2="225" y2="420" />
        </g>

        {/* â”€â”€ Coordinate labels â”€â”€ */}
        <g className="about-map-detail" fill="rgba(255,255,255,0.28)" fontSize="5.5" fontWeight="600" fontFamily="Inter,sans-serif" letterSpacing="0.3">
          <text x="4" y="53">18Â°N</text>
          <text x="4" y="158">14Â°N</text>
          <text x="4" y="263">10Â°N</text>
          <text x="4" y="368">6Â°N</text>
          <text x="57"  y="417">118Â°E</text>
          <text x="142" y="417">122Â°E</text>
          <text x="227" y="417">126Â°E</text>
        </g>

        {/* â•â• PHILIPPINE ISLANDS â•â• */}

        {/* LUZON */}
        <path filter="url(#landShadow)"
          d="M128,22 L135,19 L143,20 L152,18 L158,22 L163,28 L162,35
             L168,40 L171,47 L168,55 L172,61 L175,68 L172,76 L176,83
             L178,90 L175,97 L178,104 L180,111 L177,118 L174,124
             L178,130 L180,137 L175,143 L170,149 L165,154 L160,159
             L158,166 L154,171 L150,176 L148,182 L143,187 L138,190
             L133,188 L128,184 L124,179 L121,173 L118,167 L117,160
             L114,154 L112,147 L115,141 L113,134 L110,128 L108,121
             L109,114 L107,107 L105,100 L107,93 L104,86 L103,79
             L106,72 L105,65 L108,58 L106,51 L110,44 L116,38 L122,32 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.3)" strokeWidth="0.85" strokeLinejoin="round"
        />
        {/* Luzon central ridge highlight */}
        <path d="M140,30 L155,46 L160,65 L158,86 L155,106 L148,131 L140,156 L133,171"
          fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="1.6" strokeLinecap="round" />

        {/* MINDORO */}
        <path filter="url(#landShadow)"
          d="M108,163 Q120,158 122,168 Q124,180 118,186 Q110,191 106,183 Q103,173 108,163 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.22)" strokeWidth="0.7"
        />

        {/* PALAWAN */}
        <path filter="url(#landShadow)"
          d="M52,206 L60,209 L68,215 L76,223 L83,232 L89,242
             L95,253 L100,263 L104,273 L100,278
             L93,271 L86,261 L79,251 L72,240
             L64,230 L57,220 L49,213 L47,207 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.22)" strokeWidth="0.7" strokeLinejoin="round"
        />

        {/* SAMAR */}
        <path filter="url(#landShadow)"
          d="M196,202 L208,210 L214,220 L218,231 L215,239
             L208,243 L202,239 L197,229 L194,218 L196,208 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.22)" strokeWidth="0.7"
        />

        {/* LEYTE */}
        <path filter="url(#landShadow)"
          d="M198,242 L205,248 L208,259 L206,269 L200,273
             L194,266 L192,255 L195,245 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.22)" strokeWidth="0.7"
        />

        {/* PANAY */}
        <path filter="url(#landShadow)"
          d="M130,231 Q142,224 148,233 Q152,243 148,253
             Q140,259 132,253 Q125,244 130,231 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.22)" strokeWidth="0.7"
        />

        {/* NEGROS */}
        <path filter="url(#landShadow)"
          d="M153,256 Q161,250 165,261 Q167,275 163,285
             Q157,291 151,284 Q148,271 150,261 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.22)" strokeWidth="0.7"
        />

        {/* CEBU */}
        <path filter="url(#landShadow)"
          d="M172,253 L176,259 L178,269 L177,279 L174,286
             L170,281 L169,269 L170,259 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.22)" strokeWidth="0.7"
        />

        {/* BOHOL â€” highlighted coverage area */}
        <path filter="url(#boholGlow)"
          d="M182,272 Q196,265 200,276 Q205,288 197,294
             Q186,297 181,287 Q178,278 182,272 Z"
          fill="url(#boholGrad)" stroke="#4ade80" strokeWidth="1.3" strokeLinejoin="round"
        />

        {/* MINDANAO */}
        <path filter="url(#landShadow)"
          d="M161,308 L170,302 L182,298 L194,296 L206,298
             L218,303 L228,309 L236,317 L240,327 L238,337
             L232,345 L224,351 L216,355 L207,357 L196,357
             L185,355 L174,351 L165,345 L158,337 L154,327
             L155,317 Z"
          fill="url(#landGrad)" stroke="rgba(255,255,255,0.26)" strokeWidth="0.85" strokeLinejoin="round"
        />
        {/* Mindanao ridge */}
        <path d="M175,309 L195,319 L210,331 L220,346"
          fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth="1.3" strokeLinecap="round" />

        {/* Topographic texture and simplified primary road corridors. */}
        <g opacity="0.48" style={{ pointerEvents: 'none' }}>
          <path d="M127,24 L157,22 L169,47 L174,84 L176,113 L158,166 L143,187 L122,171 L108,121 L106,79 Z" fill="url(#terrainContours)" />
          <path d="M161,309 L194,297 L226,308 L239,327 L222,350 L187,355 L160,338 Z" fill="url(#terrainContours)" />
          <path d="M127,24 L157,22 L169,47 L174,84 L176,113 L158,166 L143,187 L122,171 L108,121 L106,79 Z" fill="url(#terrainGrain)" />
          <path d="M161,309 L194,297 L226,308 L239,327 L222,350 L187,355 L160,338 Z" fill="url(#terrainGrain)" />
        </g>
        <g fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }}>
          <g stroke="rgba(255,244,189,0.72)" strokeWidth="1.15">
            <path d="M148,100 L150,115 L140,125 L148,145" />
            <path d="M150,115 L160,130 L148,145" />
            <path d="M150,115 L160,106 L165,91" />
            <path d="M193,281 L176,276 L164,270 L146,245 L132,239" />
            <path d="M193,281 L199,259 L204,228 L207,216" />
          </g>
          <g stroke="rgba(9,63,96,0.72)" strokeWidth="0.8">
            <path d="M144,39 Q151,70 142,96 Q137,123 150,158" />
            <path d="M199,307 Q203,326 222,340" />
          </g>
          <g stroke="rgba(255,255,255,0.32)" strokeWidth="0.45" strokeDasharray="1.4 1.4">
            <path d="M142,51 L165,67 L157,92 L168,119" />
            <path d="M122,158 L142,168 L151,181" />
            <path d="M171,257 L175,280" />
          </g>
        </g>
        {/* â”€â”€ Dynamic shipping route: Bohol â†” selected pin â”€â”€ */}
        {/* Default faint route when nothing selected */}
        {!selectedPin && (
          <path d="M148,146 Q132,202 193,277"
            fill="none" stroke="rgba(74,222,128,0.22)" strokeWidth="0.8"
            strokeDasharray="3 5" strokeLinecap="round"
          />
        )}
        {/* Active route to selected pin */}
        {selectedPin && (
          <>
            <path
              d={buildRoute(BOHOL, selectedPin)}
              fill="none" stroke="#4ade80" strokeWidth="1.4"
              strokeDasharray="4 5" opacity="0.75" strokeLinecap="round"
            />
            <polygon
              points={buildArrow(BOHOL, selectedPin)}
              fill="#4ade80" opacity="0.85"
            />
          </>
        )}

        {/* â”€â”€ Sea labels â”€â”€ */}
        <g className="about-map-detail" fontFamily="Inter,sans-serif" fontStyle="italic" fill="rgba(255,255,255,0.28)" fontSize="6" fontWeight="600" letterSpacing="1.5">
          <text x="17" y="150" transform="rotate(-90 17 150)">WEST PHILIPPINE SEA</text>
          <text x="216" y="80">PHILIPPINE</text>
          <text x="224" y="88">SEA</text>
          <text x="62"  y="342">SULU SEA</text>
          <text x="112" y="248">VISAYAN SEA</text>
        </g>

        {/* â”€â”€ Island labels â”€â”€ */}
        <g fontFamily="Inter,sans-serif" fill="rgba(255,255,255,0.62)" fontWeight="700" letterSpacing="1.3">
          <text x="128" y="79"  fontSize="7.5">LUZON</text>
          <text x="148" y="265" fontSize="6">VISAYAS</text>
          <text x="183" y="332" fontSize="7.5">MINDANAO</text>
        </g>

        {/* Familiar city labels turn the coverage illustration into a readable map. */}
        <g fontFamily="Inter,sans-serif" fontSize="5.6" fontWeight="700" fill="#f8fbff" filter="url(#labelShadow)" style={{ pointerEvents: 'none' }}>
          <text x="154" y="110">BULACAN</text>
          <text x="155" y="121">MANILA</text>
          <text x="116" y="131">CAVITE</text>
          <text x="164" y="137">LAGUNA</text>
          <text x="151" y="151">BATANGAS</text>
          <text x="202" y="286" fill="#d9ffe5">BOHOL</text>
        </g>
        {/* â”€â”€ Compass Rose â”€â”€ */}
        <g className="about-map-detail" transform="translate(30, 360)">
          <circle cx="0" cy="0" r="15" fill="rgba(0,0,0,0.38)" stroke="rgba(255,255,255,0.28)" strokeWidth="0.8"/>
          <circle cx="0" cy="0" r="10" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5"/>
          {[0,45,90,135,180,225,270,315].map(a => (
            <line key={a}
              x1={Math.sin(a*Math.PI/180)*10}  y1={-Math.cos(a*Math.PI/180)*10}
              x2={Math.sin(a*Math.PI/180)*14}  y2={-Math.cos(a*Math.PI/180)*14}
              stroke="rgba(255,255,255,0.38)" strokeWidth={a % 90 === 0 ? 0.9 : 0.4}
            />
          ))}
          <path d="M 0,-16 L 3,-4 L 0,-1 L -3,-4 Z" fill="#22c55e" />
          <path d="M 0,16  L 2.5,4 L 0,1 L -2.5,4 Z"  fill="rgba(255,255,255,0.32)" />
          <path d="M 16,0  L 4,2.5  L 1,0  L 4,-2.5 Z"  fill="rgba(255,255,255,0.32)" />
          <path d="M -16,0 L -4,-2.5 L -1,0 L -4,2.5 Z" fill="rgba(255,255,255,0.32)" />
          <text x="-2.5" y="-18" fontSize="6.5" fontWeight="900" fill="#22c55e" fontFamily="Inter,sans-serif">N</text>
        </g>

        {/* â”€â”€ Legend box â”€â”€ */}
        <g transform="translate(183,14)">
          <rect x="0" y="0" width="88" height="54" rx="7" fill="rgba(0,0,0,0.48)" stroke="rgba(255,255,255,0.14)" strokeWidth="0.8"/>
          <text x="8" y="12" fill="rgba(255,255,255,0.68)" fontSize="5.5" fontWeight="800" fontFamily="Inter,sans-serif" letterSpacing="0.8">COVERAGE KEY</text>
          <line x1="8" y1="16" x2="80" y2="16" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5"/>
          <circle cx="14" cy="25" r="3"   fill="#22c55e"/>
          <circle cx="14" cy="25" r="1.2" fill="#fff"/>
          <text x="22" y="28" fill="rgba(255,255,255,0.62)" fontSize="5" fontFamily="Inter,sans-serif" fontWeight="600">Origin hub</text>
          <circle cx="14" cy="37" r="2.5" fill="#4ade80" stroke="#fff" strokeWidth="0.5"/>
          <text x="22" y="40" fill="rgba(255,255,255,0.62)" fontSize="5" fontFamily="Inter,sans-serif" fontWeight="600">Service destination</text>
          <line x1="10" y1="49" x2="18" y2="49" stroke="#22c55e" strokeWidth="1.2" strokeDasharray="2 2"/>
          <text x="22" y="52" fill="rgba(255,255,255,0.62)" fontSize="5" fontFamily="Inter,sans-serif" fontWeight="600">Transit Route</text>
        </g>

        {/* â”€â”€ Interactive Pins â”€â”€ */}
        {mapPins.map(pin => {
          const matchedDbRegion = coverage.find(r => r.name.toLowerCase().includes(pin.name.toLowerCase()));
          if (!matchedDbRegion) return null;
          const isSelected = selectedRegionId === matchedDbRegion.id;
          const isHovered  = hoveredPin === pin.name;
          const active     = isSelected || isHovered;
          return (
            <g key={pin.name}
              onClick={() => onSelectRegion(isSelected ? null : matchedDbRegion.id)}
              onMouseEnter={() => setHoveredPin(pin.name)}
              onMouseLeave={() => setHoveredPin(null)}
              style={{ cursor: 'pointer' }}
            >
              {active && (
                <motion.circle cx={pin.x} cy={pin.y}
                  initial={{ r: 6, opacity: 0.7 }}
                  animate={{ r: 20, opacity: 0 }}
                  transition={{ repeat: Infinity, duration: 1.6, ease: 'easeOut' }}
                  fill="#22c55e"
                />
              )}
              <circle cx={pin.x} cy={pin.y}
                r={active ? 7 : 5}
                fill={pin.isOrigin ? '#22c55e' : active ? '#22c55e' : 'rgba(74,222,128,0.88)'}
                stroke="#fff" strokeWidth="1.6"
                style={{ transition: 'all 0.25s ease' }}
                filter={active ? 'url(#pinGlow)' : undefined}
              />
              <circle cx={pin.x} cy={pin.y} r="2" fill="#fff" />
            </g>
          );
        })}
      </svg>

      <div style={{ position: 'absolute', top: 14, left: 14, display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'rgba(4, 20, 37, 0.74)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 9, backdropFilter: 'blur(10px)', color: '#fff', fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.05em', zIndex: 2 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 9px #4ade80' }} /> COVERAGE EXPLORER
      </div>
      <div style={{ position: 'absolute', right: 12, bottom: 12, padding: '5px 7px', background: 'rgba(4, 20, 37, 0.6)', borderRadius: 5, color: 'rgba(255,255,255,0.6)', fontSize: '0.56rem', letterSpacing: '0.03em', zIndex: 2 }}>
        Illustrative Philippine coverage map · Select a hub for route details
      </div>
      {/* Floating Tooltip */}
      <AnimatePresence>
        {(hoveredPin || selectedRegionId) && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            style={{
              position: 'absolute', bottom: 12, left: 12, right: 12,
              background: 'rgba(5,18,38,0.85)', backdropFilter: 'blur(14px)',
              border: '1px solid rgba(74,222,128,0.28)',
              borderRadius: 14, padding: '10px 14px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'center', gap: 10, zIndex: 10
            }}
          >
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px #22c55e', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: '#fff' }}>
                {hoveredPin || mapPins.find(p => coverage.find(r => r.name.toLowerCase().includes(p.name.toLowerCase()))?.id === selectedRegionId)?.name}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
                {hoveredPin
                  ? mapPins.find(p => p.name === hoveredPin)?.details
                  : mapPins.find(p => coverage.find(r => r.name.toLowerCase().includes(p.name.toLowerCase()))?.id === selectedRegionId)?.details}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// â”€â”€â”€ Animated Counter Component â”€â”€â”€
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

// â”€â”€â”€ Loading Skeleton â”€â”€â”€
const LoadingSkeleton = () => (
  <div style={{ minHeight: '100vh', background: 'var(--bg-gradient, var(--bg))', fontFamily: 'Inter, system-ui, sans-serif' }}>
    {/* Skeleton Hero */}
    <div style={{ height: '70vh', background: 'var(--bg-secondary)', position: 'relative', overflow: 'hidden' }}>
      <div className="about-skeleton" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: '0 24px' }}>
        <div className="about-skeleton about-skeleton-text" style={{ width: 180, height: 28 }} />
        <div className="about-skeleton about-skeleton-title" style={{ width: '60%', maxWidth: 500, height: 48 }} />
        <div className="about-skeleton about-skeleton-text" style={{ width: '40%', maxWidth: 300 }} />
      </div>
    </div>
    {/* Skeleton Stats */}
    <div style={{ maxWidth: 1100, margin: '-30px auto 0', padding: '0 20px' }}>
      <div className="about-skeleton about-skeleton-block" style={{ height: 100 }} />
    </div>
    {/* Skeleton Content */}
    <div style={{ maxWidth: 1200, margin: '80px auto 0', padding: '0 20px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48, marginBottom: 80 }}>
        <div>
          <div className="about-skeleton about-skeleton-title" style={{ width: '80%' }} />
          <div className="about-skeleton about-skeleton-text" style={{ width: '100%' }} />
          <div className="about-skeleton about-skeleton-text" style={{ width: '90%' }} />
          <div className="about-skeleton about-skeleton-text" style={{ width: '95%' }} />
          <div className="about-skeleton about-skeleton-text" style={{ width: '70%' }} />
        </div>
        <div className="about-skeleton about-skeleton-card" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
        {[1, 2, 3].map(i => <div key={i} className="about-skeleton about-skeleton-card" />)}
      </div>
    </div>
  </div>
);

// â”€â”€â”€ Section anchor IDs and labels â”€â”€â”€
const SECTIONS = [
  { id: 'hero', label: 'Home' },
  { id: 'story', label: 'Our Story' },
  { id: 'features', label: 'Features' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'highlights', label: 'Gallery' },
  { id: 'feedback', label: 'Reviews' },
  { id: 'contact', label: 'Contact' },
];

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MAIN ABOUT PAGE COMPONENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const AboutPage = () => {
  usePageTitle('About Us');
  const toast = useToast();
  
  const [scrolled, setScrolled] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [activeSection, setActiveSection] = useState('hero');
  const [form, setForm] = useState({ name: '', phone: '', message: '' });
  const [loading, setLoading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [selectedRegionId, setSelectedRegionId] = useState(null);
  const [selectedRating, setSelectedRating] = useState('all');
  
  const { scrollY } = useScroll();
  const yHero = useTransform(scrollY, [0, 600], [0, 200]);
  const opacityHero = useTransform(scrollY, [0, 450], [1, 0.2]);
  
  const [data, setData] = useState({
    info: null, features: [], highlights: [], coverage: [], feedback: []
  });
  const [fetching, setFetching] = useState(true);

  // â”€â”€â”€ Scroll handling (scroll progress, active section, back-to-top) â”€â”€â”€
  useEffect(() => {
    const handleScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 50);
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

  // â”€â”€â”€ Data loading â”€â”€â”€
  useEffect(() => {
    const loadData = async () => {
      try {
        setFetching(true);
        const [info, highlights, coverage, feedback] = await Promise.all([
          getCompanyInformation(), getFeaturedDeliveries(),
          getCoverageAreas(), getPublicFeedback()
        ]);
        const features = info?.features || [];

        // Resolve highlight photos
        const resolvedHighlights = await Promise.all(highlights.map(async (h) => {
          const path = h.featured_image_type === 'delivery' && h.delivery_photos?.length > 0
            ? h.delivery_photos[0]
            : h.pickup_photos?.length > 0
              ? h.pickup_photos[0]
              : null;
          if (!path) return { ...h, resolved_image: null };
          try {
            const urls = await resolvePhotoUrls([path]);
            return { ...h, resolved_image: urls[0] };
          } catch (e) {
            return { ...h, resolved_image: null };
          }
        }));

        // Resolve feedback photos if associated order is featured
        const resolvedFeedback = await Promise.all(feedback.map(async (fb) => {
          const order = fb.orders;
          if (!order || !order.featured_on_website) return { ...fb, resolved_image: null };
          const path = order.featured_image_type === 'delivery' && order.delivery_photos?.length > 0
            ? order.delivery_photos[0]
            : order.pickup_photos?.length > 0
              ? order.pickup_photos[0]
              : null;
          if (!path) return { ...fb, resolved_image: null };
          try {
            const urls = await resolvePhotoUrls([path]);
            return { ...fb, resolved_image: urls[0] };
          } catch (e) {
            return { ...fb, resolved_image: null };
          }
        }));

        setData({ info, features, highlights: resolvedHighlights.filter(h => h.resolved_image), coverage, feedback: resolvedFeedback });
      } catch (err) {
        console.error('Failed to load company info', err);
      } finally {
        setFetching(false);
      }
    };
    loadData();
  }, []);

  // â”€â”€â”€ Form handlers â”€â”€â”€
  const handlePhone = (e) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 11);
    setForm(p => ({ ...p, phone: val }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Name is required.'); return; }
    if (!form.phone || !form.phone.startsWith('09') || form.phone.length !== 11) {
      toast.error('Phone must be exactly 11 digits and start with 09.'); return;
    }
    if (!form.message.trim()) { toast.error('Message is required.'); return; }

    setLoading(true);
    try {
      await createContactInquiry({ name: form.name.trim(), phone: form.phone, message: form.message.trim() });
      toast.success('Message sent! We will contact you soon.');
      setForm({ name: '', phone: '', message: '' });
    } catch (err) {
      toast.error(err.message || 'Failed to send message. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // â”€â”€â”€ Lightbox navigation â”€â”€â”€
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

  // â”€â”€â”€ Section scroll helper â”€â”€â”€
  const scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const { info, features, highlights, coverage, feedback } = data;

  // Filter feedback by rating state
  const filteredFeedback = feedback?.filter(fb => {
    if (selectedRating === 'all') return true;
    return fb.rating === parseInt(selectedRating, 10);
  }) || [];

  // â”€â”€â”€ Loading state â”€â”€â”€
  if (fetching) return <LoadingSkeleton />;

  const companyName = info?.name || 'CargoExpress PH';
  const heroImage = info?.hero_image_url || 'https://images.unsplash.com/photo-1586528116311-ad8ed3891db8?auto=format&fit=crop&q=80&w=2000';

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
    <div className="public-about-page" style={{ background: 'var(--bg-gradient, var(--bg))', color: 'var(--text)', minHeight: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* â• â• â•  Scroll Progress Bar â• â• â•  */}
      <div className="about-scroll-progress" style={{ width: `${scrollProgress}%` }} />

      {/* â• â• â•  1. Navigation â• â• â•  */}
      <nav className={`about-glass-nav ${scrolled ? 'scrolled' : ''}`}>
        <div className="about-nav-container">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Container size={24} style={{ color: scrolled ? 'var(--primary)' : '#fff', transition: 'color 0.3s' }} />
            <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 900, letterSpacing: '-0.5px', display: 'flex', gap: 2 }}>
              <span style={{ color: scrolled ? 'var(--text)' : '#fff', transition: 'color 0.3s' }}>CARGO</span>
              <span style={{ color: scrolled ? 'var(--primary)' : 'var(--primary-light)', transition: 'color 0.3s' }}>EXPRESS</span>
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
            <span className="about-hide-mobile">Go Back to </span>Login <ChevronRight size={16} />
          </Link>
        </div>
      </nav>

      {/* â•â•â• 2. Hero Section â•â•â• */}
      <section id="hero" className="about-hero">
        <motion.div 
          style={{ 
            position: 'absolute', inset: 0,
            backgroundImage: `url(${heroImage})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            y: yHero,
            opacity: opacityHero,
            zIndex: 1
          }}
        />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.75) 100%)', zIndex: 2 }} />
        
        {/* Decorative gradient orbs */}
        <div className="about-gradient-orb" style={{ width: 400, height: 400, top: '10%', left: '-5%', background: 'rgba(var(--primary-rgb), 0.08)', zIndex: 3 }} />
        <div className="about-gradient-orb" style={{ width: 300, height: 300, bottom: '15%', right: '-3%', background: 'rgba(var(--accent-rgb), 0.06)', zIndex: 3 }} />

        <motion.div 
          className="about-hero-content"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="about-hero-badge">
            Trusted Logistics Partner
          </div>
          <h2 style={{ fontSize: 'clamp(2.25rem, 5vw, 4rem)', fontWeight: 800, color: '#fff', lineHeight: 1.1, marginBottom: 24, letterSpacing: '-2px' }}>
            {info?.hero_title || 'Deliveries Made Simple.'}
          </h2>
          <p style={{ fontSize: 'clamp(1rem, 2vw, 1.25rem)', color: 'rgba(255,255,255,0.9)', lineHeight: 1.6, maxWidth: 700, margin: '0 auto 40px' }}>
            {info?.hero_description || info?.short_description || 'Connecting businesses and families through reliable logistics.'}
          </p>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="#contact" className="about-hero-cta-primary">
              Contact Us <Send size={18} />
            </a>
            {info?.hero_button_text && info?.hero_button_link && (
              <Link to={info.hero_button_link} className="about-hero-cta-secondary">
                {info.hero_button_text}
              </Link>
            )}
          </div>
        </motion.div>

        {/* Scroll Down Indicator */}
        <button className="about-scroll-hint" onClick={() => scrollToSection('story')} aria-label="Scroll down">
          <ChevronDown size={28} />
        </button>

      </section>

      {/* â•â•â• Main Content â•â•â• */}
      <div className="about-content-wrapper">

        {/* â•â•â• 4. Our Story â•â•â• */}
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
              <h2 style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 800, marginBottom: 24, letterSpacing: '-1px' }}>
                About <span className="about-text-gradient">CargoExpress PH</span>.
              </h2>
              <p style={{ fontSize: '1.125rem', color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
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
            <div className="about-story-image-container" style={{ position: 'relative' }}>
              {/* Decorative dot pattern */}
              <div className="about-dot-pattern" style={{ top: -20, right: -10 }} />
              <div className="about-dot-pattern" style={{ bottom: 0, left: -15 }} />
              
              <div style={{ position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(45deg, rgba(var(--primary-rgb),0.1), rgba(var(--accent-rgb),0.1))', borderRadius: '50%', filter: 'blur(40px)', transform: 'scale(0.8)' }} />
                <img 
                  src={heroImage} 
                  alt={`${companyName} Logistics`} 
                  className="about-story-main-img"
                  loading="lazy"
                />
                <img 
                  src={heroImage} 
                  alt={`${companyName} Delivery`} 
                  className="about-story-overlay-img"
                  loading="lazy"
                />
              </div>
            </div>
          </div>
        </motion.section>

        {/* â•â•â• 5. Features Grid â•â•â• */}
        {features?.length > 0 && (
          <motion.section 
            id="features"
            className="about-section"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
          >
            <div style={{ textAlign: 'center', marginBottom: 48 }}>
              <div className="about-section-label">Why Choose Us</div>
              <h2 className="about-section-title">The CargoExpress Advantage</h2>
            </div>
            
            <motion.div 
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 24 }}
              variants={containerVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-80px" }}
            >
              {features.map((f, i) => {
                const Icon = LucideIcons[f.icon] || LucideIcons.Star;
                const isHero = i === 0;
                return (
                  <motion.div 
                    key={f.id} 
                    className={`about-bento-card ${isHero ? 'about-feature-hero' : ''}`}
                    variants={itemVariants}
                  >
                    <div className="about-feature-icon">
                      <Icon size={28} />
                    </div>
                    <div>
                      <h3 style={{ fontSize: isHero ? '1.5rem' : '1.25rem', fontWeight: 800, marginBottom: 12, color: 'var(--text)' }}>{f.title}</h3>
                      <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, fontSize: '0.9375rem' }}>{f.description}</p>
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          </motion.section>
        )}

        {/* â•â•â• 6. Coverage Areas â•â•â• */}
        {coverage?.length > 0 && (
          <motion.section 
            id="coverage"
            className="about-section"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
          >
            <div className="about-bento-card" style={{ padding: '40px 24px' }}>
              <div className="about-coverage-grid">
                <div>
                  <div style={{ width: 56, height: 56, borderRadius: 20, background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24 }}>
                    <MapPin size={28} />
                  </div>
                  <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', fontWeight: 800, letterSpacing: '-1px', marginBottom: 16 }}>Where We Deliver</h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: 16 }}>Explore the destinations we serve from Bohol. Select a destination on the map or a coverage card to preview its route.</p>
                  
                  <InteractiveMap 
                    coverage={coverage} 
                    selectedRegionId={selectedRegionId} 
                    onSelectRegion={setSelectedRegionId} 
                  />
                </div>
                
                <div className="about-coverage-regions">
                  {coverage.map((region) => {
                    const isSelected = selectedRegionId === region.id;
                    return (
                      <div 
                        key={region.id} 
                        className={`about-region-card ${isSelected ? 'selected' : ''}`}
                        onClick={() => setSelectedRegionId(isSelected ? null : region.id)}
                      >
                        <h4 style={{ fontSize: '1.125rem', fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                          <MapPin size={18} style={{ color: isSelected ? 'var(--primary)' : 'var(--text-tertiary)', transition: 'color 0.2s' }} /> {region.name}
                        </h4>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {region.municipalities?.map(muni => (
                            <div key={muni.id} className="about-muni-tag">
                              {muni.name}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </motion.section>
        )}

        {/* â•â•â• 7. Delivery Highlights Gallery â•â•â• */}
        {highlights?.length > 0 && (
          <motion.section 
            id="highlights"
            className="about-section"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
          >
            <div style={{ textAlign: 'center', marginBottom: 48 }}>
              <div className="about-section-label">Delivery Highlights</div>
              <h2 className="about-section-title">Featured Shipments</h2>
            </div>
            
            <motion.div 
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 24 }}
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
                  <img src={highlight.resolved_image} alt={highlight.featured_title || 'Delivery photo'} loading="lazy" />
                  <div className="about-highlight-overlay">
                    <div className="about-highlight-title">
                      ðŸ“¦ {highlight.featured_title}
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
          </motion.section>
        )}

        {/* â•â•â• 8. Customer Feedback â•â•â• */}
        <motion.section 
          id="feedback"
          className="about-section"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
        >
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
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
            <div style={{ textAlign: 'center', padding: '48px', background: 'var(--surface)', borderRadius: 24, border: '1px solid var(--border-light)' }}>
              <MessageSquare size={48} style={{ color: 'var(--text-tertiary)', marginBottom: 16 }} />
              <div style={{ fontSize: '1.125rem', fontWeight: 600, color: 'var(--text-secondary)' }}>No customer feedback has been submitted yet.</div>
            </div>
          ) : filteredFeedback.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', background: 'var(--surface)', borderRadius: 24, border: '1px solid var(--border-light)' }}>
              <MessageSquare size={48} style={{ color: 'var(--text-tertiary)', marginBottom: 16 }} />
              <div style={{ fontSize: '1.125rem', fontWeight: 600, color: 'var(--text-secondary)' }}>No {selectedRating}-star reviews found.</div>
            </div>
          ) : (
            <motion.div 
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 24 }}
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
                      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
                        {[1, 2, 3, 4, 5].map(star => (
                          <svg key={star} width="20" height="20" viewBox="0 0 24 24" fill={star <= fb.rating ? "var(--warning)" : "var(--border)"} stroke="none">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                          </svg>
                        ))}
                      </div>
                      <p style={{ fontSize: isHero ? '1.15rem' : '1.05rem', lineHeight: 1.7, color: 'var(--text)', marginBottom: 24, fontStyle: 'italic', position: 'relative', zIndex: 1 }}>"{fb.message}"</p>
                      
                      {fb.resolved_image && (
                        <div style={{ marginBottom: 24, borderRadius: 16, overflow: 'hidden', height: isHero ? 200 : 160 }}>
                          <img src={fb.resolved_image} alt="Delivery Proof" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        </div>
                      )}

                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'linear-gradient(135deg, rgba(var(--primary-rgb), 0.15), rgba(var(--primary-rgb), 0.05))', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '1.1rem' }}>
                          {firstName[0].toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.9375rem', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)' }}>
                            {'\u2014'} {firstName}
                          </div>
                          {fb.orders?.receiver_city && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: 2 }}>
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

        {/* â•â•â• 9. Contact Section â•â•â• */}
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
                <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', fontWeight: 800, letterSpacing: '-1px', marginBottom: 16 }}>Get in Touch.</h2>
                <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: 32 }}>
                  Have questions about our services? Need a quote? Our team is ready to assist you 24/7.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  {(info?.smart_phone || info?.globe_phone) && (
                    <div className="about-contact-block">
                      <div className="about-contact-icon-box"><Phone size={20} /></div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: 4 }}>Call Us</div>
                        <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.9375rem', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                        <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: 4 }}>Email Us</div>
                        <a href={`mailto:${info.email}`} className="about-contact-link">{info.email}</a>
                      </div>
                    </div>
                  )}

                  {(info?.manila_address || info?.bohol_address) && (
                    <div className="about-contact-block">
                      <div className="about-contact-icon-box"><MapPin size={20} /></div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: 4 }}>Visit Our Hubs</div>
                        <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.9375rem', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {info.manila_address && <div><strong>Manila:</strong> {info.manila_address}</div>}
                          {info.bohol_address && <div><strong>Bohol:</strong> {info.bohol_address}</div>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Form */}
              <div className="about-contact-form">
                <h3 style={{ fontSize: 'clamp(1.35rem, 3vw, 1.75rem)', fontWeight: 800, marginBottom: 24, color: 'var(--text)' }}>Send a Message</h3>
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div>
                    <label htmlFor="contact-name" style={{ display: 'block', fontWeight: 700, fontSize: '0.875rem', marginBottom: 8, color: 'var(--text-secondary)' }}>Full Name</label>
                    <input 
                      id="contact-name"
                      className="about-premium-input"
                      placeholder="Juan Dela Cruz" 
                      value={form.name} 
                      onChange={e => setForm(p => ({ ...p, name: e.target.value }))} 
                      required 
                    />
                  </div>
                  <div>
                    <label htmlFor="contact-phone" style={{ display: 'block', fontWeight: 700, fontSize: '0.875rem', marginBottom: 8, color: 'var(--text-secondary)' }}>Mobile Number</label>
                    <input 
                      id="contact-phone"
                      className="about-premium-input"
                      placeholder="09XXXXXXXXX" 
                      inputMode="numeric" 
                      maxLength={11} 
                      value={form.phone} 
                      onChange={handlePhone} 
                      required 
                    />
                  </div>
                  <div>
                    <label htmlFor="contact-message" style={{ display: 'block', fontWeight: 700, fontSize: '0.875rem', marginBottom: 8, color: 'var(--text-secondary)' }}>Message</label>
                    <textarea 
                      id="contact-message"
                      style={{ minHeight: 120, resize: 'vertical' }}
                      className="about-premium-input"
                      placeholder="How can we help you?" 
                      value={form.message} 
                      onChange={e => setForm(p => ({ ...p, message: e.target.value }))} 
                      required 
                    />
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

      {/* â•â•â• Wave Divider â•â•â• */}
      <div className="about-wave-divider">
        <svg viewBox="0 0 1440 100" preserveAspectRatio="none" style={{ fill: '#0a0a0a' }}>
          <path d="M0,40 C320,100 440,0 720,50 C1000,100 1120,10 1440,60 L1440,100 L0,100 Z" />
        </svg>
      </div>
      
      {/* â•â•â• 10. Footer â•â•â• */}
      <footer className="about-footer">
        <div className="about-footer-grid">
          {/* Brand Column */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <Container size={24} style={{ color: 'var(--primary)' }} />
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 900, letterSpacing: '-0.3px' }}>{companyName}</h3>
            </div>
            <p style={{ color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, fontSize: '0.9375rem', marginBottom: 24 }}>
              {info?.short_description || 'Reliable logistics and cargo delivery services across the Philippines.'}
            </p>
            {/* Social Media */}
            <div style={{ display: 'flex', gap: 12 }}>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Link to="/track" className="about-footer-link">Track Your Order</Link>
              <Link to="/login" className="about-footer-link">Customer Portal</Link>
              <a href="#features" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('features'); }}>Our Services</a>
              <a href="#coverage" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('coverage'); }}>Coverage Areas</a>
            </div>
          </div>

          {/* Company */}
          <div>
            <h4 className="about-footer-heading">Company</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <a href="#story" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('story'); }}>About Us</a>
              <a href="#feedback" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('feedback'); }}>Customer Reviews</a>
              <a href="#highlights" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('highlights'); }}>Gallery</a>
              <a href="#contact" className="about-footer-link" onClick={(e) => { e.preventDefault(); scrollToSection('contact'); }}>Contact Us</a>
            </div>
          </div>
        </div>

        <div className="about-footer-bottom">
          <span>&copy; {new Date().getFullYear()} {companyName}. All rights reserved.</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--primary)' }}>{'\u25CF'}</span> System Online
          </span>
        </div>
      </footer>

      {/* â•â•â• Lightbox â•â•â• */}
      {lightboxIndex >= 0 && (
        <Lightbox 
          images={lightboxImages} 
          currentIndex={lightboxIndex} 
          onClose={() => setLightboxIndex(-1)} 
          onNavigate={handleLightboxNavigate} 
        />
      )}

      {/* â•â•â• Back to Top â•â•â• */}
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

