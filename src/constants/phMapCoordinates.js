// Stable geographic anchors for the service regions shown on the About page.
// Coverage data currently stores names and municipalities, not coordinates, so
// these visual map anchors stay separate from the editable coverage content.
export const PHILIPPINES_MAP_CENTER = [12.2, 122.1];
export const PHILIPPINES_MAP_ZOOM = 5;
// Padded bounds keep the full Philippine service area visible while
// preventing the map camera from drifting to the rest of the world.
export const PHILIPPINES_MAP_BOUNDS = [
  [4.2, 116.5],
  [21.5, 127.5],
];

export const PHILIPPINES_MAP_REGIONS = [
  {
    name: 'Metro Manila',
    aliases: ['metro manila', 'manila'],
    position: [14.5995, 120.9842],
    details: 'Manila Hub (Sea Freight Terminal)',
  },
  {
    name: 'Bulacan',
    aliases: ['bulacan'],
    position: [14.7942, 120.8799],
    details: 'Bulacan Distribution Network',
  },
  {
    name: 'Cavite',
    aliases: ['cavite'],
    position: [14.4791, 120.897],
    details: 'Cavite Logistics Center',
  },
  {
    name: 'Laguna',
    aliases: ['laguna'],
    position: [14.2691, 121.4113],
    details: 'Laguna Delivery Hub',
  },
  {
    name: 'Batangas',
    aliases: ['batangas'],
    position: [13.7565, 121.0583],
    details: 'Batangas Shipping Hub',
  },
  {
    name: 'Bohol',
    aliases: ['bohol'],
    position: [9.647, 123.855],
    details: 'Bohol Distribution Terminal',
    isOrigin: true,
  },
];
