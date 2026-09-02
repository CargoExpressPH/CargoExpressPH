import { supabase } from './supabase';

const QUEUE_KEY = 'cargoexpress.activity-log.queue.v1';
const QUEUE_LIMIT = 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

let cachedUser = null;
let flushPromise = null;

const makeEventId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : ((random & 0x3) | 0x8);
    return value.toString(16);
  });
};

const cloneJson = (value) => {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};

const readQueue = () => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - RETENTION_MS;
    return parsed
      .filter(item => item?.eventId && item?.userId && Date.parse(item.occurredAt) >= cutoff)
      .slice(-QUEUE_LIMIT);
  } catch {
    return [];
  }
};

const writeQueue = (queue) => {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_LIMIT)));
    return true;
  } catch {
    return false;
  }
};

const removeQueuedEvent = (eventId) => {
  const queue = readQueue();
  writeQueue(queue.filter(item => item.eventId !== eventId));
};

const resolveUser = async () => {
  if (cachedUser) return cachedUser;
  const { data } = await supabase.auth.getSession();
  cachedUser = data?.session?.user || null;
  return cachedUser;
};

const withRequestTimeout = async (request) => {
  let timer;
  try {
    return await Promise.race([
      request,
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const isPermanentError = (error) => (
  ['22023', '22P02', '23503', '23514', '42501'].includes(error?.code)
);

/**
 * Deliver every queued activity for the current account in order. Each event
 * has a database-enforced idempotency key, so an uncertain retry cannot create
 * a duplicate row.
 */
export const flushActivityLogQueue = async (knownUser = null) => {
  if (flushPromise) return flushPromise;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { delivered: 0, pending: readQueue().length };
  }

  flushPromise = (async () => {
    const user = knownUser || await resolveUser();
    if (!user) return { delivered: 0, pending: readQueue().length };

    let delivered = 0;
    while (true) {
      const item = readQueue().find(entry => entry.userId === user.id);
      if (!item) break;

      const result = await withRequestTimeout(supabase.rpc('record_activity', {
        p_client_event_id: item.eventId,
        p_module: item.module,
        p_action: item.action,
        p_record_type: item.recordType,
        p_record_id: item.recordId,
        p_record_ref: item.recordRef,
        p_previous_value: item.previousValue,
        p_new_value: item.newValue,
        p_details: item.details,
        p_occurred_at: item.occurredAt,
      }));

      if (result?.timedOut) break;
      if (result?.error) {
        if (isPermanentError(result.error)) {
          console.warn('[ActivityLog] Rejected activity event:', result.error.message);
          removeQueuedEvent(item.eventId);
          continue;
        }
        console.warn('[ActivityLog] Activity queued for retry:', result.error.message);
        break;
      }

      removeQueuedEvent(item.eventId);
      delivered += 1;
    }

    return {
      delivered,
      pending: readQueue().filter(item => item.userId === user.id).length,
    };
  })();

  try {
    return await flushPromise;
  } finally {
    flushPromise = null;
  }
};

export const logActivity = async ({
  module,
  action,
  recordType = null,
  recordId = null,
  recordRef = null,
  previousValue = null,
  newValue = null,
  details = null,
}) => {
  try {
    const user = cachedUser || await resolveUser();
    if (!user) return { delivered: 0, pending: 0, skipped: true };

    const item = {
      eventId: makeEventId(),
      userId: user.id,
      module,
      action,
      recordType,
      recordId: recordId || null,
      recordRef: recordRef || null,
      previousValue: cloneJson(previousValue),
      newValue: cloneJson(newValue),
      details: details || null,
      occurredAt: new Date().toISOString(),
    };

    const persisted = writeQueue([...readQueue(), item]);
    const result = await flushActivityLogQueue(user);
    return { ...result, persisted };
  } catch (error) {
    console.warn('[ActivityLog] Activity queued for retry:', error?.message);
    return { delivered: 0, pending: readQueue().length };
  }
};

export const logOrder = (action, orderId, trackingNumber, extra = {}) =>
  logActivity({ module: 'Orders', action, recordType: 'order', recordId: orderId, recordRef: trackingNumber, ...extra });

export const logTrip = (action, tripId, tripNumber, extra = {}) =>
  logActivity({ module: 'Trips', action, recordType: 'trip', recordId: tripId, recordRef: tripNumber, ...extra });

export const logPayment = (action, orderId, trackingNumber, extra = {}) =>
  logActivity({ module: 'Payments', action, recordType: 'order', recordId: orderId, recordRef: trackingNumber, ...extra });

export const logChat = (action, conversationId, customerName, extra = {}) =>
  logActivity({ module: 'Chat', action, recordType: 'conversation', recordId: conversationId, recordRef: customerName, ...extra });

export const logAuth = (action, extra = {}) =>
  logActivity({ module: 'Authentication', action, recordType: 'user', ...extra });

export const logAnnouncement = (action, announcementId, title, extra = {}) =>
  logActivity({ module: 'System', action, recordType: 'announcement', recordId: announcementId, recordRef: title, ...extra });

export const logSettings = (action, settingKey, extra = {}) =>
  logActivity({ module: 'System', action, recordType: 'setting', recordRef: settingKey, ...extra });

export const logCompany = (action, extra = {}) =>
  logActivity({ module: 'System', action, recordType: 'company', ...extra });

supabase.auth.getSession().then(({ data }) => {
  cachedUser = data?.session?.user || null;
  if (cachedUser) void flushActivityLogQueue(cachedUser);
});

supabase.auth.onAuthStateChange((event, session) => {
  cachedUser = event === 'SIGNED_OUT' ? null : (session?.user || cachedUser);
  if (session?.user) {
    setTimeout(() => void flushActivityLogQueue(session.user), 0);
  }
});

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flushActivityLogQueue());
  window.addEventListener('storage', event => {
    if (event.key === QUEUE_KEY) void flushActivityLogQueue();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushActivityLogQueue();
  });
  window.setInterval(() => void flushActivityLogQueue(), 60000);
}
