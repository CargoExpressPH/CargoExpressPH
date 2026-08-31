import { supabase } from './supabase';
import imageCompression from 'browser-image-compression';
import { normalizePhotoReference } from './photoReference';

const COMPANY_ASSETS_BUCKET = import.meta.env.VITE_SUPABASE_PHOTOS_BUCKET || 'cargo-photos';
const MAX_SOURCE_BYTES = 10 * 1024 * 1024; // 10MB
const VALID_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Sanitize a tracking number or name into a safe folder segment.
 * e.g. "ORDER-2026-00015" → "ORDER-2026-00015"
 *      "some random uuid" → falls back to a timestamped segment
 */
const safeFolderName = (name) =>
  (name || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 60);

/**
 * Build an organized, human-readable storage path.
 *
 * Shipment evidence:
 *   pickup-proofs/ORDER-2026-00015/pickup-1.jpg
 *   delivery-proofs/ORDER-2026-00015/delivery-1.jpg
 *   receipts/ORDER-2026-00015/receipt-1.jpg
 *
 * Company assets (no trackingNumber):
 *   gallery/gallery-1750000000000.jpg
 *   hero/hero-banner.jpg
 *   timeline/timeline-1750000000000.jpg
 *
 * @param {string} folder         - top-level folder (e.g. 'pickup-proofs', 'gallery', 'hero')
 * @param {string} trackingNumber - order tracking number used as sub-folder (optional)
 * @param {number} index          - 1-based index for sequential numbering (optional)
 */
const makePhotoPath = (folder, trackingNumber = '', index = null) => {
  const timestamp = Date.now();

  if (trackingNumber) {
    const safeTracking = safeFolderName(trackingNumber);
    // Derive a human-readable base name from the folder (e.g. "pickup-proofs" → "pickup")
    const baseName = folder.replace(/-proofs$/, '').replace(/-/g, '-');
    const seq = index !== null ? index : 1;
    // Every payment transaction keeps its own receipt. Proof filenames stay
    // stable for deliberate re-processing, while receipts never overwrite a
    // previous transaction's evidence.
    const suffix = folder === 'receipts' ? `${timestamp}-${seq}` : seq;
    return `${folder}/${safeTracking}/${baseName}-${suffix}.jpg`;
  }

  // Company assets (no order context) — use a timestamped flat name
  return `${folder}/${folder}-${timestamp}.jpg`;
};

const validatePhotoFile = (file) => {
  if (!VALID_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Invalid file type. Only JPG, PNG, and WebP are allowed.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('File is too large. Maximum size is 10MB before compression.');
  }
};

export const compressImage = async (file) => {
  const options = {
    maxSizeMB: 0.5,
    maxWidthOrHeight: 1024,
    useWebWorker: true,
    fileType: 'image/jpeg',
  };
  try {
    return await imageCompression(file, options);
  } catch (error) {
    console.error('Compression failed, using original file', error);
    return file; // Fallback to original if compression fails
  }
};

/**
 * Convert a File/Blob to a data:image/jpeg;base64, URL for Firestore fallback.
 * Used only when Supabase Storage fails — the fallback stores the image as
 * a data_url inside a Firestore document (1 MiB doc limit).
 */
export const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file for fallback'));
    reader.readAsDataURL(file);
  });

// Firestore fallback limits — validated server-side too (store-photo-fallback: 700KB).
const MAX_FIRESTORE_DATA_URL_BYTES = 700 * 1024;
const FALLBACK_FOLDER_MAP = {
  'pickup-proofs': 'pickup',
  pickup: 'pickup',
  'delivery-proofs': 'delivery',
  delivery: 'delivery',
  receipts: 'receipt',
  receipt: 'receipt',
};

const toFallbackFolder = (folder) => FALLBACK_FOLDER_MAP[folder] || null;

const isFallbackEligible = (folder, orderId) => Boolean(toFallbackFolder(folder) && orderId);

const fallbackPhotoType = (folder) => toFallbackFolder(folder);

// The routing setting is intentionally advisory in the browser: the Storage
// policy in the database is the enforcement point. If this read is temporarily
// unavailable, the normal Supabase-first path still reaches the same fallback.
const getEvidenceUploadMode = async () => {
  try {
    const { data, error } = await supabase.rpc('get_effective_photo_storage_mode');
    if (error) throw error;
    return data?.[0]?.upload_mode === 'force_firebase' ? 'force_firebase' : 'automatic';
  } catch (error) {
    console.warn('[storage] Could not read photo upload routing; using Automatic mode.', error?.message || error);
    return 'automatic';
  }
};

const eventMessage = (error) => String(error?.message || error || 'Upload failed')
  .replace(/data:[^\s]+/gi, '[image data omitted]')
  .slice(0, 500);

// Telemetry must never affect an upload. The Edge Function checks the signed-in
// admin again and writes the event with service credentials.
const recordEvidenceUploadEvent = (payload) => {
  if (!payload.order_id || !payload.photo_type) return;
  void supabase.functions.invoke('record-photo-storage-event', { body: payload })
    .catch((error) => console.warn('[storage] Upload telemetry was not recorded.', error?.message || error));
};

/**
 * Try the Firestore backup when Supabase Storage is unavailable.
 * Isolated behind the catch — never runs on a successful upload.
 * Returns a descriptor with type 'firestore_fallback' or throws.
 */
const tryFirestoreFallback = async (file, folder, orderId, index, fileName = null) => {
  const fallbackFolder = toFallbackFolder(folder);
  if (!fallbackFolder || !orderId) throw new Error('Fallback not eligible');

  // Re-compress to 0.5 MB target so base64 stays under 700 KB (33% overhead).
  // If still too large, the server will 413 and we surface the ORIGINAL error.
  const compressed = await compressImage(file);
  const dataUrl = await fileToDataUrl(compressed);

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) {
    throw new Error('Fallback requires JPEG base64 data_url');
  }
  if (new TextEncoder().encode(dataUrl).length > MAX_FIRESTORE_DATA_URL_BYTES) {
    throw new Error(`Supabase Storage Upload Failed: fallback image still too large for Firestore (${Math.round(dataUrl.length / 1024)}KB > 700KB)`);
  }

  const { data, error } = await supabase.functions.invoke('store-photo-fallback', {
    body: {
      order_id: orderId,
      folder: fallbackFolder,
      file_name: fileName || `${fallbackFolder}-${index || 1}.jpg`,
      content_type: 'image/jpeg',
      size_bytes: compressed.size,
      data_url: dataUrl,
    },
  });

  if (error) throw new Error(error.message || 'Firestore fallback failed');
  if (data?.error) throw new Error(data.error);
  if (!data?.firestore_path) throw new Error('Fallback did not return firestore_path');

  return {
    type: 'firestore_fallback',
    firestore_path: data.firestore_path,
    content_type: 'image/jpeg',
    size_bytes: compressed.size,
    created_at: data.created_at || new Date().toISOString(),
    // Do NOT store data_url in the order row — keep row small; fetch on demand via get-photo-fallback.
  };
};

/**
 * Core upload function. Compresses, validates, and uploads to Supabase Storage.
 * Returns a storage descriptor object (not a public URL) — call resolvePhotoUrl() to get a URL.
 *
 * @param {File}   file           - the file to upload
 * @param {string} folder         - storage folder (e.g. 'pickup-proofs')
 * @param {string} trackingNumber - order tracking number for organized folder structure
 * @param {number} index          - 1-based index used for sequential filename numbering
 */
// Folders holding shipment evidence — private, and cached only briefly.
const EVIDENCE_FOLDERS = ['pickup', 'delivery', 'receipts', 'pickup-proofs', 'delivery-proofs'];

const uploadToSupabaseStorage = async (file, folder, trackingNumber = '', index = null, orderId = null) => {
  validatePhotoFile(file);
  const compressed = await compressImage(file);
  const path = makePhotoPath(folder, trackingNumber, index);

  // A year-long cache header is right for immutable public decoration and
  // wrong for cargo evidence. Anything served through the CDN stays in the
  // edge cache for its max-age regardless of what the bucket's privacy
  // setting does afterwards — which is exactly why proof photos uploaded
  // while `cargo-photos` was public survived it being locked down. One hour
  // keeps the CDN useful without pinning private evidence at the edge.
  const isEvidence = EVIDENCE_FOLDERS.includes(folder);
  const photoType = fallbackPhotoType(folder);
  const canUseFirestoreFallback = isFallbackEligible(folder, orderId);

  // Force Firebase is a temporary admin-only operational route for new
  // shipment evidence. It does not change the bucket or any existing photo.
  if (canUseFirestoreFallback && await getEvidenceUploadMode() === 'force_firebase') {
    try {
      const fallbackDescriptor = await tryFirestoreFallback(file, folder, orderId, index, path.split('/').pop());
      recordEvidenceUploadEvent({
        provider: 'firebase', outcome: 'success', photo_type: photoType,
        order_id: orderId, storage_path: fallbackDescriptor.firestore_path,
        size_bytes: fallbackDescriptor.size_bytes,
        message: 'New evidence upload routed directly to Firebase fallback.',
      });
      return fallbackDescriptor;
    } catch (fallbackError) {
      recordEvidenceUploadEvent({
        provider: 'firebase', outcome: 'failure', photo_type: photoType,
        order_id: orderId, size_bytes: compressed.size, message: eventMessage(fallbackError),
      });
      throw new Error(`Firebase fallback upload failed: ${eventMessage(fallbackError)}`);
    }
  }

  try {
    const { error } = await supabase.storage
      .from(COMPANY_ASSETS_BUCKET)
      .upload(path, compressed, {
        contentType: 'image/jpeg',
        cacheControl: isEvidence ? '3600' : '31536000',
        upsert: true, // upsert=true so re-uploads overwrite cleanly (e.g. hero banner replacement)
      });

    if (error) throw new Error(`Supabase Storage Upload Failed: ${error.message}`);

    const descriptor = {
      type: 'supabase_storage',
      bucket: COMPANY_ASSETS_BUCKET,
      path,
      content_type: 'image/jpeg',
      size_bytes: compressed.size,
      created_at: new Date().toISOString(),
    };
    if (canUseFirestoreFallback) {
      recordEvidenceUploadEvent({
        provider: 'supabase', outcome: 'success', photo_type: photoType,
        order_id: orderId, storage_path: path, size_bytes: compressed.size,
      });
    }
    return descriptor;
  } catch (uploadError) {
    // ── Isolated fallback: only when Supabase fails AND we have an order context
    // Main success never reaches here. Validation errors (file type/size) are
    // thrown before upload and are NOT retriable — they re-throw immediately.
    const msg = uploadError?.message || String(uploadError);
    const isValidationError = msg.includes('Invalid file type') || msg.includes('File is too large');
    if (canUseFirestoreFallback) {
      recordEvidenceUploadEvent({
        provider: 'supabase', outcome: 'failure', photo_type: photoType,
        order_id: orderId, storage_path: path, size_bytes: compressed.size,
        message: eventMessage(uploadError),
      });
    }
    if (isValidationError || !canUseFirestoreFallback) throw uploadError;

    try {
      console.warn(`[storage] Supabase upload failed for ${folder}/${trackingNumber}, trying Firestore fallback`, msg);
      const fallbackDescriptor = await tryFirestoreFallback(file, folder, orderId, index, path.split('/').pop());
      console.info(`[storage] Firestore fallback succeeded: ${fallbackDescriptor.firestore_path}`);
      recordEvidenceUploadEvent({
        provider: 'firebase', outcome: 'success', photo_type: photoType,
        order_id: orderId, storage_path: fallbackDescriptor.firestore_path,
        size_bytes: fallbackDescriptor.size_bytes,
        message: 'Firebase fallback stored the evidence after a Supabase upload failure.',
      });
      return fallbackDescriptor;
    } catch (fallbackError) {
      // If fallback also fails, surface the ORIGINAL Supabase error — the
      // primary is authoritative; fallback failure is secondary noise.
      console.error('[storage] Firestore fallback also failed', fallbackError?.message || fallbackError);
      recordEvidenceUploadEvent({
        provider: 'firebase', outcome: 'failure', photo_type: photoType,
        order_id: orderId, size_bytes: compressed.size, message: eventMessage(fallbackError),
      });
      throw uploadError;
    }
  }
};

/**
 * Upload a single photo.
 *
 * @param {File}   file           - the file to upload
 * @param {string} folder         - e.g. 'receipts', 'pickup-proofs', 'gallery'
 * @param {string} trackingNumber - order tracking number (e.g. 'ORDER-2026-00015')
 * @param {number} index          - 1-based sequential index for the filename
 * @param {string} orderId        - order UUID for Firestore fallback (pickup, delivery, and receipts)
 */
export const uploadPhoto = async (file, folder = 'pickup-proofs', trackingNumber = '', index = 1, orderId = null) => {
  return await uploadToSupabaseStorage(file, folder, trackingNumber, index, orderId);
};

/**
 * Upload multiple photos sequentially, producing numbered filenames:
 *   pickup-1.jpg, pickup-2.jpg, pickup-3.jpg ...
 *
 * @param {File[]}   files          - array of files
 * @param {string}   folder         - e.g. 'pickup-proofs'
 * @param {string}   trackingNumber - order tracking number
 * @param {function} onProgress     - optional callback (currentIndex, total)
 * @param {string}   orderId        - order UUID for Firestore fallback (required for evidence fallback to work)
 */
export const uploadMultiplePhotos = async (files, folder = 'pickup-proofs', trackingNumber = '', onProgress = null, orderId = null) => {
  // Back-compat: onProgress could be passed as 4th arg when orderId omitted (old callers: trackingNumber, onProgress)
  if (typeof onProgress === 'string' && orderId === null) {
    orderId = onProgress;
    onProgress = null;
  }
  const photos = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      const photo = await uploadToSupabaseStorage(files[i], folder, trackingNumber, i + 1, orderId);
      photos.push(photo);
      if (onProgress) onProgress(i + 1, files.length);
    }
    return photos;
  } catch (error) {
    await Promise.allSettled(photos.map((photo) => deletePhoto(photo)));
    throw error;
  }
};

// Signed URLs are minted per render. One hour outlives any realistic viewing
// session without leaving a long-lived link in browser history or logs.
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Turn a storage descriptor into a URL the browser can load.
 *
 * Prefers a SIGNED url over a public one. A signed url is authorised by the
 * caller's own session against the storage RLS policies, so it is the only
 * form that keeps working once `cargo-photos` becomes a private bucket —
 * and, unlike /object/public/, it cannot be guessed. Proof photos and
 * receipts live under predictable paths (the tracking number is in the URL),
 * so a public bucket means anyone who can guess a tracking number can read
 * the evidence for that shipment.
 *
 * Falls back to the public url when signing is refused — that covers company
 * website assets viewed by anonymous visitors on a bucket that is still
 * public. The fallback is intentionally last: if signing works, we never hand
 * out an unauthenticated link.
 */
export const resolvePhotoUrl = async (photo) => {
  const reference = normalizePhotoReference(photo, COMPANY_ASSETS_BUCKET);
  if (!reference) return '';

  try {
    if (reference.type === 'direct_url') return reference.url;

    if (reference.type === 'firestore_fallback' && reference.firestore_path) {
      // Firestore backup — the Edge Function checks admin, owner, or exact public feature.
      // Small in-memory cache avoids re-fetching the same fallback within a render cycle.
      const cacheKey = reference.firestore_path;
      if (resolvePhotoUrl._fallbackCache?.has(cacheKey)) {
        return resolvePhotoUrl._fallbackCache.get(cacheKey);
      }
      const { data, error } = await supabase.functions.invoke('get-photo-fallback', {
        body: { firestore_path: reference.firestore_path },
      });
      if (!error && data?.data_url) {
        if (!resolvePhotoUrl._fallbackCache) resolvePhotoUrl._fallbackCache = new Map();
        // Cache for 5 minutes; data_url is immutable for that doc.
        resolvePhotoUrl._fallbackCache.set(cacheKey, data.data_url);
        setTimeout(() => resolvePhotoUrl._fallbackCache.delete(cacheKey), 5 * 60 * 1000);
        return data.data_url;
      }
      // If fallback read fails, fall through to url if present (legacy)
      if (reference.data_url) return reference.data_url;
      console.warn('[storage] Firestore fallback read failed', error?.message || data?.error);
      return 'error://unavailable';
    }

    if (reference.type === 'supabase_storage' && reference.path) {
      if (reference.url) return reference.url;
      const bucket = reference.bucket || COMPANY_ASSETS_BUCKET;

      const { data: signed, error: signError } = await supabase.storage
        .from(bucket)
        .createSignedUrl(reference.path, SIGNED_URL_TTL_SECONDS);
      if (!signError && signed?.signedUrl) return signed.signedUrl;

      const { data: pData } = supabase.storage.from(bucket).getPublicUrl(reference.path);
      return pData.publicUrl;
    }
    // Legacy: direct url field or data_url from old fallback rows
    if (reference.data_url) return reference.data_url;
    return reference.url || '';
  } catch (err) {
    console.error('Photo resolve error:', err);
    return 'error://unavailable';
  }
};

export const resolvePhotoUrls = async (photos = []) => {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const resolved = await Promise.allSettled(photos.map(resolvePhotoUrl));
  return resolved
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);
};

/**
 * Delete a photo from Supabase Storage or Firestore fallback.
 * Accepts either a raw storage path string OR a storage descriptor object.
 * Firestore fallback documents are deleted through an admin-authorized Edge Function.
 */
export const deletePhoto = async (pathOrDescriptor, bucket = COMPANY_ASSETS_BUCKET) => {
  const reference = normalizePhotoReference(pathOrDescriptor, bucket);
  if (!reference || reference.type === 'direct_url') return;

  // Firestore fallback deletion uses the service account only after server-side admin checks.
  if (reference.type === 'firestore_fallback') {
    const { error } = await supabase.functions.invoke('delete-photo-fallback', {
      body: { firestore_path: reference.firestore_path },
    });
    if (error) throw new Error(`Failed to delete fallback photo: ${error.message}`);
    resolvePhotoUrl._fallbackCache?.delete(reference.firestore_path);
    return;
  }

  // Support both raw string paths and storage descriptor objects
  const path = reference.path;

  if (!path) return;

  const { error } = await supabase.storage.from(reference.bucket || bucket).remove([path]);
  if (error) throw new Error(`Failed to delete photo: ${error.message}`);
};

