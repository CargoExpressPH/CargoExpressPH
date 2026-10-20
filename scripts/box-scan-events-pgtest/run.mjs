// Box scan audit — database-layer test for 20261020150000_box_scan_events_audit.sql.
// Applies the real record_box_verification migration, then the audit migration.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new PGlite();
let passed = 0;
let failed = 0;
const ok = (desc, cond, extra) => {
  if (cond) { passed += 1; console.log(`  ok - ${desc}`); return; }
  failed += 1;
  console.log(`  FAIL - ${desc}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);
};
const attempt = async (sql, params = []) => {
  try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { error: e.message }; }
};
const events = async () => (await db.query(`SELECT * FROM box_scan_events ORDER BY scanned_at, box_number`)).rows;

await db.exec(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.uid', true), '')::uuid $$;
  CREATE TABLE public.profiles (id UUID PRIMARY KEY, role TEXT);
  CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public' AS $$
    SELECT COALESCE((SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()), FALSE) $$;
  CREATE TABLE public.trips (id UUID PRIMARY KEY, trip_number TEXT, status TEXT);
  CREATE TABLE public.orders (
    id UUID PRIMARY KEY, tracking_number TEXT, trip_id UUID REFERENCES public.trips(id),
    status TEXT, package_quantity INT NOT NULL DEFAULT 1,
    verified_boxes INTEGER[] NOT NULL DEFAULT '{}'
  );
`);
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20261008030000_require_box_verification_before_trip_start.sql'), 'utf8'));
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20261020150000_box_scan_events_audit.sql'), 'utf8'));

const admin = randomUUID();
const customer = randomUUID();
const tripId = randomUUID();
const orderId = randomUUID();
await db.exec(`
  INSERT INTO profiles VALUES ('${admin}','admin'), ('${customer}','customer');
  INSERT INTO trips VALUES ('${tripId}','T-1','scheduled');
  INSERT INTO orders VALUES ('${orderId}','CE-A','${tripId}','Picked Up',4,'{}');
`);
const verify = (box, ...rest) => attempt(`SELECT public.record_box_verification($1,$2${rest.length ? ',$3,$4' : ''}) AS v`, [orderId, box, ...rest]);

console.log('== Camera scans keep working with two arguments ==');
await db.query(`SELECT set_config('app.uid', $1, false)`, [admin]);
let r = await verify(1);
ok('a plain 2-argument call is not ambiguous and verifies the box', !r.error && r.rows[0].v.join() === '1', r);
let rows = await events();
ok('it is logged as a qr event in the load phase with no reason',
  rows.length === 1 && rows[0].method === 'qr' && rows[0].reason === null && rows[0].phase === 'load' && rows[0].actor_id === admin, rows);

console.log('== Manual fallback ==');
r = await verify(2, 'manual_fallback', 'torn_label');
ok('manual fallback with a reason is accepted', !r.error, r);
r = await verify(3, 'manual_fallback', null);
ok('manual fallback without a reason is rejected', Boolean(r.error), r);
ok('a rejected call leaves the box unverified',
  !(await db.query(`SELECT verified_boxes FROM orders`)).rows[0].verified_boxes.includes(3));
r = await verify(3, 'manual_fallback', 'because');
ok('an unknown reason is rejected by the table check', Boolean(r.error), r);
r = await verify(3, 'telepathy', 'other');
ok('an unknown method is rejected', Boolean(r.error), r);
rows = await events();
ok('manual event stores method and reason', rows.some((e) => e.box_number === 2 && e.method === 'manual_fallback' && e.reason === 'torn_label'), rows);

console.log('== Idempotency and phase ==');
await verify(2, 'manual_fallback', 'torn_label');
await verify(1);
ok('replaying an already-counted box adds no event', (await events()).length === 2);
await db.exec(`UPDATE orders SET status = 'Out for Delivery', verified_boxes = '{}'`);
await verify(1);
ok('a doorstep scan is logged in the deliver phase', (await events()).some((e) => e.phase === 'deliver' && e.box_number === 1));

console.log('== Access ==');
await db.query(`SELECT set_config('app.uid', $1, false)`, [customer]);
r = await verify(4);
ok('a non-admin cannot verify boxes', Boolean(r.error), r);
const grants = (await db.query(`
  SELECT privilege_type FROM information_schema.role_table_grants
   WHERE table_name = 'box_scan_events' AND grantee = 'authenticated'`)).rows.map((g) => g.privilege_type);
ok('authenticated has SELECT only on the audit table', grants.length === 1 && grants[0] === 'SELECT', grants);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
