// Booking drafts contain names, phone numbers and addresses. Keep every key
// bound to the authenticated account so a shared tab cannot restore one
// customer's details into another customer's form.
const DRAFT_PREFIX = 'cargoexpress.booking-draft.v2';
const LEGACY_FORM_KEY = 'booking_form';
const LEGACY_STEP_KEY = 'booking_step';

export const BOOKING_DATA_FIELDS = [
  'sender_name', 'sender_phone', 'sender_facebook', 'sender_lot_block',
  'sender_street', 'sender_barangay', 'sender_city', 'sender_province',
  'sender_landmark', 'sender_other_province', 'receiver_name',
  'receiver_phone', 'receiver_facebook', 'receiver_lot_block',
  'receiver_street', 'receiver_barangay', 'receiver_city',
  'receiver_province', 'receiver_landmark', 'package_description', 'notes',
];

export const hasMeaningfulBookingData = (form = {}) => (
  BOOKING_DATA_FIELDS.some((field) => String(form[field] ?? '').trim().length > 0)
);

const getSessionStorage = (storage) => storage ?? globalThis.sessionStorage;
const formKey = (userId) => `${DRAFT_PREFIX}:${userId}:form`;
const stepKey = (userId) => `${DRAFT_PREFIX}:${userId}:step`;

export const clearLegacyBookingDraftStorage = (storage) => {
  try {
    const target = getSessionStorage(storage);
    target.removeItem(LEGACY_FORM_KEY);
    target.removeItem(LEGACY_STEP_KEY);
  } catch {
    // Storage may be unavailable in private mode.
  }
};

export const clearBookingDraftStorage = (userId, storage) => {
  clearLegacyBookingDraftStorage(storage);
  if (!userId) return;
  try {
    const target = getSessionStorage(storage);
    target.removeItem(formKey(userId));
    target.removeItem(stepKey(userId));
  } catch {
    // In-memory form state still works when storage is unavailable.
  }
};

export const readBookingDraft = (userId, storage) => {
  // Never adopt the old global draft: ownership cannot be established.
  clearLegacyBookingDraftStorage(storage);
  if (!userId) return null;
  try {
    const target = getSessionStorage(storage);
    const raw = target.getItem(formKey(userId));
    if (!raw) return null;
    const form = JSON.parse(raw);
    if (!form || typeof form !== 'object' || Array.isArray(form)) return null;
    const parsedStep = Number.parseInt(target.getItem(stepKey(userId)) || '1', 10);
    return {
      form,
      step: Number.isInteger(parsedStep) && parsedStep >= 1 && parsedStep <= 5 ? parsedStep : 1,
    };
  } catch {
    return null;
  }
};

export const persistBookingDraft = (userId, form, step, storage) => {
  clearLegacyBookingDraftStorage(storage);
  if (!userId) return false;
  if (!hasMeaningfulBookingData(form)) {
    clearBookingDraftStorage(userId, storage);
    return false;
  }

  try {
    const target = getSessionStorage(storage);
    target.setItem(formKey(userId), JSON.stringify(form));
    target.setItem(stepKey(userId), String(step));
    return true;
  } catch {
    return false;
  }
};
