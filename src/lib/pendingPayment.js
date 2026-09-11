const CONTEXT_PREFIX = 'cargoexpress_pending_payment_v1_';
const LEGACY_SOURCE_PREFIX = 'pending_payment_';
const LEGACY_AMOUNT_PREFIX = 'pending_payment_amount_';

const getStorage = (storage) => storage || globalThis.localStorage;

const contextKey = (orderId) => `${CONTEXT_PREFIX}${orderId}`;
const legacySourceKey = (orderId) => `${LEGACY_SOURCE_PREFIX}${orderId}`;
const legacyAmountKey = (orderId) => `${LEGACY_AMOUNT_PREFIX}${orderId}`;

/**
 * Persist the exact PayMongo source that this browser is about to open.
 *
 * The role and user id are part of the record on purpose: customer and admin
 * accounts can be used one after the other on the same phone, while
 * localStorage outlives both sessions. An unscoped source can therefore never
 * be allowed to leak from one signed-in account into the next return flow.
 */
export const savePendingPayment = ({ orderId, sourceId, amount, role, userId }, storage) => {
  if (!orderId || !sourceId || !userId || !['customer', 'admin'].includes(role)) return false;

  try {
    const target = getStorage(storage);
    target.setItem(contextKey(orderId), JSON.stringify({
      version: 1,
      orderId,
      sourceId,
      amount: Number(amount) > 0 ? Number(amount) : null,
      role,
      userId,
      createdAt: Date.now(),
    }));

    // New writes use the scoped record only. Removing the old unscoped keys
    // prevents a later fallback from selecting a different source.
    target.removeItem(legacySourceKey(orderId));
    target.removeItem(legacyAmountKey(orderId));
    return true;
  } catch {
    // Storage can be unavailable in private browsing. The return page still
    // has its server/order-row fallback, so checkout itself may continue.
    return false;
  }
};

/**
 * Read a pending source only when it belongs to the active role/account.
 *
 * Legacy unscoped keys are accepted for customers only so a customer already
 * inside GCash while this release deploys can still return successfully.
 * Admins never consume a legacy key because that key may have been left by a
 * customer who previously used the same device.
 */
export const getPendingPayment = ({ orderId, role, userId }, storage) => {
  if (!orderId || !['customer', 'admin'].includes(role)) return null;

  try {
    const target = getStorage(storage);
    const raw = target.getItem(contextKey(orderId));
    if (raw) {
      const saved = JSON.parse(raw);
      const sameOrder = saved?.version === 1 && saved.orderId === orderId;
      const sameRole = saved?.role === role;
      const sameUser = typeof saved?.userId === 'string' && saved.userId === userId;
      if (sameOrder && sameRole && sameUser && typeof saved.sourceId === 'string' && saved.sourceId) {
        return {
          sourceId: saved.sourceId,
          amount: Number(saved.amount) > 0 ? Number(saved.amount) : null,
        };
      }
      return null;
    }

    if (role !== 'customer') return null;
    const legacySource = target.getItem(legacySourceKey(orderId));
    if (!legacySource) return null;
    const legacyAmount = Number(target.getItem(legacyAmountKey(orderId)) || 0);
    return {
      sourceId: legacySource,
      amount: legacyAmount > 0 ? legacyAmount : null,
    };
  } catch {
    return null;
  }
};

/** Remove both the scoped record and the pre-release compatibility keys. */
export const clearPendingPayment = (orderId, storage) => {
  if (!orderId) return;
  try {
    const target = getStorage(storage);
    target.removeItem(contextKey(orderId));
    target.removeItem(legacySourceKey(orderId));
    target.removeItem(legacyAmountKey(orderId));
  } catch {
    // A completed/failed payment must still render even if storage cleanup is
    // blocked by the browser.
  }
};
