// Focused regression tests for the new Storage Monitoring gallery/deletion
// SQL (20260915090000_simplify_storage_monitoring_gallery.sql), run against a
// real embedded Postgres (PGlite — compiled Postgres, not a mock). Same
// approach as scripts/shipping-discount-pgtest and
// scripts/payment-refund-recovery-pgtest: a hand-built harness schema gives
// just enough of the real orders/payment_transactions/profiles/auth shape,
// then the REAL migration file is applied verbatim on top, so what's tested
// is byte-for-byte the SQL that ships.
//
// What this file does NOT cover (see STORAGE_MONITORING_SIMPLIFICATION_IMPLEMENTATION.md
// for the explicit list of verification gaps): the delete-storage-photos Edge
// Function's actual Supabase Storage / Firestore calls, and the frontend
// gallery UI — those need a live/staging Supabase project and a browser.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..');

const db = new PGlite();
let passed = 0;
let failed = 0;

// PGlite's node driver returns a jsonb column already parsed into a JS
// array/object in some cases and as a raw string in others depending on the
// query path — normalize so tests don't care which.
const asArray = (value) => (Array.isArray(value) ? value : JSON.parse(value));

function ok(desc, cond, extra) {
  if (cond) { passed += 1; console.log(`  ok - ${desc}`); }
  else { failed += 1; console.log(`  FAIL - ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function asAdmin(adminId, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', 'authenticated', true)`, [adminId]);
    return fn(tx);
  });
}

async function asAnon(fn) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', '', true), set_config('app.role', 'anon', true)`);
    return fn(tx);
  });
}

console.log('== Loading harness schema (real orders/payment_transactions/is_admin shape) ==');
await db.exec(readFileSync(path.join(REPO, 'scripts/payment-ledger-pgtest/harness-schema.sql'), 'utf8'));

await db.exec(`
  -- Columns/tables the payment-ledger harness doesn't need but this
  -- migration's functions read: featured flag, status-change history, the
  -- durable cleanup queue, the routing-mode settings row, and a minimal
  -- storage.objects stand-in (real shape: bucket_id + name + metadata).
  ALTER TABLE public.orders ADD COLUMN featured_on_website BOOLEAN DEFAULT FALSE;
  ALTER TABLE public.orders ADD COLUMN featured_image_type TEXT;
  ALTER TABLE public.orders ADD COLUMN featured_at TIMESTAMPTZ;

  CREATE TABLE public.order_status_events (
    id BIGSERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE public.photo_cleanup_queue (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider = ANY (ARRAY['supabase','firebase'])),
    storage_path TEXT NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    UNIQUE (provider, storage_path)
  );

  CREATE TABLE public.photo_storage_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    upload_mode TEXT NOT NULL DEFAULT 'automatic',
    force_firebase_expires_at TIMESTAMPTZ,
    reason TEXT,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO public.photo_storage_settings (id) VALUES (TRUE);

  CREATE SCHEMA IF NOT EXISTS storage;
  CREATE TABLE storage.objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id TEXT,
    name TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  -- Real Supabase implementation: every path segment except the filename.
  CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
  RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
      WHEN array_length(string_to_array(name, '/'), 1) > 1
        THEN (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
      ELSE ARRAY[]::TEXT[]
    END;
  $$;

  -- Stand-in for pg_cron, same shape used in scripts/payment-refund-recovery-pgtest.
  CREATE SCHEMA IF NOT EXISTS cron;
  CREATE TABLE cron.job (jobid BIGSERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT, command TEXT);
  CREATE OR REPLACE FUNCTION cron.schedule(p_jobname TEXT, p_schedule TEXT, p_command TEXT)
  RETURNS BIGINT LANGUAGE plpgsql AS $$
  DECLARE v_id BIGINT;
  BEGIN
    INSERT INTO cron.job(jobname, schedule, command) VALUES (p_jobname, p_schedule, p_command)
    ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
    RETURNING jobid INTO v_id;
    RETURN v_id;
  END $$;

  -- Referenced by the migration's own retention-scheduling statement; not
  -- under test here (that's scripts/photo-storage-monitoring-contract-test.mjs's
  -- job), just needs to exist so the CREATE migration applies verbatim.
  CREATE OR REPLACE FUNCTION public.purge_old_photo_storage_events(retention_days INT DEFAULT 30)
  RETURNS INTEGER LANGUAGE sql AS $$ SELECT 0 $$;
  CREATE OR REPLACE FUNCTION public.purge_old_photo_cleanup_queue(retention_days INT DEFAULT 7)
  RETURNS INTEGER LANGUAGE sql AS $$ SELECT 0 $$;
`);

console.log('== Applying the real migration verbatim ==');
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20260915090000_simplify_storage_monitoring_gallery.sql'), 'utf8'));

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID = '00000000-0000-0000-0000-000000000002';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);

const MONTHS = (n) => `now() - interval '${n} months'`;

async function makeOrder(tracking, { status = 'Delivered', terminalMonthsAgo = 8, featured = false, pickupPhotos = [], deliveryPhotos = [] } = {}) {
  const r = await db.query(
    `INSERT INTO orders (tracking_number, status, user_id, featured_on_website, pickup_photos, delivery_photos)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tracking, status, CUST_ID, featured, JSON.stringify(pickupPhotos), JSON.stringify(deliveryPhotos)],
  );
  const orderId = r.rows[0].id;
  await db.query(
    `INSERT INTO order_status_events (order_id, status, changed_at) VALUES ($1, $2, ${MONTHS(terminalMonthsAgo)})`,
    [orderId, status],
  );
  return orderId;
}

const supabaseDescriptor = (path, extra = {}) => ({ type: 'supabase_storage', bucket: 'cargo-photos', path, ...extra });
const firebaseDescriptor = (fpath, extra = {}) => ({ type: 'firestore_fallback', firestore_path: fpath, ...extra });

async function classify(ref) {
  const r = await db.query(`SELECT * FROM public.classify_evidence_photo_ref($1::jsonb)`, [JSON.stringify(ref)]);
  return r.rows;
}

async function listPhotos(admin, opts = {}) {
  const { filter = 'all', search = null, page = 1, pageSize = 20 } = opts;
  const r = await asAdmin(admin, (tx) => tx.query(
    `SELECT * FROM public.list_evidence_photos($1, $2, $3, $4)`,
    [filter, search, page, pageSize],
  ));
  return r.rows;
}

async function deletePhotos(admin, items) {
  const r = await asAdmin(admin, (tx) => tx.query(
    `SELECT * FROM public.delete_evidence_photos($1::jsonb)`,
    [JSON.stringify(items)],
  ));
  return r.rows;
}

// ============================================================================
// 1. classify_evidence_photo_ref
// ============================================================================
console.log('\n-- classify_evidence_photo_ref --');
{
  const rows = await classify(supabaseDescriptor('pickup-proofs/ORDER-1/pickup-1.jpg', { size_bytes: 12345 }));
  ok('current supabase_storage descriptor classifies', rows.length === 1 && rows[0].provider === 'supabase' && Number(rows[0].size_bytes) === 12345, rows);
}
{
  const rows = await classify(firebaseDescriptor('photoFallbacks/abc123', { size_bytes: 500 }));
  ok('current firestore_fallback descriptor classifies', rows.length === 1 && rows[0].provider === 'firebase' && rows[0].storage_path === 'photoFallbacks/abc123', rows);
}
{
  const rows = await classify('pickup-proofs/ORDER-1/pickup-1.jpg');
  ok('legacy raw string path classifies as supabase', rows.length === 1 && rows[0].provider === 'supabase', rows);
}
{
  const rows = await classify('photoFallbacks/legacyDoc');
  ok('legacy raw firestore path string classifies as firebase', rows.length === 1 && rows[0].provider === 'firebase', rows);
}
{
  const rows = await classify('data:image/jpeg;base64,AAAA');
  ok('embedded data: URL is unclassified (no row)', rows.length === 0, rows);
}
{
  const rows = await classify(JSON.stringify(supabaseDescriptor('pickup-proofs/ORDER-2/pickup-1.jpg')));
  ok('double-encoded JSON string element classifies (parity with photoReference.js)', rows.length === 1 && rows[0].provider === 'supabase', rows);
}
{
  const rows = await classify({ type: 'direct_url', url: 'https://example.com/unrelated.jpg' });
  ok('unrelated direct_url object is unclassified (no row)', rows.length === 0, rows);
}

// ============================================================================
// 2. list_evidence_photos
// ============================================================================
console.log('\n-- list_evidence_photos --');

{
  let threw = false;
  try {
    await asAnon((tx) => tx.query(`SELECT * FROM public.list_evidence_photos('all', NULL, 1, 20)`));
  } catch (e) { threw = /Admin access required/.test(String(e.message || e)); }
  ok('non-admin caller is rejected', threw);
}

const oldDeliveredOrder = await makeOrder('ORDER-OLD-1', {
  status: 'Delivered', terminalMonthsAgo: 8,
  pickupPhotos: [supabaseDescriptor('pickup-proofs/ORDER-OLD-1/pickup-1.jpg', { size_bytes: 100 })],
  deliveryPhotos: [supabaseDescriptor('delivery-proofs/ORDER-OLD-1/delivery-1.jpg', { size_bytes: 200 })],
});
const recentDeliveredOrder = await makeOrder('ORDER-RECENT-1', {
  status: 'Delivered', terminalMonthsAgo: 1,
  pickupPhotos: [supabaseDescriptor('pickup-proofs/ORDER-RECENT-1/pickup-1.jpg', { size_bytes: 100 })],
});
const activeOrder = await makeOrder('ORDER-ACTIVE-1', {
  status: 'Assigned', terminalMonthsAgo: 8,
  pickupPhotos: [supabaseDescriptor('pickup-proofs/ORDER-ACTIVE-1/pickup-1.jpg', { size_bytes: 100 })],
});
const featuredOrder = await makeOrder('ORDER-FEATURED-1', {
  status: 'Delivered', terminalMonthsAgo: 10, featured: true,
  deliveryPhotos: [supabaseDescriptor('delivery-proofs/ORDER-FEATURED-1/delivery-1.jpg', { size_bytes: 100 })],
});
await db.query(
  `INSERT INTO payment_transactions (order_id, amount, payment_method, payment_status, receipt_url) VALUES ($1, 100, 'gcash', 'paid', $2)`,
  [oldDeliveredOrder, JSON.stringify(supabaseDescriptor('receipts/ORDER-OLD-1/receipt-1-1.jpg', { size_bytes: 50 }))],
);
await db.query(
  `INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('cargo-photos', 'pickup-proofs/ORDER-GONE-1/pickup-1.jpg', '{"size":"999"}'::jsonb)`,
);
// A referenced (not orphaned) object also exists in storage.objects — must
// never be misclassified as orphaned just because it's a real file, since a
// real order (oldDeliveredOrder) matches its tracking-number folder.
await db.query(
  `INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('cargo-photos', 'pickup-proofs/ORDER-OLD-1/pickup-1.jpg', '{"size":"100"}'::jsonb)`,
);

{
  const rows = await listPhotos(ADMIN_ID, { filter: 'all', pageSize: 50 });
  const byKey = Object.fromEntries(rows.map((r) => [r.storage_path, r]));

  ok('old delivered order pickup photo is eligible', byKey['pickup-proofs/ORDER-OLD-1/pickup-1.jpg']?.status === 'eligible', byKey['pickup-proofs/ORDER-OLD-1/pickup-1.jpg']);
  ok('old delivered order delivery photo is eligible', byKey['delivery-proofs/ORDER-OLD-1/delivery-1.jpg']?.status === 'eligible');
  ok('recently delivered order photo is protected (kept for 6 months)', byKey['pickup-proofs/ORDER-RECENT-1/pickup-1.jpg']?.status === 'protected'
    && /kept for 6 months/.test(byKey['pickup-proofs/ORDER-RECENT-1/pickup-1.jpg']?.reason || ''));
  ok('active shipment photo is protected regardless of age', byKey['pickup-proofs/ORDER-ACTIVE-1/pickup-1.jpg']?.status === 'protected'
    && /still in progress/.test(byKey['pickup-proofs/ORDER-ACTIVE-1/pickup-1.jpg']?.reason || ''));
  ok('featured order photo is protected regardless of age', byKey['delivery-proofs/ORDER-FEATURED-1/delivery-1.jpg']?.status === 'protected'
    && /Featured/.test(byKey['delivery-proofs/ORDER-FEATURED-1/delivery-1.jpg']?.reason || ''));
  ok('receipt photo is always protected', byKey['receipts/ORDER-OLD-1/receipt-1-1.jpg']?.status === 'protected'
    && /financial record/.test(byKey['receipts/ORDER-OLD-1/receipt-1-1.jpg']?.reason || ''));
  ok('orphaned file (no matching order) is eligible with source=orphan', byKey['pickup-proofs/ORDER-GONE-1/pickup-1.jpg']?.status === 'eligible'
    && byKey['pickup-proofs/ORDER-GONE-1/pickup-1.jpg']?.source === 'orphan');
  ok('a real file that IS still referenced is never listed as an orphan', byKey['pickup-proofs/ORDER-OLD-1/pickup-1.jpg']?.source === 'order');
}

{
  const rows = await listPhotos(ADMIN_ID, { filter: 'eligible', pageSize: 50 });
  ok('filter=eligible returns only eligible rows', rows.length > 0 && rows.every((r) => r.status === 'eligible'), rows.map((r) => r.status));
}
{
  const rows = await listPhotos(ADMIN_ID, { filter: 'protected', pageSize: 50 });
  ok('filter=protected returns only protected rows', rows.length > 0 && rows.every((r) => r.status === 'protected'), rows.map((r) => r.status));
}
{
  const rows = await listPhotos(ADMIN_ID, { filter: 'all', search: 'ORDER-OLD-1', pageSize: 50 });
  ok('search filters to the matching booking only', rows.length > 0 && rows.every((r) => r.tracking_number === 'ORDER-OLD-1' || r.tracking_number == null), rows.map((r) => r.tracking_number));
}
{
  const page1 = await listPhotos(ADMIN_ID, { filter: 'all', page: 1, pageSize: 2 });
  const totalCount = Number(page1[0]?.total_count || 0);
  ok('pagination reports a total_count and honors page size', page1.length === 2 && totalCount >= 6, { page1length: page1.length, totalCount });
}

// ============================================================================
// 3. delete_evidence_photos — the safety-critical re-verification path
// ============================================================================
console.log('\n-- delete_evidence_photos --');

{
  let threw = false;
  try { await asAnon((tx) => tx.query(`SELECT * FROM public.delete_evidence_photos($1::jsonb)`, ['[]'])); }
  catch (e) { threw = /Admin access required/.test(String(e.message || e)); }
  ok('non-admin caller is rejected', threw);
}

{
  let threw = false;
  try { await deletePhotos(ADMIN_ID, []); } catch (e) { threw = /At least one photo/.test(String(e.message || e)); }
  ok('empty selection is rejected', threw);
}

{
  let threw = false;
  try {
    await deletePhotos(ADMIN_ID, Array.from({ length: 101 }, (_, i) => ({ order_id: null, photo_field: 'pickup', provider: 'supabase', storage_path: `pickup-proofs/X/${i}.jpg` })));
  } catch (e) { threw = /Too many photos/.test(String(e.message || e)); }
  ok('more than 100 items in one request is rejected', threw);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: oldDeliveredOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-OLD-1/pickup-1.jpg',
  }]);
  ok('eligible referenced photo is queued for deletion', row.queued === true && row.queue_id != null, row);
  const order = (await db.query(`SELECT pickup_photos, delivery_photos FROM orders WHERE id=$1`, [oldDeliveredOrder])).rows[0];
  ok('only the deleted photo is removed from pickup_photos — the array is not wiped', asArray(order.pickup_photos).length === 0, order.pickup_photos);
  ok('delivery_photos on the same order is untouched by a pickup-field deletion', asArray(order.delivery_photos).length === 1, order.delivery_photos);
  const queueRow = (await db.query(`SELECT * FROM photo_cleanup_queue WHERE provider='supabase' AND storage_path=$1`, ['pickup-proofs/ORDER-OLD-1/pickup-1.jpg'])).rows[0];
  ok('a durable queue row exists for the actual provider deletion step', Boolean(queueRow) && queueRow.completed_at === null, queueRow);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: featuredOrder, photo_field: 'delivery', provider: 'supabase', storage_path: 'delivery-proofs/ORDER-FEATURED-1/delivery-1.jpg',
  }]);
  ok('featured photo is rejected server-side even if requested directly', row.queued === false && /Featured/.test(row.reason), row);
  const order = (await db.query(`SELECT delivery_photos FROM orders WHERE id=$1`, [featuredOrder])).rows[0];
  ok('rejected featured photo is NOT removed from the order', asArray(order.delivery_photos).length === 1, order.delivery_photos);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: activeOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-ACTIVE-1/pickup-1.jpg',
  }]);
  ok('active shipment photo is rejected server-side', row.queued === false && /still in progress/.test(row.reason), row);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: recentDeliveredOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-RECENT-1/pickup-1.jpg',
  }]);
  ok('not-yet-6-months photo is rejected server-side', row.queued === false && /kept for 6 months/.test(row.reason), row);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: oldDeliveredOrder, photo_field: 'receipt', provider: 'supabase', storage_path: 'receipts/ORDER-OLD-1/receipt-1-1.jpg',
  }]);
  ok('a receipt is always rejected, even on an otherwise-eligible order', row.queued === false && /Receipt photos are always kept/.test(row.reason), row);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: oldDeliveredOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-OLD-1/does-not-exist.jpg',
  }]);
  ok('a stale/tampered path that is not actually on the order is rejected', row.queued === false && /no longer matches this booking/.test(row.reason), row);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: '00000000-0000-0000-0000-0000000000ff', photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/X/1.jpg',
  }]);
  ok('a nonexistent booking is rejected', row.queued === false && /Booking not found/.test(row.reason), row);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: null, photo_field: null, provider: 'supabase', storage_path: 'pickup-proofs/ORDER-GONE-1/pickup-1.jpg',
  }]);
  ok('a genuinely orphaned file is queued', row.queued === true && row.queue_id != null, row);
}

{
  await db.query(`INSERT INTO orders (tracking_number, status, user_id) VALUES ('ORDER-NOWEXISTS-1', 'Pending', $1)`, [CUST_ID]);
  await db.query(`INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('cargo-photos', 'pickup-proofs/ORDER-NOWEXISTS-1/pickup-1.jpg', '{}'::jsonb)`);
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: null, photo_field: null, provider: 'supabase', storage_path: 'pickup-proofs/ORDER-NOWEXISTS-1/pickup-1.jpg',
  }]);
  ok('an orphan claim is re-checked at execution time — a booking that now exists blocks it', row.queued === false && /no longer unused/.test(row.reason), row);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: null, photo_field: null, provider: 'supabase', storage_path: 'pickup-proofs/DOES-NOT-EXIST/1.jpg',
  }]);
  ok('an orphan claim for a file that is not actually in storage is rejected', row.queued === false && /could not be found/.test(row.reason), row);
}

{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: null, photo_field: null, provider: 'firebase', storage_path: 'not-a-valid-shape',
  }]);
  ok('malformed firebase path is rejected as invalid', row.queued === false && /Invalid photo reference/.test(row.reason), row);
}

// Idempotent re-queue: deleting the same eligible photo twice (e.g. a retried
// request) must not create a second queue row or error out.
{
  const before = (await db.query(`SELECT count(*)::int AS n FROM photo_cleanup_queue WHERE provider='supabase' AND storage_path=$1`, ['pickup-proofs/ORDER-GONE-1/pickup-1.jpg'])).rows[0].n;
  await deletePhotos(ADMIN_ID, [{ order_id: null, photo_field: null, provider: 'supabase', storage_path: 'pickup-proofs/ORDER-GONE-1/pickup-1.jpg' }]);
  const after = (await db.query(`SELECT count(*)::int AS n FROM photo_cleanup_queue WHERE provider='supabase' AND storage_path=$1`, ['pickup-proofs/ORDER-GONE-1/pickup-1.jpg'])).rows[0].n;
  ok('re-queuing the same photo is idempotent (no duplicate queue row)', before === 1 && after === 1, { before, after });
}

// Mixed batch: one eligible, one protected, in the same call.
{
  const order = await makeOrder('ORDER-MIXED-1', {
    status: 'Delivered', terminalMonthsAgo: 9,
    pickupPhotos: [
      supabaseDescriptor('pickup-proofs/ORDER-MIXED-1/pickup-1.jpg', { size_bytes: 10 }),
      supabaseDescriptor('pickup-proofs/ORDER-MIXED-1/pickup-2.jpg', { size_bytes: 20 }),
    ],
  });
  // Make the order featured AFTER building the photo list so both entries
  // are protected together — proves a batch can mix distinct outcomes.
  const rows = await deletePhotos(ADMIN_ID, [
    { order_id: order, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-MIXED-1/pickup-1.jpg' },
    { order_id: order, photo_field: 'receipt', provider: 'supabase', storage_path: 'receipts/ORDER-MIXED-1/receipt-1.jpg' },
  ]);
  ok('a mixed batch returns one outcome row per requested item', rows.length === 2, rows);
  ok('the eligible item in a mixed batch is queued', rows[0].queued === true, rows[0]);
  ok('the receipt in the same mixed batch is still rejected', rows[1].queued === false && /Receipt/.test(rows[1].reason), rows[1]);
  const remaining = (await db.query(`SELECT pickup_photos FROM orders WHERE id=$1`, [order])).rows[0];
  ok('the second pickup photo on the same order is untouched', asArray(remaining.pickup_photos).length === 1, remaining.pickup_photos);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
