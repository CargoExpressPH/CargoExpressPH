const ABSOLUTE_IMAGE_URL = /^(?:https?:|data:image\/|blob:|error:)/i;
const FIRESTORE_PREFIX = 'photoFallbacks/';

const parseJsonReference = (value) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Normalize every historical photo representation into one descriptor shape.
 *
 * Supported inputs:
 *   - current Supabase / Firestore descriptor objects
 *   - JSON-serialized descriptors stored in TEXT columns and public RPCs
 *   - legacy raw Storage paths
 *   - legacy absolute/data/blob URLs
 *   - legacy raw Firestore document paths
 */
export const normalizePhotoReference = (photo, defaultBucket = 'cargo-photos') => {
  if (!photo) return null;

  if (typeof photo === 'string') {
    const value = photo.trim();
    if (!value) return null;

    const parsed = parseJsonReference(value);
    if (parsed) return normalizePhotoReference(parsed, defaultBucket);

    if (value.startsWith(FIRESTORE_PREFIX)) {
      return { type: 'firestore_fallback', firestore_path: value };
    }
    if (ABSOLUTE_IMAGE_URL.test(value)) {
      return { type: 'direct_url', url: value };
    }
    return { type: 'supabase_storage', bucket: defaultBucket, path: value.replace(/^\/+/, '') };
  }

  if (typeof photo !== 'object' || Array.isArray(photo)) return null;

  if (photo.type === 'firestore_fallback' || photo.firestore_path) {
    if (!photo.firestore_path) return null;
    return { ...photo, type: 'firestore_fallback' };
  }
  if (photo.type === 'supabase_storage' || photo.path) {
    if (!photo.path) return null;
    return { ...photo, type: 'supabase_storage', bucket: photo.bucket || defaultBucket };
  }
  if (photo.data_url) return { ...photo, type: 'direct_url', url: photo.data_url };
  if (photo.url) return { ...photo, type: 'direct_url', url: photo.url };
  return null;
};

/** Persist descriptors safely in legacy TEXT columns such as receipt_url. */
export const serializePhotoReference = (photo) => {
  if (!photo) return null;
  if (typeof photo === 'string') return photo;
  return JSON.stringify(photo);
};

export const isUnavailablePhotoUrl = (url) => !url || url === 'error://unavailable';
