import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  AttributionControl,
  MapContainer,
  Marker,
  TileLayer,
  ZoomControl,
  useMap,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './AboutCoverageMap.css';
import {
  PHILIPPINES_MAP_BOUNDS,
  PHILIPPINES_MAP_CENTER,
  PHILIPPINES_MAP_ZOOM,
  getCoverageMapRegion,
} from '../../constants/phMapCoordinates';

// Kept lazy so Leaflet is only downloaded near the coverage section.
const DEFAULT_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_MAP_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CONFIGURED_MAP_TILE_URL = import.meta.env.VITE_MAP_TILE_URL?.trim();
const MAP_TILE_URL = CONFIGURED_MAP_TILE_URL || DEFAULT_MAP_TILE_URL;
const MAP_TILE_ATTRIBUTION = CONFIGURED_MAP_TILE_URL
  ? (import.meta.env.VITE_MAP_TILE_ATTRIBUTION?.trim() || DEFAULT_MAP_TILE_ATTRIBUTION)
  : DEFAULT_MAP_TILE_ATTRIBUTION;

// Keep the marker's DOM stable while it gains focus or hover. Replacing its
// inner HTML between mousedown and mouseup prevents the browser's click.
const MAP_PIN_ICON = L.divIcon({
  className: 'about-leaflet-marker',
  html: '<span class="about-leaflet-marker-shell"><span class="about-leaflet-marker-dot"></span></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

function CoverageViewport({ mappedRegions, selectedRegionId, overviewRevision }) {
  const map = useMap();

  useEffect(() => {
    const updateView = () => {
      map.invalidateSize({ pan: false });
      const selected = mappedRegions.find(({ coverageRegion }) => coverageRegion.id === selectedRegionId);
      if (selected) {
        // Manila-side markers overlap at national scale. Focus the selected
        // area without shifting any marker away from its geographic position.
        map.setView(selected.mapRegion.position, 9, { animate: false });
      } else if (mappedRegions.length) {
        map.fitBounds(mappedRegions.map(({ mapRegion }) => mapRegion.position), {
          paddingTopLeft: [40, 60], paddingBottomRight: [40, 60],
          maxZoom: 8, animate: false,
        });
      }
    };
    updateView();
    // The map column changes size at the About page's responsive breakpoint.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateView);
    observer?.observe(map.getContainer());
    return () => observer?.disconnect();
  }, [map, mappedRegions, selectedRegionId, overviewRevision]);

  return null;
}

function CoverageMarker({ mapRegion, coverageRegion, isSelected, hoveredPin, setHoveredPin, onSelectRegion }) {
  const markerRef = useRef(null);
  const isActive = isSelected || hoveredPin === coverageRegion.id;

  useEffect(() => {
    const element = markerRef.current?.getElement();
    if (!element) return undefined;
    element.setAttribute('aria-label', 'Select ' + coverageRegion.name + ' coverage area');
    element.setAttribute('aria-pressed', String(isSelected));
    element.classList.toggle('is-active', isActive);
    const focus = () => setHoveredPin(coverageRegion.id);
    const blur = () => setHoveredPin(null);
    element.addEventListener('focus', focus);
    element.addEventListener('blur', blur);
    return () => {
      element.removeEventListener('focus', focus);
      element.removeEventListener('blur', blur);
    };
  }, [coverageRegion.id, coverageRegion.name, isActive, isSelected, setHoveredPin]);

  return (
    <Marker
      ref={markerRef}
      position={mapRegion.position}
      icon={MAP_PIN_ICON}
      keyboard
      title={coverageRegion.name + ' · approximate area marker'}
      autoPanOnFocus={false}
      zIndexOffset={isActive ? 1000 : 0}
      eventHandlers={{
        click: () => onSelectRegion(isSelected ? null : coverageRegion.id),
        keydown: (event) => {
          const originalEvent = event.originalEvent;
          if (originalEvent?.key !== 'Enter' && originalEvent?.key !== ' ') return;
          originalEvent.preventDefault();
          if (!originalEvent.repeat) onSelectRegion(isSelected ? null : coverageRegion.id);
        },
        mouseover: () => setHoveredPin(coverageRegion.id),
        mouseout: () => setHoveredPin(null),
      }}
    />
  );
}

export default function InteractiveMap({ coverage = [], selectedRegionId, onSelectRegion }) {
  const [hoveredPin, setHoveredPin] = useState(null);
  const [overviewRevision, setOverviewRevision] = useState(0);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  const mappedRegions = useMemo(() => coverage
    .map(coverageRegion => ({ coverageRegion, mapRegion: getCoverageMapRegion(coverageRegion.name) }))
    .filter(({ mapRegion }) => mapRegion), [coverage]);
  const selected = mappedRegions.find(({ coverageRegion }) => coverageRegion.id === selectedRegionId);
  const tooltipRegion = mappedRegions.find(({ coverageRegion }) => coverageRegion.id === hoveredPin) || selected;

  return (
    <div>
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
            eventHandlers={{
              tileerror: () => setTilesUnavailable(true),
              tileload: () => setTilesUnavailable(false),
            }}
          />
          <AttributionControl prefix={false} position="bottomright" />
          <ZoomControl position="topright" />
          <CoverageViewport mappedRegions={mappedRegions} selectedRegionId={selectedRegionId} overviewRevision={overviewRevision} />
          {mappedRegions.map(({ mapRegion, coverageRegion }) => (
            <CoverageMarker
              key={coverageRegion.id}
              mapRegion={mapRegion}
              coverageRegion={coverageRegion}
              isSelected={selectedRegionId === coverageRegion.id}
              hoveredPin={hoveredPin}
              setHoveredPin={setHoveredPin}
              onSelectRegion={onSelectRegion}
            />
          ))}
        </MapContainer>

        <div className="about-coverage-tag">
          <span className="about-green-dot" /> AREAS
        </div>
        <button
          type="button"
          className="about-map-overview"
          onClick={() => {
            setHoveredPin(null);
            onSelectRegion(null);
            setOverviewRevision(value => value + 1);
          }}
        >Show all areas</button>
        {tilesUnavailable && (
          <div className="about-map-status" role="status">Map background unavailable. Use the coverage cards.</div>
        )}
        <div className="about-map-hint">Select an area card or zoom in to choose a marker.</div>

        {tooltipRegion && (
          <div className="about-map-tooltip" role="status">
            <div className="about-map-tooltip-dot" />
            <div className="about-map-tooltip-body">
              <div className="about-map-tooltip-name">{tooltipRegion.coverageRegion.name}</div>
              <div className="about-map-tooltip-detail">Approximate reference near {tooltipRegion.mapRegion.reference}</div>
            </div>
          </div>
        )}
      </div>
      <p className="about-map-note">Markers show approximate area locations, not company offices or pickup addresses. See the cards for covered cities and municipalities.</p>
      {mappedRegions.length < coverage.length && (
        <p className="about-map-note">Some listed areas have no map marker. Their coverage details are available in the cards.</p>
      )}
    </div>
  );
}
