// F-008 — legacy payment RPC overload cleanup, regression test.
//
// Same approach as scripts/shipping-discount-pgtest and
// scripts/payment-ledger-pgtest: a real embedded Postgres (PGlite) running
// scripts/shipping-discount-pgtest/harness-schema.sql as the base, then the
// REAL migration files applied verbatim on top — what is tested is
// byte-for-byte the SQL that ships.
//
// harness-schema.sql already hand-bakes the 14-arg record_pickup_payment as
// its starting baseline (see that file's own header), and never creates
// record_delivery_payment at all. Neither the 12-arg record_pickup_payment
// (20260803100000) nor the 10-arg record_delivery_payment (20260828120000)
// exist anywhere in this harness, so before this test can prove the new
// 20260912040000 migration removes them, it must first exist to remove.
// STUB_* below recreate ONLY the exact signatures of those two retired
// overloads (trivial bodies — this test is schema hygiene, not a
// reproduction of old business logic, which is not being re-verified here).
//
// IMPORTANT: as in shipping-discount-pgtest, every RPC call below uses named
// parameter syntax so it deterministically hits a specific overload instead
// of silently resolving to whichever signature needs the fewest defaults.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..');
const SHIPPING_DISCOUNT_HARNESS = path.join(REPO, 'scripts/shipping-discount-pgtest/harness-schema.sql');

const db = new PGlite();

let passed = 0, failed = 0;
const failures = [];

function ok(desc, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${desc}`); }
  else { failed++; failures.push(desc); console.log(`  FAIL - ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function asUser(uid, role, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', $2, true)`, [uid || '', role || 'authenticated']);
    return fn(tx);
  });
}

console.log('== Loading shared pre-feature harness schema ==');
await db.exec(readFileSync(SHIPPING_DISCOUNT_HARNESS, 'utf8'));

console.log('== Stubbing the two retired overloads that pre-date this harness ==');
// record_pickup_payment — 12-arg legacy signature (20260803100000). Trivial
// body: this test only needs the SIGNATURE to exist so the drop has a real
// target; the old body's actual behavior was already covered when it shipped
// and is not being re-verified here.
await db.exec(`
  CREATE OR REPLACE FUNCTION public.record_pickup_payment(
    p_order_id UUID, p_actual_weight NUMERIC, p_payment_method TEXT, p_payer_type TEXT,
    p_pickup_photos JSONB, p_promised_payment_date DATE, p_amount NUMERIC, p_reference TEXT,
    p_payment_date DATE, p_receipt_url TEXT, p_payment_type TEXT, p_notes TEXT
  )
  RETURNS orders LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $stub$
  BEGIN
    RAISE EXCEPTION 'STUB legacy 12-arg record_pickup_payment — signature-only, for overload-cleanup testing';
  END;
  $stub$;
  REVOKE ALL ON FUNCTION public.record_pickup_payment(UUID, NUMERIC, TEXT, TEXT, JSONB, DATE, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.record_pickup_payment(UUID, NUMERIC, TEXT, TEXT, JSONB, DATE, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;
`);

// record_delivery_payment — 10-arg legacy signature (20260828120000).
await db.exec(`
  CREATE OR REPLACE FUNCTION public.record_delivery_payment(
    p_order_id UUID, p_delivery_photos JSONB, p_payment_method TEXT, p_amount NUMERIC,
    p_reference TEXT, p_payment_date DATE, p_receipt_url TEXT, p_payment_type TEXT,
    p_notes TEXT, p_promised_payment_date DATE
  )
  RETURNS orders LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $stub$
  BEGIN
    RAISE EXCEPTION 'STUB legacy 10-arg record_delivery_payment — signature-only, for overload-cleanup testing';
  END;
  $stub$;
  REVOKE EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE) TO authenticated;
`);

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID  = '00000000-0000-0000-0000-000000000002';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);

async function newOrder(tracking) {
  const r = await db.query(
    `INSERT INTO orders (tracking_number, status, user_id) VALUES ($1, 'Assigned', $2) RETURNING id`,
    [tracking, CUST_ID]
  );
  return r.rows[0].id;
}

async function countOverloads(name) {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM pg_proc WHERE proname = $1`, [name]);
  return r.rows[0].n;
}

function pickup(tx, params) {
  const p = {
    p_order_id: null, p_actual_weight: null, p_payment_method: 'cash', p_payer_type: 'sender',
    p_pickup_photos: '[]', p_promised_payment_date: null, p_amount: null, p_reference: null,
    p_payment_date: null, p_receipt_url: null, p_payment_type: 'Initial Payment', p_notes: 'test pickup',
    p_idempotency_key: null, p_admin_verified_receipt: false,
    p_discount_amount: 0, p_discount_reason: null, p_discount_notes: null,
    ...params,
  };
  const names = Object.keys(p);
  const args = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  return tx.query(`SELECT * FROM record_pickup_payment(${args})`, names.map(n => p[n]));
}

function deliver(tx, params) {
  const p = {
    p_order_id: null, p_delivery_photos: '["delivery-proof"]', p_payment_method: null,
    p_amount: null, p_reference: null, p_payment_date: null, p_receipt_url: null,
    p_payment_type: 'Balance Settlement', p_notes: 'test delivery',
    p_promised_payment_date: null, p_idempotency_key: null, p_admin_verified_receipt: false,
    ...params,
  };
  const names = Object.keys(p);
  const args = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  return tx.query(`SELECT * FROM record_delivery_payment(${args})`, names.map(n => p[n]));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== Applying real shipping-discount + settlement migrations verbatim (reaches "current", pre-cleanup state) ==');
const preCleanupMigrations = [
  '20260911010000_shipping_discount_schema.sql',
  '20260911020000_shipping_discount_guards.sql',
  '20260911030000_record_pickup_payment_discount.sql',
  '20260911040000_sales_summary_discount_aware.sql',
  '20260911060218_secure_paymongo_order_metadata.sql',
  '20260912010000_discount_aware_manual_settlement.sql',
];
for (const m of preCleanupMigrations) {
  const sql = readFileSync(path.join(REPO, 'supabase/migrations', m), 'utf8');
  try {
    await db.exec(sql);
    console.log(`  applied ${m}`);
  } catch (e) {
    console.error(`  ERROR applying ${m}:`, e.message);
    process.exit(1);
  }
}

console.log('\n== Scenario: BEFORE cleanup, all retired overloads coexist with the current ones ==');
// 3 = my 12-arg stub + harness-schema.sql's own baked-in 14-arg baseline + the
// real 17-arg current signature (applied by 20260911030000 above).
ok('record_pickup_payment has 3 live overloads before cleanup (12-arg stub + 14-arg baked baseline + 17-arg current)', await countOverloads('record_pickup_payment') === 3, await countOverloads('record_pickup_payment'));
ok('record_delivery_payment has 2 live overloads before cleanup (10-arg stub + 12-arg current)', await countOverloads('record_delivery_payment') === 2, await countOverloads('record_delivery_payment'));

console.log('\n== Applying the real F-008 cleanup migration (20260912040000) ==');
try {
  const sql = readFileSync(path.join(REPO, 'supabase/migrations', '20260912040000_drop_legacy_payment_rpc_overloads.sql'), 'utf8');
  await db.exec(sql);
  console.log('  applied 20260912040000_drop_legacy_payment_rpc_overloads.sql');
} catch (e) {
  console.error('  ERROR applying 20260912040000:', e.message);
  process.exit(1);
}

console.log('\n== Scenario: AFTER cleanup, exactly one signature remains per function ==');
ok('record_pickup_payment has exactly 1 overload after cleanup', await countOverloads('record_pickup_payment') === 1, await countOverloads('record_pickup_payment'));
ok('record_delivery_payment has exactly 1 overload after cleanup', await countOverloads('record_delivery_payment') === 1, await countOverloads('record_delivery_payment'));

console.log('\n== Scenario: the current (17-arg pickup / 12-arg delivery) signatures still work normally ==');
{
  const orderId = await newOrder('TRK-CLEANUP-1');
  await asUser(ADMIN_ID, 'authenticated', tx => pickup(tx, {
    p_order_id: orderId, p_actual_weight: 10, p_amount: 700, p_payment_type: 'Initial Payment',
  }));
  const afterPickup = await db.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  ok('current pickup signature still settles a normal order after cleanup', Number(afterPickup.rows[0].amount_paid) === 700 && afterPickup.rows[0].status === 'Picked Up', afterPickup.rows[0]);

  await db.query(`UPDATE orders SET status='Out for Delivery' WHERE id=$1`, [orderId]);
  await asUser(ADMIN_ID, 'authenticated', tx => deliver(tx, { p_order_id: orderId }));
  const afterDelivery = await db.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  ok('current delivery signature still marks the order Delivered after cleanup', afterDelivery.rows[0].status === 'Delivered', afterDelivery.rows[0]);
}

console.log('\n== Scenario: a caller still sending only the OLD parameter names now transparently reaches the CURRENT, safer function ==');
// Named-parameter overload resolution in Postgres picks whichever candidate
// needing the fewest defaulted arguments matches the given names. BEFORE
// cleanup, a call naming only the 12 old parameters would resolve to the
// STUB 12-arg function (0 defaults needed) in preference to the 17-arg
// current one (5 defaults needed) — silently exercising the degraded old
// behavior, exactly the risk this migration closes. AFTER cleanup, that
// exact same call can now ONLY resolve to the 17-arg current signature
// (using its own defaults for p_idempotency_key/p_admin_verified_receipt/
// discount_*), because nothing else with those names exists anymore. This is
// a stronger and more realistic proof than expecting an outright error,
// since supabase.rpc() always calls by parameter name, never positionally.
{
  const orderId = await newOrder('TRK-CLEANUP-2');
  await asUser(ADMIN_ID, 'authenticated', tx => tx.query(
    `SELECT * FROM record_pickup_payment(
       p_order_id => $1, p_actual_weight => $2, p_payment_method => $3, p_payer_type => $4,
       p_pickup_photos => $5, p_promised_payment_date => $6, p_amount => $7, p_reference => $8,
       p_payment_date => $9, p_receipt_url => $10, p_payment_type => $11, p_notes => $12
     )`,
    [orderId, 10, 'cash', 'sender', '[]', null, 700, null, null, null, 'Initial Payment', 'old-named-args call']
  ));
  const afterOldNamedPickup = await db.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  ok(
    'a call naming only the 12 legacy pickup parameters now succeeds via the CURRENT (discount-aware) function instead of the removed stub',
    afterOldNamedPickup.rows[0].status === 'Picked Up' && Number(afterOldNamedPickup.rows[0].discount_amount) === 0,
    afterOldNamedPickup.rows[0]
  );

  await db.query(`UPDATE orders SET status='Out for Delivery' WHERE id=$1`, [orderId]);
  await asUser(ADMIN_ID, 'authenticated', tx => tx.query(
    `SELECT * FROM record_delivery_payment(
       p_order_id => $1, p_delivery_photos => $2, p_payment_method => $3, p_amount => $4,
       p_reference => $5, p_payment_date => $6, p_receipt_url => $7, p_payment_type => $8,
       p_notes => $9, p_promised_payment_date => $10
     )`,
    [orderId, '["proof"]', null, null, null, null, null, 'Balance Settlement', 'old-named-args call', null]
  ));
  const afterOldNamedDelivery = await db.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  ok(
    'a call naming only the 10 legacy delivery parameters now succeeds via the CURRENT (discount-aware) function instead of the removed stub',
    afterOldNamedDelivery.rows[0].status === 'Delivered',
    afterOldNamedDelivery.rows[0]
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:', failures);
  process.exit(1);
}
console.log('All legacy-RPC-overload-cleanup checks passed.');
