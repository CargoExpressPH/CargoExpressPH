const OPERATIONAL_ORDER_FIELDS = ['actualWeight', 'payerType', 'pickupPhotos'];

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = value => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const isPhotoReference = (value) => {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!isPlainObject(value)) return false;

  return ['path', 'url', 'data_url', 'firestore_path']
    .some(key => typeof value[key] === 'string' && value[key].trim().length > 0);
};

/**
 * Build the only order metadata the payment function is allowed to persist.
 *
 * Customers may identify their own order, but operational pickup data is an
 * admin-only capability. Returning a new object (rather than the request
 * object) is deliberate: unexpected/mass-assigned properties can never reach
 * the service-role write below.
 */
export const authorizeOrderUpdate = (orderUpdate, isAdmin) => {
  if (!isPlainObject(orderUpdate)) {
    return { error: 'A valid order ID is required.', status: 400 };
  }

  const orderId = typeof orderUpdate.orderId === 'string'
    ? orderUpdate.orderId.trim()
    : '';

  if (!orderId) {
    return { error: 'A valid order ID is required.', status: 400 };
  }

  const operationalFields = OPERATIONAL_ORDER_FIELDS.filter(field => hasOwn(orderUpdate, field));
  if (!isAdmin && operationalFields.length > 0) {
    return {
      error: 'Customers are not authorized to change shipment weight, payer type, or pickup evidence during payment.',
      status: 403,
    };
  }

  const authorized = { orderId };
  if (!isAdmin) return { value: authorized };

  if (hasOwn(orderUpdate, 'actualWeight')) {
    const weight = orderUpdate.actualWeight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 10000) {
      return { error: 'Actual weight must be greater than 0 and no more than 10,000 kg.', status: 400 };
    }
    authorized.actualWeight = weight;
  }

  if (hasOwn(orderUpdate, 'payerType')) {
    if (orderUpdate.payerType !== 'sender' && orderUpdate.payerType !== 'receiver') {
      return { error: 'Payer type must be sender or receiver.', status: 400 };
    }
    authorized.payerType = orderUpdate.payerType;
  }

  if (hasOwn(orderUpdate, 'pickupPhotos')) {
    const photos = orderUpdate.pickupPhotos;
    if (!Array.isArray(photos) || photos.length > 3 || !photos.every(isPhotoReference)) {
      return { error: 'Pickup photos must contain at most 3 valid photo references.', status: 400 };
    }
    authorized.pickupPhotos = photos;
  }

  return { value: authorized };
};

export { OPERATIONAL_ORDER_FIELDS };
