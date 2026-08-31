import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const migration = read('supabase/migrations/20260831170000_photo_storage_monitoring_and_routing.sql');
const storage = read('src/lib/storage.js');
const database = read('src/lib/database.js');
const page = read('src/pages/admin/StorageMonitoringPage.jsx');
const app = read('src/App.jsx');
const config = read('supabase/config.toml');
const eventFunction = read('supabase/functions/record-photo-storage-event/index.ts');
const healthFunction = read('supabase/functions/photo-storage-health/index.ts');

for (const path of [
  'supabase/functions/record-photo-storage-event/index.ts',
  'supabase/functions/photo-storage-health/index.ts',
]) {
  assert.ok(existsSync(path), `Missing required photo storage function: ${path}`);
}

assert.match(migration, /CREATE TABLE public\.photo_storage_settings/);
assert.match(migration, /CHECK \(upload_mode IN \('automatic', 'force_firebase'\)\)/);
assert.match(migration, /force_firebase_requires_expiry/);
assert.match(migration, /INTERVAL '24 hours'/);
assert.match(migration, /CREATE TABLE public\.photo_storage_events/);
assert.match(migration, /public\.is_supabase_evidence_upload_allowed\(name\)/);
assert.match(migration, /FOR SELECT TO authenticated/);
assert.match(migration, /FOR DELETE TO authenticated/);
assert.doesNotMatch(migration, /DELETE FROM storage\.objects/i);
assert.doesNotMatch(migration, /DELETE FROM public\.photo_storage/i);

assert.match(storage, /get_effective_photo_storage_mode/);
assert.match(storage, /force_firebase/);
assert.match(storage, /record-photo-storage-event/);
assert.match(storage, /Firebase fallback upload failed/);
assert.match(database, /getPhotoStorageMode/);
assert.match(database, /setPhotoStorageMode/);
assert.match(database, /checkPhotoStorageHealth/);
assert.match(page, /Existing Supabase photos remain readable/);
assert.match(page, /expires automatically/);
assert.match(page, /postgres_changes/);
assert.match(app, /storage-monitoring/);
assert.match(config, /\[functions\.record-photo-storage-event\]/);
assert.match(config, /\[functions\.photo-storage-health\]/);
assert.match(eventFunction, /profile\?\.role !== 'admin'/);
assert.match(eventFunction, /photo_storage_events/);
assert.match(eventFunction, /storage_path\.startsWith\('data:'\)/);
assert.match(healthFunction, /profile\?\.role !== 'admin'/);
assert.match(healthFunction, /storage\.getBucket\('cargo-photos'\)/);
assert.match(healthFunction, /Firebase authentication failed/);

console.log('Photo storage monitoring contract tests passed.');
