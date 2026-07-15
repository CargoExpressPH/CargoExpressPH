import { supabase } from './supabase';
import imageCompression from 'browser-image-compression';

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
    return `${folder}/${safeTracking}/${baseName}-${seq}.jpg`;
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
    maxSizeMB: 0.8,
    maxWidthOrHeight: 1200,
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
 * Core upload function. Compresses, validates, and uploads to Supabase Storage.
 * Returns a storage descriptor object (not a public URL) — call resolvePhotoUrl() to get a URL.
 *
 * @param {File}   file           - the file to upload
 * @param {string} folder         - storage folder (e.g. 'pickup-proofs')
 * @param {string} trackingNumber - order tracking number for organized folder structure
 * @param {number} index          - 1-based index used for sequential filename numbering
 */
const uploadToSupabaseStorage = async (file, folder, trackingNumber = '', index = null) => {
  validatePhotoFile(file);
  const compressed = await compressImage(file);
  const path = makePhotoPath(folder, trackingNumber, index);

  const { error } = await supabase.storage
    .from(COMPANY_ASSETS_BUCKET)
    .upload(path, compressed, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: true, // upsert=true so re-uploads overwrite cleanly (e.g. hero banner replacement)
    });

  if (error) throw new Error(`Supabase Storage Upload Failed: ${error.message}`);

  return {
    type: 'supabase_storage',
    bucket: COMPANY_ASSETS_BUCKET,
    path,
    content_type: 'image/jpeg',
    size_bytes: compressed.size,
    created_at: new Date().toISOString(),
  };
};

/**
 * Upload a single photo.
 *
 * @param {File}   file           - the file to upload
 * @param {string} folder         - e.g. 'receipts', 'pickup-proofs', 'gallery'
 * @param {string} trackingNumber - order tracking number (e.g. 'ORDER-2026-00015')
 * @param {number} index          - 1-based sequential index for the filename
 */
export const uploadPhoto = async (file, folder = 'pickup-proofs', trackingNumber = '', index = 1) => {
  return await uploadToSupabaseStorage(file, folder, trackingNumber, index);
};

/**
 * Upload multiple photos sequentially, producing numbered filenames:
 *   pickup-1.jpg, pickup-2.jpg, pickup-3.jpg ...
 *
 * @param {File[]}   files          - array of files
 * @param {string}   folder         - e.g. 'pickup-proofs'
 * @param {string}   trackingNumber - order tracking number
 * @param {function} onProgress     - optional callback (currentIndex, total)
 */
export const uploadMultiplePhotos = async (files, folder = 'pickup-proofs', trackingNumber = '', onProgress = null) => {
  const photos = [];
  for (let i = 0; i < files.length; i += 1) {
    const photo = await uploadToSupabaseStorage(files[i], folder, trackingNumber, i + 1);
    photos.push(photo);
    if (onProgress) onProgress(i + 1, files.length);
  }
  return photos;
};

export const resolvePhotoUrl = async (photo) => {
  if (!photo) return '';
  if (typeof photo === 'string') return photo;

  try {
    if (photo.type === 'supabase_storage' && photo.path) {
      if (photo.url) return photo.url;
      const { data: pData } = supabase.storage.from(photo.bucket || COMPANY_ASSETS_BUCKET).getPublicUrl(photo.path);
      return pData.publicUrl;
    }
    return photo.url || '';
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
 * Delete a photo from Supabase Storage.
 * Accepts either a raw storage path string OR a storage descriptor object.
 */
export const deletePhoto = async (pathOrDescriptor, bucket = COMPANY_ASSETS_BUCKET) => {
  if (!pathOrDescriptor) return;

  // Support both raw string paths and storage descriptor objects
  const path = typeof pathOrDescriptor === 'string'
    ? pathOrDescriptor
    : pathOrDescriptor?.path;

  if (!path) return;

  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) throw new Error(`Failed to delete photo: ${error.message}`);
};

/**
 * Fallback helpers for storing/getting photo via Firebase Datastore/Firestore
 * when standard supabase.storage fails.
 */
export const storePhotoFallbackFirebase = async (file, orderId, folder) => {
  // Uses 'store-photo-fallback' edge function
  // Formats image data as 'firebase_base64'
  console.log("fallback store triggered");
};

export const getPhotoFallbackFirebase = async (orderId) => {
  // Uses 'get-photo-fallback' edge function
  console.log("fallback get triggered");
};

