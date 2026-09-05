import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const migration = read('supabase/migrations/20260831170000_photo_storage_monitoring_and_routing.sql');
const liveUsageMigration = read('supabase/migrations/20260901010000_live_supabase_storage_usage.sql');
const cleanupMigration = read('supabase/migrations/20260901020000_photo_storage_cleanup_archiving_and_alerts.sql');
const safetyMigration = read('supabase/migrations/20260901030000_safe_photo_cleanup_and_health_checks.sql');
const storage = read('src/lib/storage.js');
const database = read('src/lib/database.js');
const page = read('src/pages/admin/PhotoStorageTab.jsx');
const app = read('src/App.jsx');
const config = read('supabase/config.toml');
const eventFunction = read('supabase/functions/record-photo-storage-event/index.ts');
const healthFunction = read('supabase/functions/photo-storage-health/index.ts');
const cleanupFunction = read('supabase/functions/cleanup-orphaned-photos/index.ts');
const scheduledCleanupFunction = read('supabase/functions/archive-expired-evidence-photos/index.ts');

for (const path of [
  'supabase/functions/record-photo-storage-event/index.ts',
  'supabase/functions/photo-storage-health/index.ts',
  'supabase/functions/cleanup-orphaned-photos/index.ts',
  'supabase/functions/archive-expired-evidence-photos/index.ts',
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
assert.match(liveUsageMigration, /get_photo_storage_live_usage/);
assert.match(liveUsageMigration, /FROM storage\.objects/);
assert.match(liveUsageMigration, /metadata ->> 'size'/);
assert.match(liveUsageMigration, /public\.is_admin\(\)/);
assert.doesNotMatch(liveUsageMigration, /SELECT\s+.*\bname\b.*FROM storage\.objects/is);
assert.match(cleanupMigration, /list_orphaned_evidence_photos/);
assert.match(safetyMigration, /COALESCE\(o\.featured_on_website, FALSE\) = FALSE/);
assert.match(safetyMigration, /CREATE TABLE IF NOT EXISTS public\.photo_cleanup_queue/);
assert.match(safetyMigration, /queue_expired_evidence_cleanup/);
assert.match(safetyMigration, /record_photo_cleanup_queue_result/);
assert.match(safetyMigration, /photo_storage_health_check/);
assert.match(safetyMigration, /15 \*\/6 \* \* \*/);
assert.doesNotMatch(safetyMigration, /DELETE FROM storage\.objects/i);

assert.match(storage, /get_effective_photo_storage_mode/);
assert.match(storage, /force_firebase/);
assert.match(storage, /record-photo-storage-event/);
assert.match(storage, /Firebase fallback upload failed/);
assert.match(database, /getPhotoStorageMode/);
assert.match(database, /setPhotoStorageMode/);
assert.match(database, /checkPhotoStorageHealth/);
assert.match(database, /checkUnusedPhotos/);
assert.match(database, /removeUnusedPhotos/);
assert.match(page, /Existing photos stay where they are and remain available/);
assert.match(page, /Use Backup Photos temporarily/);
assert.match(page, /postgres_changes/);
assert.match(page, /Live updates on/);
assert.match(page, /visibilitychange/);
assert.match(page, /window\.addEventListener\('online', handleOnline\)/);
assert.match(page, /window\.addEventListener\('offline', handleOffline\)/);
assert.match(page, /supabase\.realtime\.connect\(\)/);
assert.match(page, /status === 'SUBSCRIBED'/);
assert.match(page, /Offline — updates paused/);
assert.match(page, /HealthBadge provider="supabase" health=\{health\?\.supabase\} liveStatus=\{liveStatus\}/);
assert.match(page, /if \(liveStatus === 'offline'\) return \{ className: 'badge-error', text: 'Offline' \}/);
assert.match(page, /last successful values remain visible and will update when the internet returns/);
assert.match(page, /60000/);
assert.doesNotMatch(page, /> Refresh\s*</);
// UI copy was simplified for non-technical admins (business-facing labels
// instead of provider names as primary headings); the provider names moved
// into a secondary "Technical Details" section rather than disappearing.
assert.match(page, /Main Storage \(Supabase\)/);
assert.match(page, /Pickup Photos/);
assert.match(page, /Delivery Photos/);
assert.match(page, /Receipt Photos/);
assert.match(page, /Photos in use/);
assert.match(page, /Estimated space used/);
assert.match(page, /Estimated space left/);
assert.doesNotMatch(page, />Backup photos</);
assert.match(page, /Recent Photo Activity/);
assert.match(page, /activityDetails\(event\)/);
assert.doesNotMatch(page, /event\.message \|\|/);
assert.doesNotMatch(page, /firebaseUsagePercent/);
assert.doesNotMatch(page, /firebaseQuotaBytes/);
assert.match(page, /role="progressbar"/);
assert.match(page, /included_storage_bytes/);
assert.match(app, /storage-monitoring/);
assert.match(config, /\[functions\.record-photo-storage-event\]/);
assert.match(config, /\[functions\.photo-storage-health\]/);
assert.match(eventFunction, /profile\?\.role !== 'admin'/);
assert.match(eventFunction, /photo_storage_events/);
assert.match(eventFunction, /storage_path\.startsWith\('data:'\)/);
assert.match(healthFunction, /profile\?\.role !== 'admin'/);
assert.match(healthFunction, /storage\.getBucket\('cargo-photos'\)/);
assert.match(healthFunction, /Firebase authentication failed/);
assert.match(healthFunction, /CARGOEXPRESS_SUPABASE_PAT/);
assert.match(healthFunction, /get_photo_storage_live_usage/);
assert.match(healthFunction, /\/v1\/organizations\/\$\{encodeURIComponent\(organizationSlug\)\}/);
assert.match(healthFunction, /storage\.max_file_size/);
assert.match(healthFunction, /estimated_photo_data_bytes/);
assert.match(healthFunction, /free_tier_reference_bytes/);
assert.doesNotMatch(healthFunction, /firebase_storage:[\s\S]*included_bytes/);

assert.match(cleanupFunction, /action = requestBody\.action \?\? 'preview'/);
assert.match(cleanupFunction, /createCleanupToken/);
assert.match(cleanupFunction, /verifyCleanupToken/);
assert.match(cleanupFunction, /requires_new_preview/);
assert.match(cleanupFunction, /failedPaths\.length > 0 \? 'failure' : 'success'/);

assert.match(scheduledCleanupFunction, /isManagedEvidencePath/);
assert.match(scheduledCleanupFunction, /queue_expired_evidence_cleanup/);
assert.match(scheduledCleanupFunction, /photo_cleanup_queue/);
assert.match(scheduledCleanupFunction, /record_photo_cleanup_queue_result/);
assert.doesNotMatch(scheduledCleanupFunction, /\.from\('orders'\)[\s\S]{0,160}\.update\(\{ pickup_photos/);

console.log('Photo storage monitoring contract tests passed.');
