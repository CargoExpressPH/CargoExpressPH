import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'src/lib/supabase.js',
  'src/lib/storage.js',
  'src/lib/database.js',
  'supabase/schema.sql',
  'supabase/functions/send-push/index.ts',
  'supabase/functions/store-photo-fallback/index.ts',
  'supabase/functions/get-photo-fallback/index.ts',
  'supabase/functions/delete-photo-fallback/index.ts',
  'supabase/functions/record-photo-storage-event/index.ts',
  'supabase/functions/photo-storage-health/index.ts',
  'supabase/functions/cleanup-orphaned-photos/index.ts',
  'supabase/functions/archive-expired-evidence-photos/index.ts',
  'supabase/migrations/20260831170000_photo_storage_monitoring_and_routing.sql',
  'supabase/migrations/20260901010000_live_supabase_storage_usage.sql',
  'supabase/migrations/20260901020000_photo_storage_cleanup_archiving_and_alerts.sql',
  'supabase/migrations/20260901030000_safe_photo_cleanup_and_health_checks.sql',
  'supabase/functions/paymongo-create-payment/index.ts',
];

const requiredSchemaSnippets = [
  'track_order_public',
  'get_public_business_profile',
  'get_sales_summary',
  'cargo-photos',
  'is_featured_photo_path',
  'guard_profile_write',
  'prepare_order_insert',
  'guard_order_update',
  'photo_cleanup_queue',
  'queue_expired_evidence_cleanup',
];

const requiredStorageSnippets = [
  'supabase.storage',
];

const requiredDatabaseSnippets = [
  'Selected trip is no longer available',
  'await assertTripCapacity(trip, weight)',
  "finalStatus = 'Assigned'",
];

const missingFiles = requiredFiles.filter(file => !existsSync(file));
if (missingFiles.length > 0) {
  throw new Error(`Missing required files: ${missingFiles.join(', ')}`);
}

const schema = readFileSync('supabase/schema.sql', 'utf8');
const missingSchema = requiredSchemaSnippets.filter(snippet => !schema.includes(snippet));
if (missingSchema.length > 0) {
  throw new Error(`Missing schema hardening snippets: ${missingSchema.join(', ')}`);
}

const storage = readFileSync('src/lib/storage.js', 'utf8');
const missingStorage = requiredStorageSnippets.filter(snippet => !storage.includes(snippet));
if (missingStorage.length > 0) {
  throw new Error(`Missing storage snippets: ${missingStorage.join(', ')}`);
}

const database = readFileSync('src/lib/database.js', 'utf8');
const missingDatabase = requiredDatabaseSnippets.filter(snippet => !database.includes(snippet));
if (missingDatabase.length > 0) {
  throw new Error(`Missing selected-trip booking safeguards: ${missingDatabase.join(', ')}`);
}

if (database.includes('skip auto-assignment')) {
  throw new Error('Selected-trip booking still contains silent downgrade fallback.');
}

console.log('Smoke checks passed.');
