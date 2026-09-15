// Regression tests for the Featured Shipments / Customer Feedback separation
// (20260915140000_separate_featured_shipments_from_feedback.sql), run against
// a real embedded Postgres (PGlite). Same approach as
// scripts/photo-gallery-pgtest and scripts/service-area-mass-assignment-pgtest:
// scripts/payment-ledger-pgtest/harness-schema.sql gives the real
// orders/profiles/is_admin shape (including its real RLS-enforcing role
// switching), a few extra columns/tables this feature touches are added by
// hand, mask_name() and is_featured_photo_path() are copied verbatim from
// supabase/schema.sql (both are unmodified by this migration — copied here
// only so the functions under test can actually compile and run), and then
// the REAL new migration file is applied verbatim on top — so what's tested
// is byte-for-byte the SQL that ships.
//
// What this file does NOT cover: the admin FeatureShipmentModal /
// OrderDetailPage UI, the About page rendering, or Supabase Storage's actual
// object deletion — those need a live/staging Supabase project and a
// browser. See FEATURED_SHIPMENTS_AND_FEEDBACK_SEPARATION.md for the full
// list of what was and wasn't verified.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..');

const db = new PGlite();
let passed = 0;
let failed = 0;

function ok(desc, cond, extra) {
  if (cond) { passed += 1; console.log(`  ok - ${desc}`); }
  else { failed += 1; console.log(`  FAIL - ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function asUser(uid, role, fn) {
  return db.transaction(async (tx) => {
    const pgRole = role || 'authenticated';
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', $2, true)`, [uid || '', pgRole]);
    await tx.query(`SET LOCAL ROLE ${pgRole}`);
    return fn(tx);
  });
}

console.log('== Loading harness schema (real orders/profiles/is_admin shape, real RLS role switching) ==');
await db.exec(readFileSync(path.join(REPO, 'scripts/payment-ledger-pgtest/harness-schema.sql'), 'utf8'));

await db.exec(`
  -- Columns get_public_feedback()/get_featured_deliveries() read that the
  -- payment-ledger harness doesn't need, plus customer_feedback itself.
  ALTER TABLE public.orders ADD COLUMN receiver_city TEXT;
  ALTER TABLE public.orders ADD COLUMN receiver_province TEXT;
  ALTER TABLE public.orders ADD COLUMN featured_on_website BOOLEAN DEFAULT FALSE;
  ALTER TABLE public.orders ADD COLUMN featured_title TEXT;
  ALTER TABLE public.orders ADD COLUMN featured_caption TEXT;
  ALTER TABLE public.orders ADD COLUMN featured_image_type TEXT;
  ALTER TABLE public.orders ADD COLUMN featured_at TIMESTAMPTZ;

  CREATE TABLE public.customer_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES public.profiles(id),
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    message TEXT,
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Real RLS on orders (from supabase/schema.sql) — the actual authorization
  -- boundary for the write path this feature uses (updateOrder()).
  ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Admins can update orders" ON public.orders
    FOR UPDATE TO public USING (is_admin()) WITH CHECK (is_admin());
  CREATE POLICY "Users can view own orders" ON public.orders
    FOR SELECT TO public USING (user_id = auth.uid() OR is_admin());

  GRANT USAGE ON SCHEMA public TO authenticated, anon;
  GRANT SELECT, UPDATE ON public.orders TO authenticated;
`);

console.log('== Copying mask_name() and is_featured_photo_path() verbatim from supabase/schema.sql (unmodified by this migration, needed to compile the functions under test) ==');
const schemaSql = readFileSync(path.join(REPO, 'supabase/schema.sql'), 'utf8');
function extractFunction(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in schema.sql`);
  const end = sql.indexOf('\n$function$', start);
  if (end === -1) throw new Error(`end of function ${name} not found`);
  return sql.slice(start, end + '\n$function$'.length);
}
await db.exec(extractFunction(schemaSql, 'mask_name'));
await db.exec(extractFunction(schemaSql, 'is_featured_photo_path'));

console.log('== Applying 20260915140000 verbatim (the migration under test) ==');
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20260915140000_separate_featured_shipments_from_feedback.sql'), 'utf8'));

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID = '00000000-0000-0000-0000-000000000002';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Juan Dela Cruz', 'customer')`, [CUST_ID]);

// pickup_photos/delivery_photos elements can be a bare path string or a
// structured descriptor object (both are real, supported shapes — see
// normalizePhotoReference() in src/lib/photoReference.js); the RPCs under
// test just take array element 0 as-is, so a bare string keeps assertions
// readable. supabaseDescriptor() is used once below to also exercise
// is_featured_photo_path()'s object-descriptor branch.
const bareStringPhoto = (p) => JSON.stringify([p]);
const supabaseDescriptor = (p) => JSON.stringify([{ type: 'supabase_storage', bucket: 'cargo-photos', path: p }]);

// PGlite's node driver sometimes returns a jsonb column already parsed into
// a JS value and sometimes as a raw string, depending on the query path —
// normalize so assertions don't care which (same helper as photo-gallery-pgtest).
const asArray = (value) => (Array.isArray(value) ? value : JSON.parse(value));

async function makeOrder(tracking, {
  status = 'Delivered', receiverCity = 'Tagbilaran City', receiverProvince = 'Bohol',
  featured = false, featuredTitle = null, featuredCaption = null, featuredImageType = 'pickup', featuredAt = null,
  pickupPhotos = '[]', deliveryPhotos = '[]',
} = {}) {
  const r = await db.query(
    `INSERT INTO orders (tracking_number, status, user_id, receiver_city, receiver_province,
       featured_on_website, featured_title, featured_caption, featured_image_type, featured_at,
       pickup_photos, delivery_photos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [tracking, status, CUST_ID, receiverCity, receiverProvince,
      featured, featuredTitle, featuredCaption, featuredImageType, featuredAt,
      pickupPhotos, deliveryPhotos],
  );
  return r.rows[0].id;
}

async function addFeedback(orderId, { rating = 5, message = 'Great service!', hidden = false } = {}) {
  await db.query(
    `INSERT INTO customer_feedback (order_id, customer_id, rating, message, is_hidden) VALUES ($1,$2,$3,$4,$5)`,
    [orderId, CUST_ID, rating, message, hidden],
  );
}

async function getFeaturedDeliveries() {
  const r = await db.query(`SELECT * FROM public.get_featured_deliveries()`);
  return r.rows;
}
async function getPublicFeedback() {
  const r = await db.query(`SELECT * FROM public.get_public_feedback()`);
  return r.rows;
}

// ============================================================================
// 1. A Delivered booking WITHOUT feedback can be featured
// ============================================================================
console.log('\n-- Delivered booking without feedback --');
{
  const orderId = await makeOrder('ORDER-NOFEEDBACK-1', {
    featured: true, featuredTitle: 'Bound for Jagna', featuredCaption: 'Safe and sound!',
    featuredImageType: 'delivery', featuredAt: new Date().toISOString(),
    deliveryPhotos: bareStringPhoto('delivery-proofs/ORDER-NOFEEDBACK-1/delivery-1.jpg'),
  });
  const rows = await getFeaturedDeliveries();
  const row = rows.find(r => r.id === orderId);
  ok('a Delivered booking with no feedback at all is published in Featured Shipments', Boolean(row), rows);
  ok('the featured card carries the admin title/caption', row?.featured_title === 'Bound for Jagna' && row?.featured_caption === 'Safe and sound!', row);
  ok('the featured card carries the single delivery photo path (not the pickup array)', row?.featured_photo === 'delivery-proofs/ORDER-NOFEEDBACK-1/delivery-1.jpg', row);
  const feedbackRows = await getPublicFeedback();
  ok('no feedback was invented for this booking — get_public_feedback() has no rows yet', feedbackRows.length === 0, feedbackRows);
}

// ============================================================================
// 2. Customer feedback WITHOUT a featured shipment still appears normally
// ============================================================================
console.log('\n-- Feedback without a featured shipment --');
{
  const orderId = await makeOrder('ORDER-FEEDBACK-ONLY-1', {
    featured: false,
    pickupPhotos: bareStringPhoto('pickup-proofs/ORDER-FEEDBACK-ONLY-1/pickup-1.jpg'),
  });
  await addFeedback(orderId, { rating: 5, message: 'Super reliable, thank you!' });
  const feedbackRows = await getPublicFeedback();
  const row = feedbackRows.find(f => f.message === 'Super reliable, thank you!');
  ok('the feedback is public even though the booking was never featured', Boolean(row), feedbackRows);
  ok('the feedback carries the actual rating and message', row?.rating === 5, row);
  ok('the feedback carries the masked customer name', row?.customer_name === 'Juan C.', row);
  ok('the feedback carries approved location details', row?.receiver_city === 'Tagbilaran City' && row?.receiver_province === 'Bohol', row);
  ok('get_public_feedback() no longer returns any photo/feature column at all', !('featured_photo' in row) && !('featured_on_website' in row) && !('featured_image_type' in row), row);
  const featured = await getFeaturedDeliveries();
  ok('the same booking is absent from Featured Shipments', !featured.some(r => r.id === orderId));
}

// ============================================================================
// 3. A booking with BOTH: each section shows its own thing, no duplication
// ============================================================================
console.log('\n-- Booking with both a featured shipment and feedback --');
{
  const orderId = await makeOrder('ORDER-BOTH-1', {
    featured: true, featuredTitle: 'A smooth trip to Panglao', featuredImageType: 'pickup',
    featuredAt: new Date().toISOString(),
    pickupPhotos: bareStringPhoto('pickup-proofs/ORDER-BOTH-1/pickup-1.jpg'),
  });
  await addFeedback(orderId, { rating: 4, message: 'Arrived a bit late but package was intact.' });

  const featured = await getFeaturedDeliveries();
  const featuredRow = featured.find(r => r.id === orderId);
  ok('the shipment card is published with its own title/photo', featuredRow?.featured_title === 'A smooth trip to Panglao' && featuredRow?.featured_photo === 'pickup-proofs/ORDER-BOTH-1/pickup-1.jpg', featuredRow);

  const feedbackRows = await getPublicFeedback();
  const feedbackRow = feedbackRows.find(f => f.message === 'Arrived a bit late but package was intact.');
  ok('the feedback card shows the real rating and comment', feedbackRow?.rating === 4, feedbackRow);
  ok('the feedback card carries no photo field to duplicate the shipment photo into', !('featured_photo' in feedbackRow), feedbackRow);
}

// ============================================================================
// 4. Ambiguous legacy data: featured_on_website=true with no title
// ============================================================================
console.log('\n-- Ambiguous legacy row (featured flag set, no title) --');
{
  // Simulates a booking toggled under the intermediate "Manage Feedback
  // Photo" UI, which stopped collecting a title. We cannot infer whether an
  // admin actually intended a public shipment showcase entry from the flag
  // alone, so it must stay out of the public gallery until reviewed.
  const orderId = await makeOrder('ORDER-LEGACY-AMBIGUOUS-1', {
    featured: true, featuredTitle: null, featuredImageType: 'pickup',
    pickupPhotos: bareStringPhoto('pickup-proofs/ORDER-LEGACY-AMBIGUOUS-1/pickup-1.jpg'),
  });
  let featured = await getFeaturedDeliveries();
  ok('a featured row with no title is NOT published (ambiguous legacy state)', !featured.some(r => r.id === orderId), featured);

  // Explicit admin review completes it — exactly what the restored modal's
  // required-title validation forces on the next save.
  await db.query(`UPDATE orders SET featured_title = 'Reviewed and confirmed' WHERE id = $1`, [orderId]);
  featured = await getFeaturedDeliveries();
  ok('after an admin explicitly sets a title, the row publishes normally', featured.some(r => r.id === orderId && r.featured_title === 'Reviewed and confirmed'), featured);

  // Also confirm an empty-string title (not just NULL) is treated the same.
  const orderId2 = await makeOrder('ORDER-LEGACY-AMBIGUOUS-2', {
    featured: true, featuredTitle: '   ', featuredImageType: 'pickup',
    pickupPhotos: bareStringPhoto('pickup-proofs/ORDER-LEGACY-AMBIGUOUS-2/pickup-1.jpg'),
  });
  featured = await getFeaturedDeliveries();
  ok('a featured row with a blank/whitespace-only title is also excluded', !featured.some(r => r.id === orderId2), featured);
}

// ============================================================================
// 5. Repeated Save does not create duplicates (idempotent UPDATE)
// ============================================================================
console.log('\n-- Repeated publish is idempotent --');
{
  const orderId = await makeOrder('ORDER-REPUBLISH-1', {
    featured: true, featuredTitle: 'First publish', featuredImageType: 'pickup',
    featuredAt: new Date().toISOString(),
    pickupPhotos: bareStringPhoto('pickup-proofs/ORDER-REPUBLISH-1/pickup-1.jpg'),
  });
  for (let i = 0; i < 3; i++) {
    await db.query(`UPDATE orders SET featured_title = $2 WHERE id = $1`, [orderId, `Publish attempt ${i + 1}`]);
  }
  const featured = await getFeaturedDeliveries();
  const matches = featured.filter(r => r.id === orderId);
  ok('exactly one featured entry exists for the booking after repeated saves', matches.length === 1, matches);
  ok('the entry reflects the latest save (an UPDATE, never an INSERT)', matches[0]?.featured_title === 'Publish attempt 3', matches[0]);
}

// ============================================================================
// 6. Unpublishing preserves the original photo and booking
// ============================================================================
console.log('\n-- Unpublish preserves the underlying photo/booking --');
{
  const orderId = await makeOrder('ORDER-UNPUBLISH-1', {
    featured: true, featuredTitle: 'Temporary feature', featuredImageType: 'delivery',
    featuredAt: new Date().toISOString(),
    deliveryPhotos: bareStringPhoto('delivery-proofs/ORDER-UNPUBLISH-1/delivery-1.jpg'),
  });
  let featured = await getFeaturedDeliveries();
  ok('the booking starts out published', featured.some(r => r.id === orderId));

  await db.query(`UPDATE orders SET featured_on_website = false, featured_at = NULL WHERE id = $1`, [orderId]);
  featured = await getFeaturedDeliveries();
  ok('the booking is removed from the public gallery after unfeaturing', !featured.some(r => r.id === orderId), featured);

  const order = (await db.query(`SELECT status, delivery_photos FROM orders WHERE id = $1`, [orderId])).rows[0];
  ok('the order itself still exists as Delivered', order.status === 'Delivered');
  ok('the original delivery photo array is untouched', asArray(order.delivery_photos).length === 1, order.delivery_photos);
}

// ============================================================================
// 7. Storage protection still recognizes the currently-featured photo
// ============================================================================
console.log('\n-- Storage cleanup protection (is_featured_photo_path) --');
{
  const orderId = await makeOrder('ORDER-STORAGE-PROTECT-1', {
    featured: true, featuredTitle: 'Protected photo', featuredImageType: 'pickup',
    pickupPhotos: supabaseDescriptor('pickup-proofs/ORDER-STORAGE-PROTECT-1/pickup-1.jpg'),
  });
  let protectedRow = await db.query(`SELECT public.is_featured_photo_path($1) AS protected`, ['pickup-proofs/ORDER-STORAGE-PROTECT-1/pickup-1.jpg']);
  ok('the currently-featured photo path is recognized as protected', protectedRow.rows[0].protected === true, protectedRow.rows[0]);

  const unrelated = await db.query(`SELECT public.is_featured_photo_path($1) AS protected`, ['pickup-proofs/ORDER-STORAGE-PROTECT-1/does-not-exist.jpg']);
  ok('an unrelated path on the same order is not protected', unrelated.rows[0].protected === false, unrelated.rows[0]);

  await db.query(`UPDATE orders SET featured_on_website = false WHERE id = $1`, [orderId]);
  protectedRow = await db.query(`SELECT public.is_featured_photo_path($1) AS protected`, ['pickup-proofs/ORDER-STORAGE-PROTECT-1/pickup-1.jpg']);
  ok('after unfeaturing, the same path is no longer protected by this function', protectedRow.rows[0].protected === false, protectedRow.rows[0]);
}

// ============================================================================
// 8. Unauthorized publishing is rejected server-side
// ============================================================================
console.log('\n-- Authorization (RLS on the write path) --');
{
  const orderId = await makeOrder('ORDER-AUTH-1', {
    pickupPhotos: bareStringPhoto('pickup-proofs/ORDER-AUTH-1/pickup-1.jpg'),
  });

  let threw = false;
  try {
    await asUser(null, 'anon', (tx) => tx.query(
      `UPDATE orders SET featured_on_website = true, featured_title = 'Hijacked' WHERE id = $1`, [orderId],
    ));
  } catch (e) { threw = true; }
  // RLS silently filters rows rather than raising for a bare UPDATE with no
  // matching rows visible to the role — assert on effect, not just an error.
  let row = (await db.query(`SELECT featured_on_website FROM orders WHERE id = $1`, [orderId])).rows[0];
  ok('an anonymous caller cannot feature a booking', row.featured_on_website === false, { threw, row });

  await asUser(CUST_ID, 'authenticated', (tx) => tx.query(
    `UPDATE orders SET featured_on_website = true, featured_title = 'Self-service feature' WHERE id = $1`, [orderId],
  ).catch(() => {}));
  row = (await db.query(`SELECT featured_on_website FROM orders WHERE id = $1`, [orderId])).rows[0];
  ok('the booking\'s own customer cannot feature it either', row.featured_on_website === false, row);

  await asUser(ADMIN_ID, 'authenticated', (tx) => tx.query(
    `UPDATE orders SET featured_on_website = true, featured_title = 'Admin featured this' WHERE id = $1`, [orderId],
  ));
  row = (await db.query(`SELECT featured_on_website, featured_title FROM orders WHERE id = $1`, [orderId])).rows[0];
  ok('an admin can feature it', row.featured_on_website === true && row.featured_title === 'Admin featured this', row);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
