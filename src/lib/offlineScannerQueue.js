// Offline-first storage for the trip cargo scanner.
//
// Two IndexedDB stores:
//  - trip_manifests  one cached manifest per trip, so the scanner keeps
//                    resolving labels when the van has no signal
//  - scan_events     every box scan, keyed by an idempotency key, with a queue
//                    status of 'pending' | 'synced' | 'failed'
//
// The server stays the authority: record_box_verification() is idempotent, so
// replaying a queued scan is always safe. The key exists so the UI can say
// "already scanned at 10:42" instantly, without a round trip.
//
// If IndexedDB is unavailable (private windows, blocked storage) the same API
// runs against in-memory maps, so the scanner never throws because of it.

import { md5 } from '../utils/md5.js';

const DB_NAME = 'cargoexpress-scanner';
const DB_VERSION = 1;
const STORE_MANIFESTS = 'trip_manifests';
const STORE_EVENTS = 'scan_events';

export const SCAN_EVENT_TYPES = {
  LOAD_VERIFY: 'load_verify',
  DELIVERY_VERIFY: 'delivery_verify',
};

export const SCAN_STATUS = {
  PENDING: 'pending',
  SYNCED: 'synced',
  FAILED: 'failed',
};

/** MD5(order_id + '_' + box_number + '_' + event_type + '_' + trip_id) */
export const scanEventKey = ({ orderId, box, eventType, tripId }) => (
  md5(`${orderId}_${box}_${eventType}_${tripId}`)
);

/** 'HH:MM' in the device's local time, for "Already scanned at 10:42". */
export const formatScanTime = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** True when a failed call never reached the server (as opposed to being rejected by it). */
export const isNetworkError = (error) => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const text = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|offline/.test(text);
};

// ── Storage backend ─────────────────────────────────────────────────────────
const memory = {
  [STORE_MANIFESTS]: new Map(),
  [STORE_EVENTS]: new Map(),
};
const keyPathOf = { [STORE_MANIFESTS]: 'trip_id', [STORE_EVENTS]: 'idempotency_key' };

let dbPromise = null;

const openDb = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_MANIFESTS)) {
        db.createObjectStore(STORE_MANIFESTS, { keyPath: 'trip_id' });
      }
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const events = db.createObjectStore(STORE_EVENTS, { keyPath: 'idempotency_key' });
        events.createIndex('trip_id', 'trip_id', { unique: false });
        events.createIndex('status', 'status', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
};

const withStore = async (storeName, mode, run) => {
  const db = await openDb();
  if (!db) return run(null);
  return new Promise((resolve, reject) => {
    let result;
    try {
      const tx = db.transaction(storeName, mode);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      Promise.resolve(run(tx.objectStore(storeName))).then((value) => { result = value; }, reject);
    } catch (error) {
      reject(error);
    }
  });
};

const requestToPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const putRecord = (storeName, record) => withStore(storeName, 'readwrite', (store) => {
  if (!store) { memory[storeName].set(record[keyPathOf[storeName]], record); return record; }
  return requestToPromise(store.put(record)).then(() => record);
});

const getRecord = (storeName, key) => withStore(storeName, 'readonly', (store) => {
  if (!store) return memory[storeName].get(key) || null;
  return requestToPromise(store.get(key)).then((value) => value || null);
});

const allRecords = (storeName) => withStore(storeName, 'readonly', (store) => {
  if (!store) return Array.from(memory[storeName].values());
  return requestToPromise(store.getAll());
});

// ── Trip manifests ──────────────────────────────────────────────────────────
export const saveTripManifest = (tripId, orders) => putRecord(STORE_MANIFESTS, {
  trip_id: tripId,
  saved_at: new Date().toISOString(),
  orders: Array.isArray(orders) ? orders : [],
});

export const getTripManifest = (tripId) => getRecord(STORE_MANIFESTS, tripId);

// ── Scan events ─────────────────────────────────────────────────────────────
export const getScanEvent = (key) => getRecord(STORE_EVENTS, key);

export const listScanEvents = async (tripId, status = null) => {
  const events = await allRecords(STORE_EVENTS);
  return events
    .filter((event) => event.trip_id === tripId && (!status || event.status === status))
    .sort((a, b) => String(a.scanned_at).localeCompare(String(b.scanned_at)));
};

/**
 * The earlier scan of this exact box on this trip, if one is still live.
 * A 'failed' event does not count, so the box can be scanned again.
 */
export const findDuplicateScan = async ({ orderId, box, eventType, tripId }) => {
  const existing = await getScanEvent(scanEventKey({ orderId, box, eventType, tripId }));
  return existing && existing.status !== SCAN_STATUS.FAILED ? existing : null;
};

const saveEvent = ({ orderId, box, eventType, tripId }, status, extra = {}) => {
  const key = scanEventKey({ orderId, box, eventType, tripId });
  return putRecord(STORE_EVENTS, {
    idempotency_key: key,
    trip_id: tripId,
    order_id: orderId,
    box_number: box,
    event_type: eventType,
    status,
    scanned_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
    ...extra,
  });
};

/** Records a scan that could not reach the server yet. */
export const queueScanEvent = (scan) => saveEvent(scan, SCAN_STATUS.PENDING);

/** Records a scan the server already accepted, so a re-scan is caught instantly. */
export const recordSyncedScan = (scan) => saveEvent(scan, SCAN_STATUS.SYNCED, {
  synced_at: new Date().toISOString(),
});

export const countPendingScans = async (tripId) => (await listScanEvents(tripId, SCAN_STATUS.PENDING)).length;

// ── Sync ────────────────────────────────────────────────────────────────────
let flushing = null;

/**
 * Sends pending scans oldest-first, one at a time, through `send(event)`.
 * Stops at the first network failure (the rest stay pending); a scan the
 * server rejects is marked 'failed' with its message and the queue moves on.
 * Concurrent calls share one run.
 */
export const flushPendingScans = (send, { tripId = null } = {}) => {
  if (flushing) return flushing;
  flushing = (async () => {
    const summary = { synced: [], failed: [], remaining: 0 };
    const all = await allRecords(STORE_EVENTS);
    const pending = all
      .filter((event) => event.status === SCAN_STATUS.PENDING && (!tripId || event.trip_id === tripId))
      .sort((a, b) => String(a.scanned_at).localeCompare(String(b.scanned_at)));

    for (let i = 0; i < pending.length; i += 1) {
      const event = pending[i];
      try {
        await send(event);
        const done = { ...event, status: SCAN_STATUS.SYNCED, synced_at: new Date().toISOString(), last_error: null };
        await putRecord(STORE_EVENTS, done);
        summary.synced.push(done);
      } catch (error) {
        if (isNetworkError(error)) {
          summary.remaining = pending.length - i;
          break;
        }
        const failed = {
          ...event,
          status: SCAN_STATUS.FAILED,
          attempts: (event.attempts || 0) + 1,
          last_error: error?.message || 'Rejected by the server',
        };
        await putRecord(STORE_EVENTS, failed);
        summary.failed.push(failed);
      }
    }
    return summary;
  })().finally(() => { flushing = null; });
  return flushing;
};

/**
 * Flushes the queue whenever the browser reports connectivity again, and once
 * right away if it is already online (covers a reload with scans left over).
 * Returns the cleanup function.
 */
export const startOnlineSync = (send, onFlushed, { tripId = null } = {}) => {
  const run = () => {
    flushPendingScans(send, { tripId })
      .then((summary) => { if (summary.synced.length || summary.failed.length) onFlushed?.(summary); })
      .catch(() => { /* storage failure: events stay queued for the next attempt */ });
  };
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', run);
  if (navigator.onLine !== false) run();
  return () => window.removeEventListener('online', run);
};
