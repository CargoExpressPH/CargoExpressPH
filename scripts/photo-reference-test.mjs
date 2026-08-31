import assert from 'node:assert/strict';
import {
  isUnavailablePhotoUrl,
  normalizePhotoReference,
  serializePhotoReference,
} from '../src/lib/photoReference.js';

const storage = {
  type: 'supabase_storage',
  bucket: 'cargo-photos',
  path: 'pickup-proofs/CE-1/pickup-1.jpg',
};
const fallback = {
  type: 'firestore_fallback',
  firestore_path: 'photoFallbacks/00000000-0000-4000-8000-000000000000_pickup_pickup-1_jpg',
};

assert.deepEqual(normalizePhotoReference(storage), storage);
assert.deepEqual(normalizePhotoReference(JSON.stringify(storage)), storage);
assert.deepEqual(normalizePhotoReference(fallback), fallback);
assert.deepEqual(normalizePhotoReference(JSON.stringify(fallback)), fallback);
assert.deepEqual(normalizePhotoReference(fallback.firestore_path), fallback);
assert.deepEqual(normalizePhotoReference(storage.path), storage);
assert.deepEqual(normalizePhotoReference('https://example.com/photo.jpg'), {
  type: 'direct_url',
  url: 'https://example.com/photo.jpg',
});
assert.deepEqual(normalizePhotoReference('data:image/jpeg;base64,AA=='), {
  type: 'direct_url',
  url: 'data:image/jpeg;base64,AA==',
});
assert.equal(serializePhotoReference(null), null);
assert.deepEqual(normalizePhotoReference(serializePhotoReference(fallback)), fallback);
assert.equal(isUnavailablePhotoUrl('error://unavailable'), true);
assert.equal(isUnavailablePhotoUrl('https://example.com/photo.jpg'), false);

console.log('Photo reference tests passed.');
