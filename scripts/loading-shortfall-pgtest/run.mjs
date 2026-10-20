// Loading shortfall exceptions — database-layer regression test for
// 20261020130000_loading_shortfall_and_field_fallbacks.sql. Applies the real
// trip-start guard migration, then the shortfall migration on top, against
// embedded Postgres.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new PGlite({ extensions: { pgcrypto } });
let passed = 0;
let failed = 0;

const ok = (desc, cond, extra) => {
  if (cond) { passed += 1; console.log(`  ok - ${desc}`); return; }
  failed += 1;
  console.log(`  FAIL - ${desc}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);
};
const asUser = (uid) => db.query(`SELECT set_config('app.uid', $1, false)`, [uid || '']);
const attempt = async (sql, params = []) => {
  try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { error: e.message }; }
};
const count = async (table) => (await db.query(`SELECT 1 FROM ${table}`)).rows.length;

await db.exec(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE SCHEMA IF NOT EXISTS extensions;
  CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
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
await db.exec(readFileSync(path.join(REPO, 'supabase/migrations/20261020130000_loading_shortfall_and_field_fallbacks.sql'), 'utf8'));

const driver = randomUUID();
const supervisor = randomUUID();
const customer = randomUUID();
const tripId = randomUUID();
const otherTrip = randomUUID();
const orderA = randomUUID();
const orderB = randomUUID();
await db.exec(`
  INSERT INTO profiles VALUES ('${driver}','admin'), ('${supervisor}','admin'), ('${customer}','customer');
  INSERT INTO trips VALUES ('${tripId}','T-1','scheduled'), ('${otherTrip}','T-2','scheduled');
  INSERT INTO orders VALUES
    ('${orderA}','CE-A','${tripId}','Picked Up',3,'{1,2}'),
    ('${orderB}','CE-B','${tripId}','Picked Up',1,'{1}');
`);
const startTrip = () => attempt(`UPDATE trips SET status='in_progress' WHERE id=$1`, [tripId]);
const report = (box, code, reason = 'missing_from_staging', trip = tripId, order = orderA) =>
  attempt(`SELECT public.report_and_approve_shortfall($1,$2,$3,$4,$5) AS r`, [trip, order, box, reason, code]);

console.log('== Trip start without a shortfall ==');
let r = await startTrip();
ok('missing box 3 blocks trip start (existing behaviour kept)', Boolean(r.error) && r.error.includes('Cannot start trip'), r);

console.log('== Supervisor codes ==');
await asUser(customer);
r = await attempt(`SELECT public.set_supervisor_pin('abcdef123')`);
ok('non-admin cannot set a supervisor code', Boolean(r.error), r);
await asUser(supervisor);
r = await attempt(`SELECT public.set_supervisor_pin('123')`);
ok('short codes are rejected', Boolean(r.error), r);
r = await attempt(`SELECT public.set_supervisor_pin('SUP-9912')`);
ok('admin can set a supervisor code', !r.error, r);
const hash = (await db.query(`SELECT pin_hash FROM supervisor_pins`)).rows[0]?.pin_hash || '';
ok('code is stored as a bcrypt hash, not plaintext', hash.startsWith('$2') && !hash.includes('9912'), hash);

console.log('== report_and_approve_shortfall ==');
await asUser(customer);
r = await report(3, 'SUP-9912');
ok('non-admin cannot report a shortfall', Boolean(r.error), r);

await asUser(driver);
r = await report(3, 'WRONG-CODE');
ok('wrong code returns ok:false', r.rows?.[0]?.r?.ok === false && r.rows[0].r.error === 'invalid_supervisor_code', r);
ok('no exception row after a wrong code', (await count('loading_shortfall_exceptions')) === 0);
ok('the wrong attempt is persisted for rate limiting', (await count('supervisor_code_attempts')) === 1);

r = await report(9, 'SUP-9912');
ok('box outside the booking is rejected', Boolean(r.error), r);
r = await report(1, 'SUP-9912');
ok('an already-scanned box is not a shortfall', Boolean(r.error), r);
r = await report(3, 'SUP-9912', 'because');
ok('unknown reason is rejected', Boolean(r.error), r);
r = await report(3, 'SUP-9912', 'other', otherTrip);
ok('order from another trip is rejected', Boolean(r.error), r);

r = await report(3, 'SUP-9912', 'damaged_at_hub');
ok('correct code approves the shortfall', r.rows?.[0]?.r?.ok === true, r);
const row = (await db.query(`SELECT * FROM loading_shortfall_exceptions`)).rows[0];
ok('exception is stored approved with the supervisor and reporter',
  row?.status === 'approved' && row.supervisor_id === supervisor && row.reported_by === driver, row);
ok('stored approval code is a reference, not the secret',
  row?.supervisor_approval_code?.startsWith('SUP-') && row.supervisor_approval_code !== 'SUP-9912', row);
ok('good code clears the failed-attempt counter', (await count('supervisor_code_attempts')) === 0);

r = await report(3, 'SUP-9912');
ok('reporting the same box twice is idempotent',
  r.rows?.[0]?.r?.ok === true && (await count('loading_shortfall_exceptions')) === 1, r);

console.log('== Self-approval and lockout ==');
await db.exec(`UPDATE orders SET package_quantity = 4 WHERE id = '${orderA}'`);
await asUser(supervisor);
r = await report(4, 'SUP-9912');
ok('a reporter cannot approve with their own code', r.rows?.[0]?.r?.ok === false, r);
await db.exec(`DELETE FROM supervisor_code_attempts`);
await asUser(driver);
for (let i = 0; i < 5; i += 1) await report(4, 'nope-nope');
r = await report(4, 'SUP-9912');
ok('five wrong codes lock the reporter out, even for the right code',
  Boolean(r.error) && r.error.includes('Too many'), r);

console.log('== Trip start guard ==');
r = await startTrip();
ok('a different unscanned box (4) still blocks the trip', Boolean(r.error), r);

await db.exec(`DELETE FROM supervisor_code_attempts`);
await db.exec(`UPDATE orders SET package_quantity = 3 WHERE id = '${orderA}'`);
await db.exec(`UPDATE loading_shortfall_exceptions SET status = 'rejected'`);
r = await startTrip();
ok('a rejected exception does not release the trip', Boolean(r.error), r);

await db.exec(`UPDATE loading_shortfall_exceptions SET status = 'approved'`);
r = await startTrip();
ok('trip starts once the only missing box has an approved exception', !r.error, r);

console.log('== After the trip has started ==');
r = await report(3, 'SUP-9912');
ok('shortfalls cannot be reported once the trip is in progress', Boolean(r.error), r);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
