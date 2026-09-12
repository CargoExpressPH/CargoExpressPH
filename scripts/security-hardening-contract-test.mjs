import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = (path) => readFileSync(path, 'utf8');

const playwrightConfig = read('playwright.config.js');
const schemaSync = read('scripts/sync-schema-from-live.mjs');
const unsubscribe = read('supabase/functions/unsubscribe-announcements/index.ts');
const announcementPolicy = read('supabase/migrations/20260912020000_restrict_anonymous_announcements.sql');
const textLimits = read('supabase/migrations/20260912021000_bound_user_generated_text.sql');
const paymongoCreate = read('supabase/functions/paymongo-create-payment/index.ts');
const broadcast = read('supabase/functions/broadcast-announcement/index.ts');
const reminders = read('supabase/functions/process-daily-reminders/index.ts');
const reschedule = read('supabase/functions/email-trip-reschedule/index.ts');
const inquiry = read('supabase/functions/submit-inquiry/index.ts');
const login = read('src/pages/auth/LoginPage.jsx');
const vercel = JSON.parse(read('vercel.json'));
const storeFallback = read('supabase/functions/store-photo-fallback/index.ts');
const getFallback = read('supabase/functions/get-photo-fallback/index.ts');
const deleteFallback = read('supabase/functions/delete-photo-fallback/index.ts');
const archivePhotos = read('supabase/functions/archive-expired-evidence-photos/index.ts');
const storageHealth = read('supabase/functions/photo-storage-health/index.ts');
const browserStorage = read('src/lib/storage.js');
const paymentWebhook = read('supabase/functions/paymongo-webhook/index.ts');
const serviceWorker = read('public/sw.js');

for (const [name, source] of [
  ['Playwright configuration', playwrightConfig],
  ['schema synchronization tool', schemaSync],
]) {
  assert.doesNotMatch(
    source,
    /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/,
    `${name} must never disable TLS certificate verification`,
  );
}

assert.match(
  unsubscribe,
  /if \(req\.method !== 'GET' && req\.method !== 'POST'\)/,
  'unsubscribe must reject methods other than GET/POST/OPTIONS',
);
assert.match(
  unsubscribe,
  /if \(!signingSecret\)[\s\S]*?return html\([\s\S]*?, 503\)/,
  'unsubscribe must fail closed when its signing secret is absent',
);
assert.doesNotMatch(
  unsubscribe,
  /UNSUBSCRIBE_SIGNING_SECRET'\) \?\? ''/,
  'unsubscribe must not derive HMACs with a public empty key',
);
assert.match(
  unsubscribe,
  /escapeHtml\(email\)/,
  'untrusted email text must be escaped before insertion into HTML',
);
assert.match(unsubscribe, /Content-Security-Policy/);
assert.match(unsubscribe, /X-Content-Type-Options/);

assert.match(announcementPolicy, /DROP POLICY IF EXISTS "Anyone can view announcements"/);
assert.match(announcementPolicy, /TO authenticated\s+USING \(true\)/);
assert.doesNotMatch(announcementPolicy, /^\s*TO (?:anon|public)\b/m);

assert.match(paymongoCreate, /PAYMONGO_SOURCE_ID = \/\^src_/);
assert.match(paymongoCreate, /PAYMENT_ACTIONS = new Set\(\['capture', 'poll', 'register'\]\)/);
assert.match(paymongoCreate, /!PAYMENT_ACTIONS\.has\(normalizedAction\)/);
assert.match(paymongoCreate, /providerFetch\(`https:\/\/api\.paymongo\.com\/v1\/sources\/\$\{sourceId\}`/);
assert.doesNotMatch(paymongoCreate, /console\.(?:log|warn|error)\([^\n]*\$\{(?:sourceId|paymentId|tracking_number|userData\.user\.id)/);
assert.doesNotMatch(paymentWebhook, /console\.(?:log|warn|error)\([^\n]*\$\{(?:sourceId|paymentId|amount)/);
assert.match(paymentWebhook, /MAX_WEBHOOK_BYTES/);
assert.match(paymentWebhook, /new TextEncoder\(\)\.encode\(rawBody\)\.length > MAX_WEBHOOK_BYTES/);

for (const [name, source] of [
  ['broadcast-announcement', broadcast],
  ['process-daily-reminders', reminders],
  ['email-trip-reschedule', reschedule],
]) {
  assert.match(source, /if \(req\.method !== 'POST'\).*405/, `${name} must reject non-POST methods`);
  assert.match(source, /AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/, `${name} provider calls need a timeout`);
  assert.doesNotMatch(source, /Resend batch failed:', res\.status, await res\.text\(\)/);
}
assert.doesNotMatch(browserStorage, /console\.(?:log|info|warn|error)\([^\n]*(?:trackingNumber|firestore_path|error\?\.message)/);

assert.match(serviceWorker, /if \(isApiRequest\(url\)\)[\s\S]*?networkFirst\(request\)/);
assert.doesNotMatch(serviceWorker.match(/async function networkFirst[\s\S]*?^}/m)?.[0] || '', /cache\.put|caches\.open/);

assert.match(inquiry, /typeof name !== 'string' \|\| typeof message !== 'string'/);
assert.match(inquiry, /typeof contact_phone !== 'string'/);
assert.doesNotMatch(login, /User logged in with email:/);

assert.match(storeFallback, /UUID_RE\.test\(order_id\)/);
assert.match(storeFallback, /content_type !== 'image\/jpeg'/);
assert.match(storeFallback, /Number\.isSafeInteger\(size_bytes\)/);
assert.match(storeFallback, /JPEG data_url is malformed/);
assert.match(storeFallback, /decodedPhoto\.length !== size_bytes/);
assert.match(storeFallback, /decodedPhoto\.charCodeAt\(0\) !== 0xff/);
for (const [name, source] of [
  ['store-photo-fallback', storeFallback],
  ['get-photo-fallback', getFallback],
  ['delete-photo-fallback', deleteFallback],
  ['archive-expired-evidence-photos', archivePhotos],
  ['photo-storage-health', storageHealth],
]) {
  assert.match(source, /AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/, `${name} provider calls need a timeout`);
}

const appHeaders = vercel.headers.find((entry) => entry.source === '/(.*)')?.headers || [];
const csp = appHeaders.find((header) => header.key === 'Content-Security-Policy')?.value || '';
assert.match(csp, /default-src 'self'/);
assert.match(csp, /script-src 'self'/);
assert.match(csp, /script-src[^;]*https:\/\/www\.gstatic\.com/);
assert.match(csp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
assert.match(csp, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
assert.match(csp, /object-src 'none'/);
assert.match(csp, /frame-ancestors 'none'/);

assert.match(textLimits, /chat_messages_message_length[\s\S]*BETWEEN 1 AND 1000[\s\S]*NOT VALID/);
assert.match(textLimits, /customer_feedback_message_length[\s\S]*BETWEEN 1 AND 2000[\s\S]*NOT VALID/);

// Execute the corrective policy migration in a disposable in-memory database;
// this validates SQL syntax and the resulting role list without touching the
// linked Supabase project.
const policyDb = new PGlite();
await policyDb.exec(`
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE TABLE public.announcements (id UUID, is_active BOOLEAN);
  ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Anyone can view announcements"
    ON public.announcements FOR SELECT TO public USING (true);
`);
await policyDb.exec(announcementPolicy);
const policies = await policyDb.query(`
  SELECT policyname, roles
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'announcements'
   ORDER BY policyname
`);
assert.deepEqual(policies.rows, [{
  policyname: 'Authenticated users can view announcements',
  roles: ['authenticated'],
}]);
await policyDb.exec(`
  CREATE TABLE public.chat_messages (message TEXT NOT NULL);
  CREATE TABLE public.customer_feedback (message TEXT NOT NULL);
`);
await policyDb.exec(textLimits);
await policyDb.exec(`
  INSERT INTO public.chat_messages (message) VALUES ('valid message');
  INSERT INTO public.customer_feedback (message) VALUES ('valid feedback');
`);
await assert.rejects(
  policyDb.exec(`INSERT INTO public.chat_messages (message) VALUES ('   ')`),
  /chat_messages_message_length/,
);
await assert.rejects(
  policyDb.exec(`INSERT INTO public.customer_feedback (message) VALUES (repeat('x', 2001))`),
  /customer_feedback_message_length/,
);
await policyDb.close();

console.log('Security hardening contract tests passed.');
