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
const folderMigration = read('supabase/migrations/20260915110000_photo_storage_folder_browser.sql');
const storage = read('src/lib/storage.js');
const database = read('src/lib/database.js');
const page = read('src/pages/admin/PhotoStorageTab.jsx');
const css = read('src/styles/admin-composition.css');
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
  'cleanup-orphaned-photos was superseded by delete-storage-photos + the unified gallery and should stay removed locally — see STORAGE_FOLDER_BROWSER_IMPLEMENTATION.md for its live-undeploy status.',
);

// ── Original module DDL (unchanged by the folder-browser redesign) ────────
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

// The AUTOMATIC 6-month cleanup rule lives ONLY in get_expired_evidence_orders
// (called by archive-expired-evidence-photos) and is completely untouched by
// this task — it never calls, and is never called by, anything the folder
// browser migration defines.
assert.match(cleanupMigration, /get_expired_evidence_orders/);
// The folder migration may only ever MENTION get_expired_evidence_orders in
// prose (explaining the separation) — it must never actually CALL it.
assert.doesNotMatch(folderMigration, /(SELECT|FROM|JOIN)\s+public\.get_expired_evidence_orders|\.rpc\('get_expired_evidence_orders'/);
assert.doesNotMatch(scheduledCleanupFunction, /list_evidence_folders|list_folder_photos|delete_evidence_photos/);

// ── 20260915090000: still provides the classifiers the folder browser depends on ──
assert.match(galleryMigration, /CREATE OR REPLACE FUNCTION public\.text_to_photo_ref/);
assert.match(galleryMigration, /CREATE OR REPLACE FUNCTION public\.classify_evidence_photo_ref/);

// ── 20260915110000: folder browser + corrected manual-deletion rule ───────
assert.match(folderMigration, /DROP FUNCTION IF EXISTS public\.list_evidence_photos\(text, text, integer, integer\)/);
assert.match(folderMigration, /CREATE OR REPLACE FUNCTION public\.evidence_photo_rows\(\)/);
assert.match(folderMigration, /CREATE OR REPLACE FUNCTION public\.list_evidence_folders/);
assert.match(folderMigration, /CREATE OR REPLACE FUNCTION public\.list_folder_photos/);
assert.match(folderMigration, /CREATE OR REPLACE FUNCTION public\.delete_evidence_photos/);
assert.match(folderMigration, /CREATE OR REPLACE FUNCTION public\.check_company_asset_deletable/);
// Every admin-facing function re-checks admin from scratch.
assert.match(folderMigration, /RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501'/);
// The corrected manual-deletion rule: 6-month wait is GONE from this file...
assert.doesNotMatch(folderMigration, /kept for 6 months/i);
assert.doesNotMatch(folderMigration, /v_cutoff timestamptz := now\(\) - INTERVAL '6 months'/);
// terminal_status_at may still be mentioned in prose (explaining what was
// removed and why) but must never be DECLARED as a working variable again.
assert.doesNotMatch(folderMigration, /v_terminal_status_at\s+timestamptz/);
// ...receipt/featured/active-shipment protections remain...
assert.match(folderMigration, /Receipt photos are always kept/);
assert.match(folderMigration, /Featured on the public website/);
assert.match(folderMigration, /Shipment is still in progress/);
assert.match(folderMigration, /Photo reference no longer matches this booking/);
// ...and the new pending-payment-reconciliation protection is present, using
// the SAME classify-and-compare pattern the array-rebuild loop already used
// (never raw jsonb equality against a reconstructed object).
assert.match(folderMigration, /status IN \('pending', 'chargeable'\)/);
assert.match(folderMigration, /still being reconciled/);
assert.match(folderMigration, /classify_evidence_photo_ref\(pe\.value\)/);
// Row-locked before the jsonb array is rewritten, so a concurrent edit can't
// be silently overwritten.
assert.match(folderMigration, /FOR UPDATE;/);
// Orphan claims are re-verified at execution time too.
assert.match(folderMigration, /it is no longer unused/i);
// Deletion is queued through the existing durable retry table, never a
// direct provider delete from inside SQL, and never a row DELETE either.
assert.match(folderMigration, /INSERT INTO public\.photo_cleanup_queue/);
assert.doesNotMatch(folderMigration, /DELETE FROM storage\.objects/i);
assert.doesNotMatch(folderMigration, /DELETE FROM public\.orders/i);
assert.doesNotMatch(folderMigration, /DELETE FROM public\.payment_transactions/i);
// Grants: PUBLIC and anon both explicitly revoked (the audit-flagged gap on
// the previous migration's list/delete functions) — only `authenticated`
// can call any admin-gated function here.
for (const fn of [
  'list_evidence_folders\\(text, integer, integer\\)',
  'list_folder_photos\\(text, integer, integer\\)',
  'delete_evidence_photos\\(jsonb\\)',
  'check_company_asset_deletable\\(text\\[\\]\\)',
]) {
  const revokePublic = new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC`);
  const revokeAnon = new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM anon`);
  const grantAuth = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO authenticated`);
  assert.match(folderMigration, revokePublic, `${fn} missing REVOKE ... FROM PUBLIC`);
  assert.match(folderMigration, revokeAnon, `${fn} missing REVOKE ... FROM anon`);
  assert.match(folderMigration, grantAuth, `${fn} missing GRANT ... TO authenticated`);
}
// evidence_photo_rows() is deliberately NOT granted to authenticated/anon —
// only called internally by the two wrapper functions above.
assert.doesNotMatch(folderMigration, /GRANT EXECUTE ON FUNCTION public\.evidence_photo_rows\(\) TO authenticated/);

// ── Upload/fallback client code is unchanged by this task ──────────────────
assert.match(storage, /get_effective_photo_storage_mode/);
assert.match(storage, /force_firebase/);
assert.match(storage, /record-photo-storage-event/);
assert.match(storage, /Firebase fallback upload failed/);

// ── database.js: folder-browser wrappers present, old flat-list wrapper gone ──
assert.match(database, /export const listEvidenceFolders/);
assert.match(database, /export const listFolderPhotos/);
assert.match(database, /export const deleteEvidencePhotos/);
assert.match(database, /export const checkCompanyAssetDeletable/);
assert.match(database, /list_evidence_folders/);
assert.match(database, /list_folder_photos/);
assert.match(database, /check_company_asset_deletable/);
assert.match(database, /delete-storage-photos/);
assert.match(database, /export const checkPhotoStorageHealth/);
assert.match(database, /export const getPhotoStorageSummary/);
assert.doesNotMatch(database, /export const listEvidencePhotos\b/);
assert.doesNotMatch(database, /export const getPhotoStorageMode/);
assert.doesNotMatch(database, /export const setPhotoStorageMode/);
assert.doesNotMatch(database, /export const checkUnusedPhotos/);
assert.doesNotMatch(database, /export const removeUnusedPhotos/);
assert.doesNotMatch(database, /export const getPhotoStorageEvents/);
assert.doesNotMatch(database, /cleanup-orphaned-photos/);

// ── Three-column folder browser page ───────────────────────────────────────
// The flat All Photos / Can Be Deleted / Still Needed classification tabs
// are gone — this is the actual redesign, not a cosmetic rename.
assert.doesNotMatch(page, /All Photos/);
assert.doesNotMatch(page, /'Can Be Deleted'/);
assert.doesNotMatch(page, /'Still Needed'/);
assert.doesNotMatch(page, /Still Needed<\/span>/);
assert.doesNotMatch(page, /listEvidencePhotos\(/);
// No leftover manual-routing / diagnostic clutter.
assert.doesNotMatch(page, /force_firebase/);
assert.doesNotMatch(page, /Technical Details/);
assert.doesNotMatch(page, /Recent Photo Activity/);
assert.doesNotMatch(page, /postgres_changes/);
// Core usage summary is kept, honestly labelled, compact.
assert.match(page, /Storage Usage/);
assert.match(page, /role="progressbar"/);
assert.match(page, /included_storage_bytes/);
assert.match(page, /'<1%'/);
// The three-column browser itself.
assert.match(page, /storage-browser/);
assert.match(page, /storage-col-folders/);
assert.match(page, /storage-col-photos/);
assert.match(page, /storage-col-preview/);
assert.match(page, /listEvidenceFolders/);
assert.match(page, /listFolderPhotos/);
assert.match(page, /Photos Without Bookings/);
assert.match(page, /Search tracking number/);
assert.match(page, /permanently removed from storage\. This cannot be undone/);
assert.match(page, /booking and payment records remain/i);
// Stale-response guards for both folder listing and per-folder photo fetch.
assert.match(page, /requestId !== folderSeq\.current/);
assert.match(page, /requestId !== photoSeq\.current/);
// Single-photo delete action from the preview pane.
assert.match(page, /Delete This Photo/);

// ── Bulk checkbox-selection UI is GONE from the Cargo Photos browser — the
// three-dot folder menu replaced it, it did not join it. Scoped to the
// CargoPhotoBrowser component's own source (CompanyImagesBrowser, an
// unrelated/out-of-scope bucket, legitimately keeps its own separate
// checkbox multi-select — these checks must not false-positive on that). ──
const cargoBrowserSource = page.slice(page.indexOf('const CargoPhotoBrowser'), page.indexOf('const CompanyImagesBrowser'));
assert.doesNotMatch(cargoBrowserSource, /Select all eligible/);
assert.doesNotMatch(cargoBrowserSource, /Delete Selected/);
assert.doesNotMatch(cargoBrowserSource, /storage-selection-bar/);
assert.doesNotMatch(cargoBrowserSource, /storage-col-toolbar/);
assert.doesNotMatch(cargoBrowserSource, /storage-photo-row-checkbox/);
assert.doesNotMatch(cargoBrowserSource, /toggleSelectAllLoaded/);
assert.doesNotMatch(cargoBrowserSource, /eligibleLoaded/);
assert.doesNotMatch(cargoBrowserSource, /\bselectedList\b/);
assert.doesNotMatch(cargoBrowserSource, /selectedBytesKnown|selectedBytesTotal/);
assert.doesNotMatch(cargoBrowserSource, /CheckSquare/);
// PhotoRow (also scoped from this same source, defined just above
// CargoPhotoBrowser) takes no selection props — clicking a row only opens
// the preview.
assert.doesNotMatch(page, /canSelect = item\.status === 'eligible'/);
const photoRowSource = page.slice(page.indexOf('const PhotoRow'), page.indexOf('const PreviewPane'));
assert.doesNotMatch(photoRowSource, /onToggleSelect|aria-pressed/);
assert.match(photoRowSource, /const PhotoRow = \(\{ item, thumbUrl, active, onOpen \}\)/);

// ── Per-folder "⋮" actions menu (compact, not a large folder-level button) ──
assert.match(page, /MoreVertical/);
assert.match(page, /Delete Photos in Folder/);
assert.match(page, /role="menu"/);
assert.match(page, /role="menuitem"/);
assert.match(page, /aria-haspopup="menu"/);
assert.match(page, /aria-expanded=\{open\}/);
assert.match(page, /Photo actions for \$\{label\}/);
// Portal-rendered so the folder column's own overflow-y:auto never clips it.
assert.match(page, /createPortal/);
assert.match(page, /document\.body/);
// Escape closes and focus returns to the trigger.
assert.match(page, /e\.key === 'Escape'/);
assert.match(page, /triggerRef\.current\?\.focus\(\)/);
// The menu action resolves the COMPLETE folder (paginated), never assumes
// the first page is everything, before any confirmation is shown.
assert.match(page, /resolveFolderPhotos/);
assert.match(page, /FOLDER_RESOLVE_PAGE_SIZE/);
assert.match(page, /while \(all\.length < total\)/);
// Confirmation is explicit about what remains protected, not just what's deleted.
assert.match(page, /will remain in this folder because/);
assert.match(page, /can be deleted right now — .*still protected/);
// Reuses the SAME deletion RPC/edge-function path as single-photo delete —
// no parallel implementation for the folder-menu action, and exactly two
// delete sources exist (folder-menu, single preview photo) — no third,
// checkbox-selection-backed source.
assert.match(page, /confirmFolderTarget \? confirmFolderTarget\.items : confirmTarget \? \[confirmTarget\] : \[\]/);
// The nested-button-inside-a-button trap is avoided: each folder row is a
// row container with two SIBLING interactive controls (select + menu).
assert.match(page, /storage-folder-row-main/);
assert.doesNotMatch(page, /<button[^>]*storage-folder-row[^>]*>[\s\S]{0,400}<button/);

// Company Images tab.
assert.match(page, /CompanyImagesBrowser/);
assert.match(page, /checkCompanyAssetDeletable/);
assert.match(page, /company-assets/);
assert.match(page, /Company Images/);
assert.doesNotMatch(page, /> Refresh\s*</);

// ── CSS: three-column desktop grid collapsing to sequential mobile panes ───
assert.match(css, /\.storage-browser\s*\{/);
assert.match(css, /grid-template-columns:\s*260px/);
assert.match(css, /@media \(max-width: 900px\)/);
assert.match(css, /\.storage-browser\[data-pane="folders"\] \.storage-col-folders/);
assert.match(css, /\.storage-browser\[data-pane="photos"\] \.storage-col-photos/);
assert.match(css, /\.storage-browser\[data-pane="preview"\] \.storage-col-preview/);
assert.match(css, /\.storage-browser-mobile-back/);

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
