import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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

// ─── Interactive coverage map (About page) ───
// Lives in its own file so Leaflet (the map library and its styles) is only
// downloaded when a visitor scrolls near the map; see LazyCoverageMap in
// AboutPage.jsx.

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

export default InteractiveMap;
