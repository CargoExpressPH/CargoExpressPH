/* -----------------------------------------------------------------------
   generate-barangays.mjs — regenerates src/constants/phBarangays.js
   from the PSGC API (https://psgc.gitlab.io/api), the same source
   src/constants/phLocations.js already cites for provinces and cities.

   Run manually, NOT as part of the build:

       node scripts/generate-barangays.mjs

   The output is committed. The forms must work offline and on a slow
   connection — that is the whole reason the barangay list is a static file
   rather than a fetch — so nothing in `npm run build` may depend on this
   script or on the network.

   Re-run it only when PSGC publishes a change (a barangay split, a
   municipality becoming a city) or when a city is added to PH_LOCATIONS.
   Cities are matched by NAME within their province, so a city present in
   PH_LOCATIONS that PSGC does not know under that name is reported as
   UNMATCHED and left out — the script fails loudly rather than writing a
   file with silent holes in it.
   ----------------------------------------------------------------------- */

import { writeFileSync } from 'node:fs';
import { PH_LOCATIONS } from '../src/constants/phLocations.js';

const API = 'https://psgc.gitlab.io/api';
const NCR_REGION_CODE = '130000000';

const getJson = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
};

/**
 * PSGC spells cities differently from the way people type them: "City of
 * Lipa" vs "Lipa", "Las Piñas City" vs "Las Piñas". Normalising both sides
 * to a bare, unaccented, lowercase name is what makes the match work
 * without a hand-maintained alias table.
 *
 * "Quezon City" and "Cotabato City" keep their suffix in normal use, but
 * dropping it on BOTH sides keeps them consistent — nothing else in either
 * province normalises to "quezon".
 */
const normalize = (name) =>
  name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // ñ → n
    .toLowerCase()
    .replace(/^city of\s+/, '')
    .replace(/\s+city$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Cities PSGC spells differently from the way this app (and the PSA's own
 * plain-language lists) spell them. Keyed and valued in NORMALISED form.
 *
 * Each is a real divergence, not a typo on our side:
 *   • Batangas' Santo Tomas became a city and PSGC abbreviates it "Sto."
 *   • Bulacan's town of Bulakan is spelled "Bulacan" by PSGC — identical to
 *     the province containing it, which is exactly why the lookup is scoped
 *     by province code rather than by name.
 *   • Cavite's General Mariano Alvarez is abbreviated "Gen." by PSGC.
 */
const CITY_ALIASES = new Map([
  ['santo tomas', 'sto tomas'],
  ['bulakan', 'bulacan'],
  ['general mariano alvarez', 'gen mariano alvarez'],
]);

// Small concurrency pool: 176 cities, one barangay request each. Unbounded
// Promise.all opens 176 sockets at once and the API starts refusing them.
const mapWithConcurrency = async (items, limit, fn) => {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
};

const main = async () => {
  console.log('Fetching PSGC provinces and cities/municipalities…');
  const [provinces, cities] = await Promise.all([
    getJson(`${API}/provinces/`),
    getJson(`${API}/cities-municipalities/`),
  ]);

  const provinceCodeByName = new Map(provinces.map(p => [normalize(p.name), p.code]));

  // Index PSGC cities by "<province scope>|<normalised name>". Scoping by
  // province is not cosmetic: San Juan exists both as a Batangas
  // municipality and as a Metro Manila city, and an unscoped name lookup
  // would give one of them the other's barangays.
  const cityIndex = new Map();
  for (const c of cities) {
    const scope = c.regionCode === NCR_REGION_CODE ? 'ncr' : (c.provinceCode || 'none');
    cityIndex.set(`${scope}|${normalize(c.name)}`, c);
  }

  const targets = [];
  const unmatched = [];
  for (const [province, cityNames] of Object.entries(PH_LOCATIONS)) {
    const scope = normalize(province) === 'metro manila'
      ? 'ncr'
      : provinceCodeByName.get(normalize(province));
    if (!scope) { unmatched.push(`${province} (province not found in PSGC)`); continue; }
    for (const city of cityNames) {
      const key = normalize(city);
      const match = cityIndex.get(`${scope}|${key}`)
        || (CITY_ALIASES.has(key) ? cityIndex.get(`${scope}|${CITY_ALIASES.get(key)}`) : undefined);
      if (!match) { unmatched.push(`${province} → ${city}`); continue; }
      targets.push({ province, city, code: match.code });
    }
  }

  if (unmatched.length) {
    console.error('\nUNMATCHED — these are in PH_LOCATIONS but not in PSGC under that name:');
    unmatched.forEach(u => console.error(`  • ${u}`));
    console.error('\nRefusing to write a partial file. Fix the name in PH_LOCATIONS or add an alias above.');
    process.exit(1);
  }

  console.log(`Fetching barangays for ${targets.length} cities/municipalities…`);
  const results = await mapWithConcurrency(targets, 8, async (t) => ({
    ...t,
    barangays: (await getJson(`${API}/cities-municipalities/${t.code}/barangays/`))
      .map(b => b.name)
      .sort((a, b) => a.localeCompare(b, 'en')),
  }));

  const empty = results.filter(r => r.barangays.length === 0);
  if (empty.length) {
    console.error('\nNo barangays returned for:', empty.map(e => `${e.province} → ${e.city}`).join(', '));
    process.exit(1);
  }

  const byProvince = {};
  for (const r of results) {
    (byProvince[r.province] ||= {})[r.city] = r.barangays;
  }

  const total = results.reduce((n, r) => n + r.barangays.length, 0);
  const generated = new Date().toISOString().slice(0, 10);

  const body = Object.keys(byProvince).sort().map(province => {
    const cityEntries = Object.keys(byProvince[province]).sort().map(city => {
      const list = byProvince[province][city].map(b => `      ${JSON.stringify(b)},`).join('\n');
      return `    ${JSON.stringify(city)}: [\n${list}\n    ],`;
    }).join('\n');
    return `  ${JSON.stringify(province)}: {\n${cityEntries}\n  },`;
  }).join('\n');

  const file = `/* eslint-disable */
// ============================================================================
// GENERATED FILE — do not edit by hand.
//
// Regenerate with:  node scripts/generate-barangays.mjs
//
// Source: PSGC API (https://psgc.gitlab.io/api), the same Philippine Standard
// Geographic Code dataset src/constants/phLocations.js cites for its provinces
// and cities.
//
// Generated: ${generated}
// Covers: ${results.length} cities/municipalities, ${total} barangays.
//
// Static on purpose. The booking and profile forms are used on phones on
// intermittent connections, and an address field that cannot be filled until a
// network round trip returns is an address field that blocks a booking. This
// file ships in the bundle so the dropdown is populated the moment the city is
// chosen, offline included.
// ============================================================================

export const PH_BARANGAYS = {
${body}
};

/**
 * Barangays for a province/city pair, always an array.
 *
 * Returns [] — never null — for an unknown pair, so callers can map over the
 * result without a guard. An empty list is also the honest answer for a city
 * that is not in our service area: there is nothing to choose from, and the
 * form falls back to letting the customer type it.
 */
export const getBarangays = (province, city) => {
  if (!province || !city) return [];
  return PH_BARANGAYS[province]?.[city] || [];
};

/**
 * True when we hold a barangay list for this city. Callers use it to decide
 * between a <select> and a free-text input, rather than rendering an empty
 * dropdown the customer cannot get past.
 */
export const hasBarangays = (province, city) => getBarangays(province, city).length > 0;

/**
 * True when \`barangay\` is a name we know for that city. An empty barangay
 * passes — "not filled in yet" is not the same as "wrong" — matching how
 * isValidProvinceCity treats empty province/city.
 */
export const isValidBarangay = (province, city, barangay) => {
  if (!barangay) return true;
  const list = getBarangays(province, city);
  if (list.length === 0) return true;
  return list.includes(barangay);
};
`;

  writeFileSync('src/constants/phBarangays.js', file);
  console.log(`\nWrote src/constants/phBarangays.js — ${results.length} cities, ${total} barangays.`);
};

main().catch(err => { console.error(err); process.exit(1); });
