import { getTrips, getTripById, getOrders } from './database';
import { purgeCompletedCache } from './offlineScannerQueue';

let isPreloading = false;
let lastPreloadTime = 0;
const MIN_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes debounce

/**
 * Automatically downloads and caches active trips, manifests, and bookings
 * into IndexedDB in the background while online.
 * 
 * This ensures that when an admin, rider, or customer goes offline,
 * they DO NOT have to have manually clicked on trips or bookings beforehand —
 * everything is already present in their local offline database.
 */
export const preloadOfflineData = async ({ role = 'admin', userId = null, force = false } = {}) => {
  // Never attempt background network fetches if offline
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const now = Date.now();
  if (isPreloading) return;
  if (!force && (now - lastPreloadTime) < MIN_INTERVAL_MS) return;

  isPreloading = true;
  lastPreloadTime = now;

  try {
    // Run after browser finishes higher priority tasks
    const scheduleTask = typeof window !== 'undefined' && window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 3000 })
      : (cb) => setTimeout(cb, 500);

    await new Promise((resolve) => {
      scheduleTask(async () => {
        try {
          await doPreload({ role, userId });
        } catch (err) {
          console.debug('[offlinePreload] Background preloading error:', err);
        } finally {
          resolve();
        }
      });
    });
  } catch (err) {
    console.debug('[offlinePreload] Failed to run preloader:', err);
  } finally {
    isPreloading = false;
  }
};

const doPreload = async ({ role, userId }) => {
  // 1. Preload Trips and Manifests
  try {
    const trips = await getTrips();
    if (Array.isArray(trips) && trips.length > 0) {
      // Prioritize active trips ('scheduled', 'in_progress', 'arrived') and recent completed ones
      const activeTrips = trips.filter((t) => ['scheduled', 'in_progress', 'arrived'].includes(t.status));
      const recentTrips = trips.slice(0, 5);

      // Deduplicate trip IDs
      const tripIdsToFetch = Array.from(new Set([...activeTrips, ...recentTrips].map((t) => t.id)));

      // Fetch details and manifests for these trips (up to 10 in background)
      for (const tripId of tripIdsToFetch.slice(0, 10)) {
        try {
          // getTripById automatically fetches gate records, load weight, and all orders on the trip,
          // saving both the trip detail, the trip manifest, and each individual order into IndexedDB.
          await getTripById(tripId);
        } catch (tripErr) {
          console.debug(`[offlinePreload] Silent skip prefetch trip ${tripId}:`, tripErr);
        }
      }
    }
  } catch (tripsErr) {
    console.debug('[offlinePreload] Failed to prefetch trips list:', tripsErr);
  }

  // 2. Preload Orders (Bookings)
  if (role === 'admin') {
    try {
      // Fetch Page 1 of All orders (top 50) - automatically cached and each row cached
      await getOrders(null, true, { page: 1, perPage: 50 });

      // Fetch active orders (non-completed/non-cancelled) so riders have all current assignments cached
      const activeStatuses = ['Pending', 'Assigned', 'Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery'];
      await getOrders(null, true, { page: 1, perPage: 50, statusFilter: activeStatuses });
    } catch (ordersErr) {
      console.debug('[offlinePreload] Failed to prefetch admin orders:', ordersErr);
    }
  } else if (userId) {
    try {
      // Fetch customer's own orders
      await getOrders(userId, false);
    } catch (custErr) {
      console.debug('[offlinePreload] Failed to prefetch customer orders:', custErr);
    }
  }

  // 3. Purge completed trips and delivered bookings from cache so local storage stays lean
  try {
    await purgeCompletedCache();
  } catch (purgeErr) {
    console.debug('[offlinePreload] Purge cache skipped on error:', purgeErr);
  }
};
