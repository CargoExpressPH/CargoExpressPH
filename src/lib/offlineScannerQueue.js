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
const DB_VERSION = 3;
const STORE_MANIFESTS = 'trip_manifests';
const STORE_EVENTS = 'scan_events';
const STORE_TRIP_DETAILS = 'trip_details';
const STORE_POD_EVENTS = 'pod_events';
const STORE_ORDERS = 'orders_cache';

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

/** MD5('pod_' + order_id + '_' + trip_id) */
export const podEventKey = ({ orderId, tripId }) => (
  md5(`pod_${orderId}_${tripId}`)
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
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|offline|network offline/.test(text);
};

// ── Storage backend ─────────────────────────────────────────────────────────
const memory = {
  [STORE_MANIFESTS]: new Map(),
  [STORE_EVENTS]: new Map(),
  [STORE_TRIP_DETAILS]: new Map(),
  [STORE_POD_EVENTS]: new Map(),
  [STORE_ORDERS]: new Map(),
};
const keyPathOf = {
  [STORE_MANIFESTS]: 'trip_id',
  [STORE_EVENTS]: 'idempotency_key',
  [STORE_TRIP_DETAILS]: 'trip_id',
  [STORE_POD_EVENTS]: 'idempotency_key',
  [STORE_ORDERS]: 'id',
};

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
      if (!db.objectStoreNames.contains(STORE_TRIP_DETAILS)) {
        db.createObjectStore(STORE_TRIP_DETAILS, { keyPath: 'trip_id' });
      }
      if (!db.objectStoreNames.contains(STORE_POD_EVENTS)) {
        const pods = db.createObjectStore(STORE_POD_EVENTS, { keyPath: 'idempotency_key' });
        pods.createIndex('trip_id', 'trip_id', { unique: false });
        pods.createIndex('order_id', 'order_id', { unique: false });
        pods.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ORDERS)) {
        const orders = db.createObjectStore(STORE_ORDERS, { keyPath: 'id' });
        orders.createIndex('tracking_number', 'tracking_number', { unique: false });
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
export const saveTripManifest = (tripId, orders) => {
  if (Array.isArray(orders)) {
    orders.forEach((o) => {
      saveCachedOrder(o).catch(() => {});
    });
  }
  return putRecord(STORE_MANIFESTS, {
    trip_id: tripId,
    saved_at: new Date().toISOString(),
    orders: Array.isArray(orders) ? orders : [],
  });
};

export const getTripManifest = (tripId) => getRecord(STORE_MANIFESTS, tripId);

// ── Trip details cache (for TripDetailPage offline viewing) ─────────────────
export const saveCachedTripDetail = (tripId, data) => {
  if (data?.orders && Array.isArray(data.orders)) {
    data.orders.forEach((o) => {
      saveCachedOrder(o).catch(() => {});
    });
    // Keep STORE_MANIFESTS in sync so manifest queries also have the orders
    putRecord(STORE_MANIFESTS, {
      trip_id: tripId,
      saved_at: new Date().toISOString(),
      orders: data.orders,
    }).catch(() => {});
  }
  return putRecord(STORE_TRIP_DETAILS, {
    trip_id: tripId,
    saved_at: new Date().toISOString(),
    data,
  });
};

export const getCachedTripDetail = async (tripId) => {
  const record = await getRecord(STORE_TRIP_DETAILS, tripId);
  if (!record?.data) return null;
  // If manifest has fresher orders or locally verified boxes, merge them into the trip orders
  const manifest = await getRecord(STORE_MANIFESTS, tripId);
  if (manifest?.orders?.length && Array.isArray(record.data.orders)) {
    const manifestOrderMap = new Map(manifest.orders.map((o) => [o.id, o]));
    record.data.orders = record.data.orders.map((order) => {
      const fresh = manifestOrderMap.get(order.id);
      return fresh ? { ...order, ...fresh } : order;
    });
  }
  return record.data;
};

export const saveCachedTripsList = (trips) => putRecord(STORE_TRIP_DETAILS, {
  trip_id: '__trips_list__',
  saved_at: new Date().toISOString(),
  data: trips,
});

export const getCachedTripsList = async () => {
  const record = await getRecord(STORE_TRIP_DETAILS, '__trips_list__');
  return record?.data || [];
};

// ── Orders list cache (for AdminOrdersPage offline hydration) ───────────────
// Uses synthetic keys inside STORE_ORDERS so no DB version bump is needed.
// Keys look like "__orders_list__:All:1:15" — never conflict with real UUIDs.
const ordersListKey = (tab, page, perPage) =>
  `__orders_list__:${tab}:${page}:${perPage}`;

export const saveCachedOrdersList = (tab, page, perPage, data, count) =>
  putRecord(STORE_ORDERS, {
    id: ordersListKey(tab, page, perPage),
    _is_list_cache: true,
    _saved_at: new Date().toISOString(),
    _data: data,
    _count: count,
  });

export const getCachedOrdersList = async (tab, page, perPage) => {
  const record = await getRecord(STORE_ORDERS, ordersListKey(tab, page, perPage));
  if (!record?._is_list_cache) return null;
  return { data: record._data || [], count: record._count || 0 };
};

// ── Order details cache (for OrderDetailPage & QrScannerModal offline use) ──
export const saveCachedOrder = async (order) => {
  if (!order || !order.id) return null;
  return putRecord(STORE_ORDERS, {
    ...order,
    _saved_at: new Date().toISOString(),
  });
};

export const getCachedOrder = async (idOrTracking) => {
  if (!idOrTracking) return null;
  const direct = await getRecord(STORE_ORDERS, idOrTracking);
  if (direct) return direct;

  const all = await allRecords(STORE_ORDERS);
  const matched = all.find((o) => o.id === idOrTracking || o.tracking_number === idOrTracking);
  if (matched) return matched;

  // Fallback 1: check trip_manifests
  const manifests = await allRecords(STORE_MANIFESTS);
  for (const m of manifests) {
    if (Array.isArray(m.orders)) {
      const found = m.orders.find((o) => o.id === idOrTracking || o.tracking_number === idOrTracking);
      if (found) {
        saveCachedOrder(found).catch(() => {});
        return found;
      }
    }
  }

  // Fallback 2: check trip_details
  const tripDetails = await allRecords(STORE_TRIP_DETAILS);
  for (const td of tripDetails) {
    if (Array.isArray(td.data?.orders)) {
      const found = td.data.orders.find((o) => o.id === idOrTracking || o.tracking_number === idOrTracking);
      if (found) {
        saveCachedOrder(found).catch(() => {});
        return found;
      }
    }
  }

  return null;
};

const deleteRecord = (storeName, key) => withStore(storeName, 'readwrite', (store) => {
  if (!store) { memory[storeName].delete(key); return true; }
  return requestToPromise(store.delete(key)).then(() => true);
});

export const deleteCachedOrder = (orderId) => {
  if (!orderId) return Promise.resolve(false);
  return deleteRecord(STORE_ORDERS, orderId);
};

export const deleteCachedTrip = async (tripId) => {
  if (!tripId) return;
  await deleteRecord(STORE_TRIP_DETAILS, tripId);
  await deleteRecord(STORE_MANIFESTS, tripId);
};

// ── Cache Garbage Collection / Lifecycle Purging ───────────────────────────
/**
 * Purges delivered orders and completed trips from IndexedDB cache so storage
 * does not bloat over time.
 * 
 * Safety Rules:
 * 1. An order or trip is NEVER deleted if it still has pending offline scans or PODs.
 * 2. Only terminal records ('Delivered', 'Cancelled', 'completed') that are confirmed
 *    synced or already settled online are evicted.
 * 3. Synced events older than 7 days are also pruned.
 */
export const purgeCompletedCache = async () => {
  try {
    const allScans = await allRecords(STORE_EVENTS);
    const allPods = await allRecords(STORE_POD_EVENTS);
    const pendingOrderIds = new Set();
    const pendingTripIds = new Set();

    for (const e of allScans) {
      if (e.status === SCAN_STATUS.PENDING) {
        if (e.order_id) pendingOrderIds.add(e.order_id);
        if (e.trip_id) pendingTripIds.add(e.trip_id);
      }
    }
    for (const e of allPods) {
      if (e.status === SCAN_STATUS.PENDING) {
        if (e.order_id) pendingOrderIds.add(e.order_id);
        if (e.trip_id) pendingTripIds.add(e.trip_id);
      }
    }

    // 1. Purge delivered or cancelled orders with no pending offline actions
    const allOrders = await allRecords(STORE_ORDERS);
    for (const order of allOrders) {
      if (order._is_list_cache) continue; // Keep list cache pagination blobs
      const isTerminal = order.status === 'Delivered' || order.status === 'Cancelled';
      if (isTerminal && !pendingOrderIds.has(order.id)) {
        await deleteCachedOrder(order.id);
      }
    }

    // 2. Purge completed or cancelled trips with no pending offline actions
    const allTrips = await allRecords(STORE_TRIP_DETAILS);
    for (const record of allTrips) {
      if (record.trip_id === '__trips_list__') continue;
      const tripStatus = record.data?.trip?.status || record.data?.status;
      const isTerminal = tripStatus === 'completed' || tripStatus === 'cancelled';
      if (isTerminal && !pendingTripIds.has(record.trip_id)) {
        await deleteCachedTrip(record.trip_id);
      }
    }

    // 3. Clean up synced events older than 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const scan of allScans) {
      if (scan.status === SCAN_STATUS.SYNCED && scan.synced_at) {
        if (new Date(scan.synced_at).getTime() < sevenDaysAgo) {
          await deleteRecord(STORE_EVENTS, scan.idempotency_key);
        }
      }
    }
    for (const pod of allPods) {
      if (pod.status === SCAN_STATUS.SYNCED && pod.synced_at) {
        if (new Date(pod.synced_at).getTime() < sevenDaysAgo) {
          await deleteRecord(STORE_POD_EVENTS, pod.idempotency_key);
        }
      }
    }
  } catch (err) {
    console.debug('[purgeCompletedCache] Cache cleanup skipped on error:', err);
  }
};

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

/** Records a scan that could not reach the server yet. `extra` carries the manual method/reason so they survive the wait. */
export const queueScanEvent = (scan, extra = {}) => saveEvent(scan, SCAN_STATUS.PENDING, extra);

/** Records a scan the server already accepted, so a re-scan is caught instantly. */
export const recordSyncedScan = (scan) => saveEvent(scan, SCAN_STATUS.SYNCED, {
  synced_at: new Date().toISOString(),
});

export const countPendingScans = async (tripId) => (await listScanEvents(tripId, SCAN_STATUS.PENDING)).length;

// ── Proof of Delivery (POD) queue ───────────────────────────────────────────
export const getPodEvent = (key) => getRecord(STORE_POD_EVENTS, key);

export const listPodEvents = async (tripId = null, status = null) => {
  const events = await allRecords(STORE_POD_EVENTS);
  return events
    .filter((event) => (!tripId || event.trip_id === tripId) && (!status || event.status === status))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
};

export const queuePodEvent = ({ orderId, tripId, trackingNumber = '', deliveryData }) => {
  const key = podEventKey({ orderId, tripId });
  return putRecord(STORE_POD_EVENTS, {
    idempotency_key: key,
    order_id: orderId,
    trip_id: tripId,
    tracking_number: trackingNumber,
    delivery_data: deliveryData,
    status: SCAN_STATUS.PENDING,
    created_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
  });
};

export const countPendingPods = async (tripId) => (
  await listPodEvents(tripId, SCAN_STATUS.PENDING)
).length;

export const countTotalPending = async (tripId) => (
  (await countPendingScans(tripId)) + (await countPendingPods(tripId))
);

/** Total pending scan events + POD events across ALL trips. Used by global sync indicator. */
export const countAllPending = async () => {
  const [events, pods] = await Promise.all([
    allRecords(STORE_EVENTS),
    allRecords(STORE_POD_EVENTS),
  ]);
  return (
    events.filter((e) => e.status === SCAN_STATUS.PENDING).length +
    pods.filter((e) => e.status === SCAN_STATUS.PENDING).length
  );
};

// ── Offline photo converters ────────────────────────────────────────────────
export const fileToOfflinePhoto = (file) => new Promise((resolve) => {
  if (!file) { resolve(null); return; }
  const reader = new FileReader();
  reader.onload = () => {
    resolve({
      dataUrl: reader.result,
      name: file.name || 'photo.jpg',
      type: file.type || 'image/jpeg',
      size: file.size,
    });
  };
  reader.onerror = () => resolve(null);
  reader.readAsDataURL(file);
});

export const offlinePhotoToFile = (photoObj) => {
  if (!photoObj) return null;
  if (typeof File !== 'undefined' && photoObj instanceof File) return photoObj;
  if (typeof Blob !== 'undefined' && photoObj instanceof Blob) return photoObj;
  if (!photoObj.dataUrl) return null;
  try {
    const arr = photoObj.dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || photoObj.type || 'image/jpeg';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], photoObj.name || 'delivery-proof.jpg', { type: mime });
  } catch {
    return null;
  }
};

/** Replays a queued POD event when online, uploading offline photos to Storage first. */
export const sendQueuedPod = async (podEvent) => {
  const { order_id, delivery_data, tracking_number } = podEvent;
  const payload = { ...delivery_data };

  // If there are offline photos that need uploading to Supabase Storage:
  if (payload._offlinePhotos && payload._offlinePhotos.length > 0) {
    const files = payload._offlinePhotos.map(offlinePhotoToFile).filter(Boolean);
    if (files.length > 0) {
      const { uploadMultiplePhotos } = await import('./storage.js');
      const photoUrls = await uploadMultiplePhotos(
        files,
        'delivery-proofs',
        tracking_number || 'DELIVERY',
        null,
        order_id
      );
      payload.delivery_photos = photoUrls;
    }
    delete payload._offlinePhotos;
  }

  // If there is an offline receipt that needs uploading:
  if (payload._offlineReceipt) {
    const file = offlinePhotoToFile(payload._offlineReceipt);
    if (file) {
      const { uploadPhoto } = await import('./storage.js');
      const { serializePhotoReference } = await import('./photoReference.js');
      const rResult = await uploadPhoto(
        file,
        'receipts',
        tracking_number || 'RECEIPT',
        1,
        order_id
      );
      const receiptUrl = serializePhotoReference(rResult);
      if (payload.payment) {
        payload.payment.receipt_url = receiptUrl;
      }
    }
    delete payload._offlineReceipt;
  }

  delete payload._isOffline;

  const { recordDeliveryPayment } = await import('./database.js');
  return recordDeliveryPayment(order_id, payload);
};

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

let podFlushing = null;

/**
 * Sends pending PODs oldest-first, one at a time, through `sendPod(event)`.
 * Stops at the first network failure (the rest stay pending).
 */
export const flushPendingPods = (sendPod, { tripId = null } = {}) => {
  if (podFlushing) return podFlushing;
  podFlushing = (async () => {
    const summary = { synced: [], failed: [], remaining: 0 };
    const all = await allRecords(STORE_POD_EVENTS);
    const pending = all
      .filter((event) => event.status === SCAN_STATUS.PENDING && (!tripId || event.trip_id === tripId))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    for (let i = 0; i < pending.length; i += 1) {
      const event = pending[i];
      try {
        await sendPod(event);
        const done = { ...event, status: SCAN_STATUS.SYNCED, synced_at: new Date().toISOString(), last_error: null };
        await putRecord(STORE_POD_EVENTS, done);
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
        await putRecord(STORE_POD_EVENTS, failed);
        summary.failed.push(failed);
      }
    }
    return summary;
  })().finally(() => { podFlushing = null; });
  return podFlushing;
};

/**
 * Flushes the queue whenever the browser reports connectivity again, and once
 * right away if it is already online (covers a reload with scans left over).
 * Returns the cleanup function.
 */
export const startOnlineSync = (send, onFlushed, { tripId = null, sendPod = null } = {}) => {
  const run = async () => {
    try {
      const scanSummary = await flushPendingScans(send, { tripId });
      let podSummary = null;
      if (sendPod) {
        podSummary = await flushPendingPods(sendPod, { tripId });
      }
      if (
        scanSummary.synced.length || scanSummary.failed.length ||
        (podSummary && (podSummary.synced.length || podSummary.failed.length))
      ) {
        onFlushed?.({ scans: scanSummary, pods: podSummary });
      }
      // Purge delivered orders and completed trips now that sync has processed
      purgeCompletedCache().catch(() => {});
    } catch {
      /* storage failure: events stay queued for the next attempt */
    }
  };
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', run);
  if (navigator.onLine !== false) run();
  return () => window.removeEventListener('online', run);
};
