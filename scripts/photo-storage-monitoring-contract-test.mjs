import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const migration = read('supabase/migrations/20260831170000_photo_storage_monitoring_and_routing.sql');
const liveUsageMigration = read('supabase/migrations/20260901010000_live_supabase_storage_usage.sql');
const cleanupMigration = read('supabase/migrations/20260901020000_photo_storage_cleanup_archiving_and_alerts.sql');
const safetyMigration = read('supabase/migrations/20260901030000_safe_photo_cleanup_and_health_checks.sql');
const retentionMigration = read('supabase/migrations/20260908112100_prepare_photo_retention.sql');
const retentionSecurityMigration = read('supabase/migrations/20260911075700_secure_photo_cleanup_functions.sql');
const galleryMigration = read('supabase/migrations/20260915090000_simplify_storage_monitoring_gallery.sql');
const storage = read('src/lib/storage.js');
const database = read('src/lib/database.js');
const page = read('src/pages/admin/PhotoStorageTab.jsx');
const app = read('src/App.jsx');
const config = read('supabase/config.toml');
const eventFunction = read('supabase/functions/record-photo-storage-event/index.ts');
const healthFunction = read('supabase/functions/photo-storage-health/index.ts');
const deleteStorageFunction = read('supabase/functions/delete-storage-photos/index.ts');
const scheduledCleanupFunction = read('supabase/functions/archive-expired-evidence-photos/index.ts');

for (const path of [
  'supabase/functions/record-photo-storage-event/index.ts',
  'supabase/functions/photo-storage-health/index.ts',
  'supabase/functions/delete-storage-photos/index.ts',
  'supabase/functions/archive-expired-evidence-photos/index.ts',
]) {
  assert.ok(existsSync(path), `Missing required photo storage function: ${path}`);
}
assert.ok(
  !existsSync('supabase/functions/cleanup-orphaned-photos'),
  'cleanup-orphaned-photos was superseded by delete-storage-photos + the unified gallery and should stay removed — see STORAGE_MONITORING_SIMPLIFICATION_IMPLEMENTATION.md',
);

// ── Original module DDL (unchanged by the simplification) ─────────────────
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
assert.match(retentionMigration, /purge_old_photo_storage_events/);
assert.match(retentionMigration, /purge_old_photo_cleanup_queue/);
assert.match(retentionSecurityMigration, /GRANT EXECUTE ON FUNCTION public\.purge_old_photo_storage_events\(INT\) TO service_role/);
assert.match(retentionSecurityMigration, /GRANT EXECUTE ON FUNCTION public\.purge_old_photo_cleanup_queue\(INT\) TO service_role/);

// ── New gallery/deletion migration ──────────────────────────────────────
assert.match(galleryMigration, /CREATE OR REPLACE FUNCTION public\.text_to_photo_ref/);
assert.match(galleryMigration, /CREATE OR REPLACE FUNCTION public\.classify_evidence_photo_ref/);
assert.match(galleryMigration, /CREATE OR REPLACE FUNCTION public\.list_evidence_photos/);
assert.match(galleryMigration, /CREATE OR REPLACE FUNCTION public\.delete_evidence_photos/);
// list/delete both re-check admin from scratch — never trust the caller's role claim.
assert.match(galleryMigration, /RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501'/);
// Every protection the existing 6-month archive already enforces must be
// re-derived here too, not merely copied from a client-supplied flag.
assert.match(galleryMigration, /Receipt photos are always kept/);
assert.match(galleryMigration, /Featured on the public website/);
assert.match(galleryMigration, /Shipment is still in progress/);
assert.match(galleryMigration, /Delivered\/cancelled recently — kept for 6 months/);
assert.match(galleryMigration, /Photo reference no longer matches this booking/);
assert.match(galleryMigration, /v_cutoff timestamptz := now\(\) - INTERVAL '6 months'/);
// Row-locked before the jsonb array is rewritten, so a concurrent edit can't
// be silently overwritten.
assert.match(galleryMigration, /FOR UPDATE;/);
// Orphan claims are re-verified at execution time too, not trusted from an
// earlier list_evidence_photos() read.
assert.match(galleryMigration, /it is no longer unused/i);
// Deletion is queued through the existing durable retry table, never a
// direct provider delete from inside SQL.
assert.match(galleryMigration, /INSERT INTO public\.photo_cleanup_queue/);
assert.doesNotMatch(galleryMigration, /DELETE FROM storage\.objects/i);
assert.doesNotMatch(galleryMigration, /DELETE FROM public\.orders/i);
assert.doesNotMatch(galleryMigration, /DELETE FROM public\.payment_transactions/i);
assert.match(galleryMigration, /REVOKE ALL ON FUNCTION public\.list_evidence_photos.*FROM PUBLIC/);
assert.match(galleryMigration, /GRANT EXECUTE ON FUNCTION public\.list_evidence_photos.*TO authenticated/);
assert.match(galleryMigration, /REVOKE ALL ON FUNCTION public\.delete_evidence_photos\(jsonb\) FROM PUBLIC/);
assert.match(galleryMigration, /GRANT EXECUTE ON FUNCTION public\.delete_evidence_photos\(jsonb\) TO authenticated/);
// The two retention functions (added 2026-09-08, secured 2026-09-11) were
// never scheduled — this migration is what finally schedules them.
assert.match(galleryMigration, /cron\.schedule\(\s*\n\s*'purge_photo_storage_operational_logs'/);
assert.match(galleryMigration, /purge_old_photo_storage_events\(30\)/);
assert.match(galleryMigration, /purge_old_photo_cleanup_queue\(7\)/);
// The manual force_firebase toggle is removed from the UI — this migration
// safely resets it to automatic instead of leaving a stale override live.
assert.match(galleryMigration, /UPDATE public\.photo_storage_settings/);
assert.match(galleryMigration, /WHERE id = TRUE AND upload_mode <> 'automatic'/);

// ── Upload/fallback client code is unchanged by this simplification ────────
assert.match(storage, /get_effective_photo_storage_mode/);
assert.match(storage, /force_firebase/);
assert.match(storage, /record-photo-storage-event/);
assert.match(storage, /Firebase fallback upload failed/);

// ── database.js: manual-mode wrappers removed, gallery wrappers added ─────
assert.match(database, /export const listEvidencePhotos/);
assert.match(database, /export const deleteEvidencePhotos/);
assert.match(database, /list_evidence_photos/);
assert.match(database, /delete-storage-photos/);
assert.match(database, /export const checkPhotoStorageHealth/);
assert.match(database, /export const getPhotoStorageSummary/);
assert.doesNotMatch(database, /export const getPhotoStorageMode/);
assert.doesNotMatch(database, /export const setPhotoStorageMode/);
assert.doesNotMatch(database, /export const checkUnusedPhotos/);
assert.doesNotMatch(database, /export const removeUnusedPhotos/);
assert.doesNotMatch(database, /export const getPhotoStorageEvents/);
assert.doesNotMatch(database, /cleanup-orphaned-photos/);

// ── Simplified admin page ──────────────────────────────────────────────────
// Technical clutter removed: manual routing controls, upload activity table,
// realtime activity subscription, provider health/diagnostic panel.
assert.doesNotMatch(page, /force_firebase/);
assert.doesNotMatch(page, /Use Backup Photos temporarily/);
assert.doesNotMatch(page, /Advanced: Where New Photos Are Saved/);
assert.doesNotMatch(page, /Technical Details/);
assert.doesNotMatch(page, /Recent Photo Activity/);
assert.doesNotMatch(page, /postgres_changes/);
assert.doesNotMatch(page, /HealthBadge/);
assert.doesNotMatch(page, /planLabel/);
// Core usage summary is kept, honestly labelled.
assert.match(page, /Storage Usage/);
assert.match(page, /role="progressbar"/);
assert.match(page, /included_storage_bytes/);
assert.match(page, /published plan limit, not a number read from your account/);
assert.match(page, /This total includes every file in photo storage, including website images/);
assert.match(page, /Backup storage separately holds/);
// Percent formatting never shows a misleading bare "0%" for a small nonzero amount.
assert.match(page, /'<1%'/);
// Gallery: search, filters, selection, delete.
assert.match(page, /listEvidencePhotos/);
assert.match(page, /deleteEvidencePhotos/);
assert.match(page, /Search by booking \/ tracking number/);
assert.match(page, /'Can Be Deleted'/);
assert.match(page, /'Still Needed'/);
assert.match(page, /Select all eligible on this page/);
assert.match(page, /Delete Selected/);
assert.match(page, /permanently removed from storage\. This cannot be undone/);
assert.match(page, /booking and payment records are not affected/i);
// Only eligible photos are selectable — protected ones never render a checkbox.
assert.match(page, /item\.status !== 'eligible'\) return;/);
assert.match(page, /canSelect = item\.status === 'eligible'/);
assert.match(page, /ImageLightbox/);
assert.match(page, /Pagination/);
assert.doesNotMatch(page, /> Refresh\s*</);

assert.match(app, /storage-monitoring/);
assert.match(config, /\[functions\.record-photo-storage-event\]/);
assert.match(config, /\[functions\.photo-storage-health\]/);
assert.match(config, /\[functions\.delete-storage-photos\]/);
assert.doesNotMatch(config, /\[functions\.cleanup-orphaned-photos\]/);
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

// ── delete-storage-photos: re-verifies eligibility server-side, never trusts the client ──
assert.match(deleteStorageFunction, /profile\?\.role !== 'admin'/);
assert.match(deleteStorageFunction, /userClient\.rpc\('delete_evidence_photos'/);
assert.match(deleteStorageFunction, /record_photo_cleanup_queue_result/);
assert.match(deleteStorageFunction, /MAX_ITEMS/);
assert.match(deleteStorageFunction, /response\.ok \|\| response\.status === 404/);
assert.doesNotMatch(deleteStorageFunction, /\.from\('orders'\)/);

assert.match(scheduledCleanupFunction, /isManagedEvidencePath/);
assert.match(scheduledCleanupFunction, /queue_expired_evidence_cleanup/);
assert.match(scheduledCleanupFunction, /photo_cleanup_queue/);
assert.match(scheduledCleanupFunction, /record_photo_cleanup_queue_result/);
assert.doesNotMatch(scheduledCleanupFunction, /\.from\('orders'\)[\s\S]{0,160}\.update\(\{ pickup_photos/);

console.log('Photo storage monitoring contract tests passed.');
