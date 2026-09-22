// ── Public tracking privacy contract ────────────────────────────────────────
// Executes the REAL migration chain for track_order_public() against an
// in-memory Postgres (PGlite) with synthetic rows only. Nothing here contacts
// Supabase, and nothing asserts anything about the deployed project.
//
// What this proves: the field is absent from the BACKEND RESPONSE. The
// assertions read the RPC's result set as the `anon` role — they are not
// looking at rendered markup, so a field that were merely hidden with CSS
// would fail here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = (name) => readFileSync(path.join(repo, 'supabase/migrations', name), 'utf8');

let passed = 0, failed = 0;
const ok = (label, cond) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
};

const db = new PGlite();

await db.exec(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$;
  CREATE TABLE public.trips (
    id uuid PRIMARY KEY,
    arrival_date timestamptz,
    departure_date timestamptz,
    departure_at timestamptz,
    estimated_arrival_at timestamptz,
    arrived_at timestamptz
  );
  CREATE TABLE public.orders (
    id uuid PRIMARY KEY,
    tracking_number varchar NOT NULL,
    status varchar,
    sender_name text,
    receiver_name text,
    origin varchar,
    destination varchar,
    package_description text,
    actual_weight numeric,
    shipping_cost numeric,
    discount_amount numeric,
    remaining_balance numeric,
    amount_paid numeric,
    payment_status text,
    payer_type text,
    sender_phone text,
    receiver_phone text,
    sender_address text,
    receiver_address text,
    user_id uuid,
    trip_id uuid REFERENCES public.trips(id),
    created_at timestamptz,
    updated_at timestamptz
  );
`);

const maskSql = migration('20260723120000_harden_public_tracking.sql')
  .match(/CREATE OR REPLACE FUNCTION public\.mask_name\([\s\S]*?\n\$\$;/)?.[0];
assert.ok(maskSql, 'extract mask_name helper');
await db.exec(maskSql);

// The fix under test, applied exactly as `supabase db push` would apply it.
await db.exec(migration('20260922140000_restore_public_tracking_privacy.sql'));

// ── Synthetic fixture: a LONG description and an EXACT fee ────────────────
const LONG_DESCRIPTION =
  'Two sealed boxes of prescription medicine for Lola Remedios, plus 1 laptop';
const EXACT_FEE = 9876.54;

await db.exec(`
  INSERT INTO public.trips (id, arrival_date, departure_date, departure_at, estimated_arrival_at, arrived_at)
  VALUES ('10000000-0000-0000-0000-000000000001',
          '2026-09-30T00:00:00Z', '2026-09-25T00:00:00Z',
          '2026-09-25T02:10:00Z', '2026-09-26T09:00:00Z', '2026-09-26T08:41:00Z');
  INSERT INTO public.orders (
    id, tracking_number, status, sender_name, receiver_name, origin, destination,
    package_description, actual_weight, shipping_cost, discount_amount,
    remaining_balance, amount_paid, payment_status, payer_type,
    sender_phone, receiver_phone, sender_address, receiver_address,
    user_id, trip_id, created_at, updated_at
  ) VALUES (
    '20000000-0000-0000-0000-000000000001', 'CE-20260922-1234', 'In Transit',
    'Synthetic Sender', 'Synthetic Receiver', 'Bohol', 'Manila',
    '${LONG_DESCRIPTION}',
    37.25, ${EXACT_FEE}, 500,
    9376.54, 500, 'partial', 'sender',
    '09171234567', '09187654321', '12 Synthetic St, Tagbilaran', '34 Synthetic Ave, Manila',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '2026-09-22T01:00:00Z', '2026-09-22T02:00:00Z'
  );
`);

console.log('\nAnonymous response — sensitive fields must be ABSENT from the backend result');
await db.query('SET ROLE anon');
const res = await db.query(`SELECT * FROM public.track_order_public('CE-20260922-1234')`);
ok('anonymous caller can still look up a tracking number', res.rows.length === 1);
const row = res.rows[0];
const columns = res.fields.map(f => f.name);

// The exact fee, and every other financial/private column, must not exist in
// the result at all — not be null, not be rounded: absent.
for (const forbidden of [
  'shipping_cost', 'discount_amount', 'remaining_balance', 'amount_paid',
  'payment_status', 'payer_type', 'sender_phone', 'receiver_phone',
  'sender_address', 'receiver_address', 'user_id', 'trip_id',
]) {
  ok(`${forbidden} is absent from the anonymous response`, !columns.includes(forbidden));
}
ok('no returned value equals the exact shipping fee',
  !Object.values(row).some(v => Number(v) === EXACT_FEE));

console.log('\nRestricted package-description projection');
ok('description is truncated, not returned whole',
  row.package_description !== LONG_DESCRIPTION);
ok('description is the first 40 characters plus an ellipsis',
  row.package_description === LONG_DESCRIPTION.slice(0, 40) + '…');
ok('truncated description is at most 41 characters',
  row.package_description.length <= 41);
// DOCUMENTED LIMITATION, asserted so it cannot be mistaken for a guarantee:
// a description of 40 characters or fewer survives truncation intact. This
// projection reduces disclosure; it does not anonymise.
await db.query('RESET ROLE');
await db.exec(`
  INSERT INTO public.orders (id, tracking_number, status, sender_name, receiver_name,
    origin, destination, package_description, created_at, updated_at)
  VALUES ('20000000-0000-0000-0000-000000000002', 'CE-20260922-5678', 'Pending',
    'Short Sender', 'Short Receiver', 'Manila', 'Bohol', 'Cash envelope',
    '2026-09-22T01:00:00Z', '2026-09-22T01:00:00Z');
`);
await db.query('SET ROLE anon');
const shortRes = await db.query(`SELECT * FROM public.track_order_public('CE-20260922-5678')`);
ok('LIMITATION: a description under 40 characters is returned in full — truncation is disclosure reduction, not privacy',
  shortRes.rows[0].package_description === 'Cash envelope');

console.log('\nFields the tracking page genuinely needs are preserved');
ok('status is returned', row.status === 'In Transit');
ok('route origin is returned', row.origin === 'Bohol');
ok('route destination is returned', row.destination === 'Manila');
ok('sender name is masked, not raw', row.sender_name !== 'Synthetic Sender' && Boolean(row.sender_name));
ok('receiver name is masked, not raw', row.receiver_name !== 'Synthetic Receiver' && Boolean(row.receiver_name));
ok('scheduled trip departure is preserved', row.trip_departure_date !== null);
ok('actual trip departure is preserved', row.trip_departure_at !== null);
ok('estimated arrival is preserved', row.trip_estimated_arrival_at !== null);
ok('actual arrival is preserved', row.trip_arrived_at !== null);
ok('estimated delivery is preserved', row.estimated_delivery !== null);
ok('actual weight is preserved (already public before this change)', Number(row.actual_weight) === 37.25);

console.log('\nAnonymous access is via the allowlist RPC only');
let deniedOrders = false;
try { await db.query('SELECT shipping_cost FROM public.orders LIMIT 1'); }
catch { deniedOrders = true; }
ok('anon has no direct SELECT on public.orders', deniedOrders);

await db.query('RESET ROLE');
const grants = await db.query(`
  SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'track_order_public'`);
ok('anon keeps EXECUTE on the tracking RPC', grants.rows[0].anon_exec === true);

const sig = await db.query(`
  SELECT COUNT(*)::int AS n FROM information_schema.parameters
   WHERE specific_schema = 'public' AND parameter_name = 'shipping_cost'
     AND specific_name LIKE 'track_order_public%'`);
ok('shipping_cost is gone from the function signature itself', sig.rows[0].n === 0);

console.log(`\n${passed} passed, ${failed} failed`);
await db.close();
if (failed > 0) process.exit(1);
