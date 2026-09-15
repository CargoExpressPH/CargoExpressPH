// Focused regression tests for the Storage Monitoring three-column folder
// browser SQL (20260915110000_photo_storage_folder_browser.sql), run against
// a real embedded Postgres (PGlite — compiled Postgres, not a mock). Same
// approach as scripts/shipping-discount-pgtest and
// scripts/payment-refund-recovery-pgtest: a hand-built harness schema gives
// just enough of the real orders/payment_transactions/payment_attempts/
// profiles/auth shape, then the REAL migration files are applied verbatim on
// top — first 20260915090000 (defines classify_evidence_photo_ref/
// text_to_photo_ref, which the new migration still depends on), then
// 20260915110000 (the folder browser + corrected manual-deletion rule under
// test) — so what's tested is byte-for-byte the SQL that ships.
//
// What this file does NOT cover (see STORAGE_FOLDER_BROWSER_IMPLEMENTATION.md
// for the explicit list of verification gaps): the delete-storage-photos Edge
// Function's actual Supabase Storage / Firestore calls, the Storage SDK
// list()/remove() calls the Company Images tab makes directly, and the
// frontend UI — those need a live/staging Supabase project and a browser.
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
  -- Columns/tables the payment-ledger harness doesn't need but the folder
  -- browser functions read: featured flag, sender/receiver names (folder
  -- customer_name), the durable cleanup queue, the routing-mode settings
  -- row, company_information (banner-in-use check), and a minimal
  -- storage.objects stand-in (real shape: bucket_id + name + metadata).
  ALTER TABLE public.orders ADD COLUMN featured_on_website BOOLEAN DEFAULT FALSE;
  ALTER TABLE public.orders ADD COLUMN sender_name TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_name TEXT;

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

  CREATE TABLE public.company_information (
    id UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001',
    banner_image_url TEXT
  );
  INSERT INTO public.company_information (id) VALUES ('00000000-0000-0000-0000-000000000001');

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

  -- Referenced by 20260915090000's own retention-scheduling statement; not
  -- under test here, just needs to exist so that migration applies verbatim.
  CREATE OR REPLACE FUNCTION public.purge_old_photo_storage_events(retention_days INT DEFAULT 30)
  RETURNS INTEGER LANGUAGE sql AS $$ SELECT 0 $$;
  CREATE OR REPLACE FUNCTION public.purge_old_photo_cleanup_queue(retention_days INT DEFAULT 7)
  RETURNS INTEGER LANGUAGE sql AS $$ SELECT 0 $$;
`);

console.log('== Applying 20260915090000 verbatim (classify_evidence_photo_ref / text_to_photo_ref, still depended on) ==');
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20260915090000_simplify_storage_monitoring_gallery.sql'), 'utf8'));

console.log('== Applying 20260915110000 verbatim (folder browser + corrected manual-deletion rule, under test) ==');
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20260915110000_photo_storage_folder_browser.sql'), 'utf8'));

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID = '00000000-0000-0000-0000-000000000002';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);

async function makeOrder(tracking, { status = 'Delivered', featured = false, receiverName = 'Juan Dela Cruz', pickupPhotos = [], deliveryPhotos = [] } = {}) {
  const r = await db.query(
    `INSERT INTO orders (tracking_number, status, user_id, featured_on_website, receiver_name, pickup_photos, delivery_photos)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tracking, status, CUST_ID, featured, receiverName, JSON.stringify(pickupPhotos), JSON.stringify(deliveryPhotos)],
  );
  return r.rows[0].id;
}

const supabaseDescriptor = (path, extra = {}) => ({ type: 'supabase_storage', bucket: 'cargo-photos', path, ...extra });

async function classify(ref) {
  const r = await db.query(`SELECT * FROM public.classify_evidence_photo_ref($1::jsonb)`, [JSON.stringify(ref)]);
  return r.rows;
}

async function listFolders(admin, opts = {}) {
  const { search = null, page = 1, pageSize = 30 } = opts;
  const r = await asAdmin(admin, (tx) => tx.query(
    `SELECT * FROM public.list_evidence_folders($1, $2, $3)`, [search, page, pageSize],
  ));
  return r.rows;
}

async function listFolderPhotos(admin, folderKey, opts = {}) {
  const { page = 1, pageSize = 100 } = opts;
  const r = await asAdmin(admin, (tx) => tx.query(
    `SELECT * FROM public.list_folder_photos($1, $2, $3)`, [folderKey, page, pageSize],
  ));
  return r.rows;
}

async function deletePhotos(admin, items) {
  const r = await asAdmin(admin, (tx) => tx.query(
    `SELECT * FROM public.delete_evidence_photos($1::jsonb)`, [JSON.stringify(items)],
  ));
  return r.rows;
}

// ============================================================================
// 1. classify_evidence_photo_ref (unchanged function — smoke-test only)
// ============================================================================
console.log('\n-- classify_evidence_photo_ref --');
{
  const rows = await classify(supabaseDescriptor('pickup-proofs/ORDER-1/pickup-1.jpg', { size_bytes: 12345 }));
  ok('current supabase_storage descriptor classifies', rows.length === 1 && rows[0].provider === 'supabase' && Number(rows[0].size_bytes) === 12345, rows);
}

// ============================================================================
// 2. Fixtures shared by list_evidence_folders / list_folder_photos / delete_evidence_photos
// ============================================================================
const deliveredOrder = await makeOrder('ORDER-DELIVERED-1', {
  status: 'Delivered', receiverName: 'Ana Reyes',
  pickupPhotos: [supabaseDescriptor('pickup-proofs/ORDER-DELIVERED-1/pickup-1.jpg', { size_bytes: 100 })],
  deliveryPhotos: [supabaseDescriptor('delivery-proofs/ORDER-DELIVERED-1/delivery-1.jpg', { size_bytes: 200 })],
});
const activeOrder = await makeOrder('ORDER-ACTIVE-1', {
  status: 'Assigned', receiverName: 'Bea Santos',
  pickupPhotos: [supabaseDescriptor('pickup-proofs/ORDER-ACTIVE-1/pickup-1.jpg', { size_bytes: 100 })],
});
const featuredOrder = await makeOrder('ORDER-FEATURED-1', {
  status: 'Delivered', featured: true,
  deliveryPhotos: [supabaseDescriptor('delivery-proofs/ORDER-FEATURED-1/delivery-1.jpg', { size_bytes: 100 })],
});
const pendingPaymentOrder = await makeOrder('ORDER-PENDING-PAY-1', {
  status: 'Delivered',
  pickupPhotos: [supabaseDescriptor('pickup-proofs/ORDER-PENDING-PAY-1/pickup-1.jpg', { size_bytes: 150 })],
});
const reconciledPaymentOrder = await makeOrder('ORDER-RECONCILED-PAY-1', {
  status: 'Delivered',
  pickupPhotos: [supabaseDescriptor('pickup-proofs/ORDER-RECONCILED-PAY-1/pickup-1.jpg', { size_bytes: 150 })],
});
await db.query(
  `INSERT INTO payment_transactions (order_id, amount, payment_method, payment_status, receipt_url) VALUES ($1, 100, 'gcash', 'paid', $2)`,
  [deliveredOrder, JSON.stringify(supabaseDescriptor('receipts/ORDER-DELIVERED-1/receipt-1-1.jpg', { size_bytes: 50 }))],
);
await db.query(
  `INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('cargo-photos', 'pickup-proofs/ORDER-GONE-1/pickup-1.jpg', '{"size":"999"}'::jsonb)`,
);
// A referenced (not orphaned) object also exists in storage.objects — must
// never be misclassified as orphaned just because it's a real file, since a
// real order (deliveredOrder) matches its tracking-number folder.
await db.query(
  `INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('cargo-photos', 'pickup-proofs/ORDER-DELIVERED-1/pickup-1.jpg', '{"size":"100"}'::jsonb)`,
);
// A PENDING (not yet reconciled) payment attempt referencing the exact same
// pickup photo the order already has on file — the new protection.
await db.query(
  `INSERT INTO payment_attempts (source_id, order_id, amount, status, pickup_photos) VALUES ('src-pending-1', $1, 500, 'pending', $2)`,
  [pendingPaymentOrder, JSON.stringify([supabaseDescriptor('pickup-proofs/ORDER-PENDING-PAY-1/pickup-1.jpg', { size_bytes: 150 })])],
);
// A RECONCILED payment attempt referencing a different order's photo — pure
// history, must NOT block anything.
await db.query(
  `INSERT INTO payment_attempts (source_id, order_id, amount, status, reconciled_at, pickup_photos) VALUES ('src-reconciled-1', $1, 500, 'reconciled', now(), $2)`,
  [reconciledPaymentOrder, JSON.stringify([supabaseDescriptor('pickup-proofs/ORDER-RECONCILED-PAY-1/pickup-1.jpg', { size_bytes: 150 })])],
);

// ============================================================================
// 3. list_evidence_folders — LEFT column
// ============================================================================
console.log('\n-- list_evidence_folders --');
{
  let threw = false;
  try { await asAnon((tx) => tx.query(`SELECT * FROM public.list_evidence_folders(NULL, 1, 30)`)); }
  catch (e) { threw = /Admin access required/.test(String(e.message || e)); }
  ok('anonymous caller is rejected', threw);
}
{
  let threw = false;
  try { await asAdmin(CUST_ID, (tx) => tx.query(`SELECT * FROM public.list_evidence_folders(NULL, 1, 30)`)); }
  catch (e) { threw = /Admin access required/.test(String(e.message || e)); }
  ok('an authenticated but non-admin (customer) session is rejected', threw);
}
{
  const rows = await listFolders(ADMIN_ID, { pageSize: 50 });
  const byKey = Object.fromEntries(rows.map((r) => [r.folder_key, r]));
  // pickup + delivery + the receipt seeded via payment_transactions below.
  ok('one folder per tracking number, counting pickup + delivery + receipt', Number(byKey['ORDER-DELIVERED-1']?.photo_count) === 3, byKey['ORDER-DELIVERED-1']);
  ok('folder carries a customer name', byKey['ORDER-DELIVERED-1']?.customer_name === 'Ana Reyes');
  ok('folder carries the order status', byKey['ORDER-DELIVERED-1']?.order_status === 'Delivered');
  ok('eligible_count excludes the protected receipt on that folder', Number(byKey['ORDER-DELIVERED-1']?.eligible_count) === 2);
  ok('the unbooked catch-all folder exists and groups orphans', byKey['__unbooked__'] && Number(byKey['__unbooked__'].photo_count) >= 1, byKey['__unbooked__']);
  ok('the unbooked folder has no tracking_number/customer_name', byKey['__unbooked__']?.tracking_number == null && byKey['__unbooked__']?.customer_name == null);
}
{
  const rows = await listFolders(ADMIN_ID, { search: 'ORDER-ACTIVE-1', pageSize: 50 });
  ok('search filters to the matching booking folder only', rows.length === 1 && rows[0].folder_key === 'ORDER-ACTIVE-1', rows);
}
{
  const page1 = await listFolders(ADMIN_ID, { page: 1, pageSize: 2 });
  const totalCount = Number(page1[0]?.total_count || 0);
  ok('folder pagination reports a total_count and honors page size', page1.length === 2 && totalCount >= 5, { length: page1.length, totalCount });
}

// ============================================================================
// 4. list_folder_photos — MIDDLE column
// ============================================================================
console.log('\n-- list_folder_photos --');
{
  let threw = false;
  try { await asAnon((tx) => tx.query(`SELECT * FROM public.list_folder_photos('ORDER-DELIVERED-1', 1, 100)`)); }
  catch (e) { threw = /Admin access required/.test(String(e.message || e)); }
  ok('non-admin caller is rejected', threw);
}
{
  const rows = await listFolderPhotos(ADMIN_ID, 'ORDER-DELIVERED-1');
  const byPath = Object.fromEntries(rows.map((r) => [r.storage_path, r]));
  ok('a Delivered booking\'s pickup photo is eligible IMMEDIATELY (no 6-month wait)', byPath['pickup-proofs/ORDER-DELIVERED-1/pickup-1.jpg']?.status === 'eligible', byPath['pickup-proofs/ORDER-DELIVERED-1/pickup-1.jpg']);
  ok('the reason no longer mentions a 6-month wait', !/6 month/i.test(byPath['pickup-proofs/ORDER-DELIVERED-1/pickup-1.jpg']?.reason || ''));
  ok('the receipt on that same folder is still protected', byPath['receipts/ORDER-DELIVERED-1/receipt-1-1.jpg']?.status === 'protected'
    && /financial record/.test(byPath['receipts/ORDER-DELIVERED-1/receipt-1-1.jpg']?.reason || ''));
}
{
  const rows = await listFolderPhotos(ADMIN_ID, 'ORDER-ACTIVE-1');
  ok('active shipment photo is protected regardless of age', rows[0]?.status === 'protected' && /still in progress/.test(rows[0]?.reason || ''), rows[0]);
}
{
  const rows = await listFolderPhotos(ADMIN_ID, 'ORDER-FEATURED-1');
  ok('featured order photo is protected regardless of status', rows[0]?.status === 'protected' && /Featured/.test(rows[0]?.reason || ''), rows[0]);
}
{
  const rows = await listFolderPhotos(ADMIN_ID, 'ORDER-PENDING-PAY-1');
  ok('a pickup photo referenced by a PENDING payment attempt is protected', rows[0]?.status === 'protected' && /still being reconciled/.test(rows[0]?.reason || ''), rows[0]);
}
{
  const rows = await listFolderPhotos(ADMIN_ID, 'ORDER-RECONCILED-PAY-1');
  ok('a pickup photo referenced only by a RECONCILED payment attempt is NOT blocked', rows[0]?.status === 'eligible', rows[0]);
}
{
  const rows = await listFolderPhotos(ADMIN_ID, '__unbooked__');
  ok('the unbooked folder lists the orphaned file', rows.some((r) => r.storage_path === 'pickup-proofs/ORDER-GONE-1/pickup-1.jpg' && r.source === 'orphan'), rows);
  ok('a real file that IS still referenced never appears under __unbooked__', !rows.some((r) => r.storage_path === 'pickup-proofs/ORDER-DELIVERED-1/pickup-1.jpg'));
}

// ============================================================================
// 5. delete_evidence_photos — corrected eligibility, re-verified server-side
// ============================================================================
console.log('\n-- delete_evidence_photos --');

{
  let threw = false;
  try { await asAnon((tx) => tx.query(`SELECT * FROM public.delete_evidence_photos($1::jsonb)`, ['[]'])); }
  catch (e) { threw = /Admin access required/.test(String(e.message || e)); }
  ok('anonymous caller is rejected', threw);
}
{
  let threw = false;
  try {
    await asAdmin(CUST_ID, (tx) => tx.query(`SELECT * FROM public.delete_evidence_photos($1::jsonb)`, [JSON.stringify([{
      order_id: deliveredOrder, photo_field: 'delivery', provider: 'supabase', storage_path: 'delivery-proofs/ORDER-DELIVERED-1/delivery-1.jpg',
    }])]));
  } catch (e) { threw = /Admin access required/.test(String(e.message || e)); }
  ok('an authenticated but non-admin (customer) cannot record a deletion', threw);
}
{
  let threw = false;
  try { await deletePhotos(ADMIN_ID, []); } catch (e) { threw = /At least one photo/.test(String(e.message || e)); }
  ok('empty selection is rejected', threw);
}
{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: deliveredOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-DELIVERED-1/pickup-1.jpg',
  }]);
  ok('a Delivered booking\'s pickup photo can be deleted manually with NO 6-month wait', row.queued === true && row.queue_id != null, row);
  const order = (await db.query(`SELECT pickup_photos, delivery_photos FROM orders WHERE id=$1`, [deliveredOrder])).rows[0];
  ok('only the deleted photo is removed from pickup_photos — the array is not wiped', asArray(order.pickup_photos).length === 0, order.pickup_photos);
  ok('delivery_photos on the same order is untouched by a pickup-field deletion', asArray(order.delivery_photos).length === 1, order.delivery_photos);
  const queueRow = (await db.query(`SELECT * FROM photo_cleanup_queue WHERE provider='supabase' AND storage_path=$1`, ['pickup-proofs/ORDER-DELIVERED-1/pickup-1.jpg'])).rows[0];
  ok('a durable queue row exists for the actual provider deletion step', Boolean(queueRow) && queueRow.completed_at === null, queueRow);
}
{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: featuredOrder, photo_field: 'delivery', provider: 'supabase', storage_path: 'delivery-proofs/ORDER-FEATURED-1/delivery-1.jpg',
  }]);
  ok('featured photo is rejected server-side even if requested directly', row.queued === false && /Featured/.test(row.reason), row);
}
{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: activeOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-ACTIVE-1/pickup-1.jpg',
  }]);
  ok('active shipment photo is rejected server-side', row.queued === false && /still in progress/.test(row.reason), row);
}
{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: deliveredOrder, photo_field: 'receipt', provider: 'supabase', storage_path: 'receipts/ORDER-DELIVERED-1/receipt-1-1.jpg',
  }]);
  ok('a receipt is always rejected, even on an otherwise-eligible order', row.queued === false && /Receipt photos are always kept/.test(row.reason), row);
}
{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: pendingPaymentOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-PENDING-PAY-1/pickup-1.jpg',
  }]);
  ok('deletion is rejected server-side while a payment attempt is pending reconciliation', row.queued === false && /still being reconciled/.test(row.reason), row);
  const order = (await db.query(`SELECT pickup_photos FROM orders WHERE id=$1`, [pendingPaymentOrder])).rows[0];
  ok('the protected photo is NOT removed from the order', asArray(order.pickup_photos).length === 1, order.pickup_photos);
}
{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: reconciledPaymentOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-RECONCILED-PAY-1/pickup-1.jpg',
  }]);
  ok('a photo referenced only by a RECONCILED payment attempt deletes normally', row.queued === true, row);
}
{
  const [row] = await deletePhotos(ADMIN_ID, [{
    order_id: deliveredOrder, photo_field: 'pickup', provider: 'supabase', storage_path: 'pickup-proofs/ORDER-DELIVERED-1/does-not-exist.jpg',
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
// Idempotent re-queue: deleting the same eligible photo twice (e.g. a
// retried request) must not create a second queue row or error out.
{
  const before = (await db.query(`SELECT count(*)::int AS n FROM photo_cleanup_queue WHERE provider='supabase' AND storage_path=$1`, ['pickup-proofs/ORDER-GONE-1/pickup-1.jpg'])).rows[0].n;
  await deletePhotos(ADMIN_ID, [{ order_id: null, photo_field: null, provider: 'supabase', storage_path: 'pickup-proofs/ORDER-GONE-1/pickup-1.jpg' }]);
  const after = (await db.query(`SELECT count(*)::int AS n FROM photo_cleanup_queue WHERE provider='supabase' AND storage_path=$1`, ['pickup-proofs/ORDER-GONE-1/pickup-1.jpg'])).rows[0].n;
  ok('re-queuing the same photo is idempotent (no duplicate queue row) — double-click / retry safe', before === 1 && after === 1, { before, after });
}
// Mixed batch: one eligible, one protected, in the same call.
{
  const order = await makeOrder('ORDER-MIXED-1', {
    status: 'Delivered',
    pickupPhotos: [
      supabaseDescriptor('pickup-proofs/ORDER-MIXED-1/pickup-1.jpg', { size_bytes: 10 }),
      supabaseDescriptor('pickup-proofs/ORDER-MIXED-1/pickup-2.jpg', { size_bytes: 20 }),
    ],
  });
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

// ============================================================================
// 6. check_company_asset_deletable — Company Images
// ============================================================================
console.log('\n-- check_company_asset_deletable --');
{
  let threw = false;
  try { await asAnon((tx) => tx.query(`SELECT * FROM public.check_company_asset_deletable($1::text[])`, [['banner/banner-image.jpg']])); }
  catch (e) { threw = /Admin access required/.test(String(e.message || e)); }
  ok('non-admin caller is rejected', threw);
}
{
  await db.query(
    `UPDATE company_information SET banner_image_url = 'https://xyz.supabase.co/storage/v1/object/public/company-assets/banner/banner-image.jpg?t=1700000000000' WHERE id='00000000-0000-0000-0000-000000000001'`
  );
  const rows = await asAdmin(ADMIN_ID, (tx) => tx.query(
    `SELECT * FROM public.check_company_asset_deletable($1::text[])`,
    [['banner/banner-image.jpg', 'hero/old-hero.jpg']],
  )).then((r) => r.rows);
  const byPath = Object.fromEntries(rows.map((r) => [r.storage_path, r]));
  ok('the current banner image (matched with its cache-busting query stripped) is not deletable', byPath['banner/banner-image.jpg']?.deletable === false
    && /site banner/.test(byPath['banner/banner-image.jpg']?.reason || ''), byPath['banner/banner-image.jpg']);
  ok('an unrelated company-assets file is deletable', byPath['hero/old-hero.jpg']?.deletable === true && byPath['hero/old-hero.jpg']?.reason == null, byPath['hero/old-hero.jpg']);
}
{
  let threw = false;
  try { await asAdmin(ADMIN_ID, (tx) => tx.query(`SELECT * FROM public.check_company_asset_deletable($1::text[])`, [[]])); }
  catch (e) { threw = /At least one file/.test(String(e.message || e)); }
  ok('empty selection is rejected', threw);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
