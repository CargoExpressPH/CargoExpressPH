// Representative city/town coordinates for the About page's area selector.
// These are approximate area references, not company facilities, pickup
// addresses, service boundaries, or transport routes. Coverage comes from
// the editable company_information.coverage list, not these coordinates.
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
    reference: 'Manila',
  },
  {
    name: 'Bulacan',
    aliases: ['bulacan'],
    position: [14.7942, 120.8799],
    reference: 'Bulakan',
  },
  {
    name: 'Cavite',
    aliases: ['cavite'],
    position: [14.4791, 120.897],
    reference: 'Cavite City',
  },
  {
    name: 'Laguna',
    aliases: ['laguna'],
    position: [14.2691, 121.4113],
    reference: 'Santa Cruz',
  },
  {
    name: 'Batangas',
    aliases: ['batangas'],
    position: [13.7565, 121.0583],
    reference: 'Batangas City',
  },
  {
    name: 'Bohol',
    aliases: ['bohol'],
    position: [9.647, 123.855],
    reference: 'Tagbilaran City',
  },
];

export const getCoverageMapRegion = (name) => {
  const normalizedName = typeof name === 'string' ? name.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  // Only known area names may acquire a marker; substring matching can put
  // an unrelated/new area at an existing area's coordinates.
  return PHILIPPINES_MAP_REGIONS.find(region => region.aliases.includes(normalizedName)) || null;
};
