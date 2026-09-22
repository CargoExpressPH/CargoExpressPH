import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const [{ text: selectorBundle }] = (await build({
  entryPoints: ['src/lib/tripCapacitySelection.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
})).outputFiles;
const { isScheduledTripOverdue, selectEarliestCapacityTrip } = await import(
  `data:text/javascript;base64,${Buffer.from(selectorBundle).toString('base64')}`
);

const trip = (overrides = {}) => ({
  id: 'trip-default',
  trip_number: 'TRIP-100',
  origin: 'Bohol',
  destination: 'Manila',
  departure_date: '2026-09-25T00:00:00+08:00',
  status: 'scheduled',
  created_at: '2026-09-20T00:00:00Z',
  ...overrides,
});

const sep25 = trip({ id: 'sep25', trip_number: 'TRIP-25' });
const sep30 = trip({
  id: 'sep30',
  trip_number: 'TRIP-30',
  departure_date: '2026-09-30T00:00:00+08:00',
  created_at: '2026-09-01T00:00:00Z',
});

assert.equal(selectEarliestCapacityTrip([sep30, sep25]).id, 'sep25',
  'departure order wins even when creation order differs');

const ongoingSep25 = { ...sep25, status: 'in_progress' };
assert.equal(selectEarliestCapacityTrip([sep30, ongoingSep25]).id, 'sep25',
  'a started trip remains selected until completion');
assert.equal(selectEarliestCapacityTrip([
  { ...sep25, status: 'completed' }, sep30,
]).id, 'sep30', 'completion selects the next eligible trip');
assert.equal(selectEarliestCapacityTrip([
  { ...sep25, status: 'cancelled' }, sep30,
]).id, 'sep30', 'cancellation selects the next eligible trip');

const rescheduledSep25 = {
  ...sep25,
  departure_date: '2026-10-02T00:00:00+08:00',
};
assert.equal(selectEarliestCapacityTrip([rescheduledSep25, sep30]).id, 'sep30',
  'selection follows the updated scheduled departure');

const sameDateLaterNumber = trip({ id: 'tie-2', trip_number: 'TRIP-2' });
const sameDateEarlierNumber = trip({ id: 'tie-10', trip_number: 'TRIP-10' });
assert.equal(selectEarliestCapacityTrip([sameDateEarlierNumber, sameDateLaterNumber]).id, 'tie-10',
  'same-day ties are stably resolved by trip number, not input order');
assert.equal(selectEarliestCapacityTrip([
  { ...sameDateLaterNumber, trip_number: 'TRIP-2', id: 'tie-b' },
  { ...sameDateLaterNumber, trip_number: 'TRIP-2', id: 'tie-a' },
]).id, 'tie-a', 'identical trip numbers are stably resolved by id');
assert.equal(selectEarliestCapacityTrip([
  { ...sameDateEarlierNumber, id: 'tie-utc-late', departure_date: '2026-09-24T16:30:00Z' },
  { ...sameDateLaterNumber, id: 'tie-ph-midnight', departure_date: '2026-09-25T00:00:00+08:00' },
]).id, 'tie-utc-late', 'timestamps on the same Manila calendar day use the stable tie-breaker');

const reverseRouteTrip = trip({
  id: 'reverse-route',
  origin: 'Manila',
  destination: 'Bohol',
  departure_date: '2026-09-30T00:00:00+08:00',
});
const selectedRouteTrip = selectEarliestCapacityTrip([reverseRouteTrip, sep25]);
assert.equal(selectedRouteTrip.id, 'sep25');
assert.equal(`${selectedRouteTrip.origin} → ${selectedRouteTrip.destination}`, 'Bohol → Manila',
  'the summary keeps route details attached to the selected trip');

assert.equal(isScheduledTripOverdue(sep25, new Date('2026-09-22T00:00:00+08:00')), false);
assert.equal(isScheduledTripOverdue(trip({ departure_date: '2026-09-21T00:00:00+08:00' }), new Date('2026-09-22T00:00:00+08:00')), true,
  'a past unstarted Manila schedule remains eligible and is marked overdue');
assert.equal(selectEarliestCapacityTrip([
  { ...sep25, departure_date: '2026-09-21T00:00:00+08:00' }, sep30,
]).id, 'sep25', 'overdue scheduled trips do not disappear');

assert.equal(selectEarliestCapacityTrip([
  { ...sep25, status: 'completed' },
  { ...sep30, status: 'cancelled' },
]), null, 'no eligible trip returns a distinct empty result');
assert.equal(selectEarliestCapacityTrip([
  { ...sep25, departure_date: null },
  { ...sep30, status: 'unknown' },
]), null, 'invalid dates and unknown statuses are not selected');

const databaseSource = await readFile(new URL('../src/lib/database.js', import.meta.url), 'utf8');
assert.match(databaseSource, /\.select\('id, trip_number, origin, destination, capacity, price_per_kg, status, departure_date, arrival_date'\)/);
assert.match(databaseSource, /\.order\('departure_date', \{ ascending: true \}\)[\s\S]*?\.order\('trip_number', \{ ascending: true \}\)[\s\S]*?\.order\('id', \{ ascending: true \}\)/,
  'the database result is deterministically ordered before the API row cap');
assert.match(databaseSource, /trip_ids:\s*\[selectedTrip\.id\]/,
  'the existing authoritative load RPC is called for the selected trip only');
assert.match(databaseSource, /get_trips_load/);

const hookSource = await readFile(new URL('../src/hooks/useRealtimeTripCapacity.js', import.meta.url), 'utf8');
for (const expected of [
  "table: 'trips'",
  "table: 'orders'",
  "addEventListener('focus'",
  "addEventListener('online'",
  'REFRESH_POLL_MS',
  'MAX_REFRESH_POLL_MS',
  'clearTimeout(pollTimer)',
  'removeChannel(activeChannel)',
]) assert.ok(hookSource.includes(expected), `Realtime refresh contract includes ${expected}`);

console.log('✓ Trip capacity selection, lifecycle, Manila date, route coherence, authoritative load, and refresh contracts pass.');
