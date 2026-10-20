// Contract test for the offline scanner queue: MD5 idempotency keys, duplicate
// detection, and the sequential, network-aware flush. Node has no IndexedDB,
// so this exercises the in-memory fallback — the same code path the browser
// takes when storage is blocked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { md5 } from '../src/utils/md5.js';
import {
  SCAN_EVENT_TYPES, SCAN_STATUS, countPendingScans, findDuplicateScan, flushPendingScans,
  formatScanTime, getTripManifest, isNetworkError, listScanEvents, queueScanEvent,
  recordSyncedScan, saveTripManifest, scanEventKey,
} from '../src/lib/offlineScannerQueue.js';

// ── MD5 matches the reference implementation ────────────────────────────────
for (const sample of ['', 'a', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'é'.repeat(40)]) {
  assert.equal(md5(sample), createHash('md5').update(sample).digest('hex'));
}

// ── Idempotency key: MD5(order_id _ box _ event_type _ trip_id) ─────────────
const base = { orderId: 'o-1', box: 2, eventType: SCAN_EVENT_TYPES.LOAD_VERIFY, tripId: 't-1' };
assert.equal(scanEventKey(base), createHash('md5').update('o-1_2_load_verify_t-1').digest('hex'));
assert.notEqual(scanEventKey(base), scanEventKey({ ...base, box: 3 }));
assert.notEqual(
  scanEventKey(base),
  scanEventKey({ ...base, eventType: SCAN_EVENT_TYPES.DELIVERY_VERIFY }),
  'a loading scan must not block the doorstep re-scan',
);

// ── Manifest cache ──────────────────────────────────────────────────────────
assert.equal(await getTripManifest('t-1'), null);
await saveTripManifest('t-1', [{ id: 'o-1' }]);
assert.deepEqual((await getTripManifest('t-1')).orders, [{ id: 'o-1' }]);

// ── Duplicates ──────────────────────────────────────────────────────────────
assert.equal(await findDuplicateScan(base), null);
await queueScanEvent(base);
assert.equal((await findDuplicateScan(base)).status, SCAN_STATUS.PENDING);
assert.equal(await countPendingScans('t-1'), 1);
assert.match(formatScanTime(new Date().toISOString()), /^\d{2}:\d{2}$/);
assert.equal(formatScanTime('not a date'), '');

// ── Flush: sequential, oldest first, stops on a network error ───────────────
await queueScanEvent({ ...base, box: 3 });
await queueScanEvent({ ...base, box: 4 });
const sent = [];
let summary = await flushPendingScans(async (event) => {
  sent.push(event.box_number);
  if (event.box_number === 3) throw new Error('Failed to fetch');
});
assert.deepEqual(sent, [2, 3], 'stops at the first network failure, never skipping ahead');
assert.equal(summary.synced.length, 1);
assert.equal(summary.remaining, 2);
assert.equal(await countPendingScans('t-1'), 2);

// A server rejection is recorded and the queue keeps going.
sent.length = 0;
summary = await flushPendingScans(async (event) => {
  sent.push(event.box_number);
  if (event.box_number === 3) throw new Error('Box 3 does not belong to this booking');
});
assert.deepEqual(sent, [3, 4]);
assert.equal(summary.failed.length, 1);
assert.equal(summary.failed[0].last_error, 'Box 3 does not belong to this booking');
assert.equal(await countPendingScans('t-1'), 0);
assert.equal(await findDuplicateScan({ ...base, box: 3 }), null, 'a failed scan may be scanned again');
assert.equal((await findDuplicateScan(base)).status, SCAN_STATUS.SYNCED);

// Concurrent flushes share one run (no double sends).
await queueScanEvent({ ...base, box: 5 });
let calls = 0;
const slow = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); };
await Promise.all([flushPendingScans(slow), flushPendingScans(slow)]);
assert.equal(calls, 1);

await recordSyncedScan({ ...base, box: 9 });
assert.equal((await listScanEvents('t-1', SCAN_STATUS.SYNCED)).some((e) => e.box_number === 9), true);

// ── Network error detection ─────────────────────────────────────────────────
assert.equal(isNetworkError(new TypeError('Failed to fetch')), true);
assert.equal(isNetworkError(new Error('Box 3 does not belong to this booking')), false);

// ── Static wiring ───────────────────────────────────────────────────────────
const queueSource = readFileSync(new URL('../src/lib/offlineScannerQueue.js', import.meta.url), 'utf8');
assert.match(queueSource, /trip_manifests/);
assert.match(queueSource, /scan_events/);
assert.match(queueSource, /addEventListener\('online'/);

console.log('Offline scanner queue contract tests passed.');
