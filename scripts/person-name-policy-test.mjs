// ── Human-name policy: browser validator AND database enforcement ──────────
//
// Part 1 is a plain unit test of the shared src/utils/validation.js validator.
// Part 2 is an EXECUTABLE DATABASE TEST: real compiled Postgres (PGlite,
// in-memory, single connection) running the real migration files, proving the
// same policy is enforced on the backend write paths — so a caller that skips
// the browser still cannot store a non-conforming name.
//
// Part 2 also proves the two non-negotiables: no existing name is rewritten,
// and a legacy row that does not meet the new policy can still be updated in
// every other way.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateName } from '../src/utils/validation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let passed = 0, failed = 0;
const failures = [];
const ok = (desc, cond, extra) => {
  if (cond) { passed++; console.log(`  ok   ${desc}`); }
  else { failed++; failures.push(desc); console.log(`  FAIL ${desc}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
};

// The chosen policy, as examples. Not a definition of a valid human name —
// see the header of src/utils/validation.js.
const VALID = [
  ['María Santos',        'accented letters'],
  ['Juan Dela Cruz',      'multiple name parts'],
  ['J. Santos',           'a period for an initial'],
  ['José Peña',           'ñ and an accent together'],
  ['Jose Rizal Jr.',      'a period for a suffix'],
  ['Maria Santos-Reyes',  'a hyphenated surname'],
  ["O'Brien",             'an apostrophe'],
  ['O’Brien',        'a typographic apostrophe (U+2019, iOS autocorrect)'],
  ['Åse Løken',           'Unicode letters outside the old Spanish-only set'],
  ['Zofia Wróbel-Łuk',    'Polish letters the old regex rejected'],
  ['Madonna',             'a mononym'],
  ['  Juan Dela Cruz  ',  'surrounding whitespace is trimmed'],
  ['José Peña', 'a DECOMPOSED (NFD) name, normalised before testing'],
];
const INVALID = [
  ['Juan123',        'digits'],
  ['...',            'periods with no letter'],
  ['   ',            'whitespace only'],
  ['',               'empty'],
  ['\u{1F600}',      'an emoji-only name'],
  ['\u{1F600} Juan', 'an emoji mixed into a name'],
  ['Cruz, Juan',     'a comma (allowed by the OLD regex; not by this policy)'],
  ['Juan`s',         'a backtick (allowed by the OLD regex; not by this policy)'],
  ['a@b',            'an at sign'],
  ['Juan_Cruz',      'an underscore'],
  ['--',             'hyphens with no letter'],
  ['J',              'below the existing 2-character minimum'],
  ['A'.repeat(101),  'above the existing 100-character maximum'],
];

console.log('== Part 1: shared browser validator (src/utils/validation.js) ==');
for (const [value, why] of VALID) ok(`accepts ${JSON.stringify(value)} — ${why}`, validateName(value) === null, validateName(value));
for (const [value, why] of INVALID) ok(`rejects ${JSON.stringify(value)} — ${why}`, validateName(value) !== null);

console.log('\n== Part 2: database enforcement (real migrations, PGlite) ==');
const db = new PGlite();
await db.exec(readFileSync(path.join(REPO, 'scripts/shipping-discount-pgtest/harness-schema.sql'), 'utf8'));
for (const m of [
  '20260911010000_shipping_discount_schema.sql',
  '20260911020000_shipping_discount_guards.sql',
]) await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', m), 'utf8'));

// Columns the current orders table has that the discount-era harness predates.
await db.exec(`
  ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS sender_first_name   TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sender_last_name    TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS receiver_first_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS receiver_last_name  TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sender_phone TEXT, ADD COLUMN IF NOT EXISTS receiver_phone TEXT,
    ADD COLUMN IF NOT EXISTS sender_province TEXT, ADD COLUMN IF NOT EXISTS receiver_province TEXT,
    ADD COLUMN IF NOT EXISTS sender_city TEXT, ADD COLUMN IF NOT EXISTS receiver_city TEXT,
    ADD COLUMN IF NOT EXISTS sender_barangay TEXT, ADD COLUMN IF NOT EXISTS receiver_barangay TEXT,
    ADD COLUMN IF NOT EXISTS sender_street TEXT, ADD COLUMN IF NOT EXISTS receiver_street TEXT,
    ADD COLUMN IF NOT EXISTS sender_landmark TEXT, ADD COLUMN IF NOT EXISTS receiver_landmark TEXT,
    ADD COLUMN IF NOT EXISTS sender_address TEXT, ADD COLUMN IF NOT EXISTS receiver_address TEXT,
    ADD COLUMN IF NOT EXISTS service_area_status TEXT DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS service_area_remarks TEXT;
  CREATE OR REPLACE FUNCTION public.is_standard_service_area_province(p TEXT)
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
  DROP TRIGGER IF EXISTS profiles_guard_write ON profiles;
  -- guard_profile_write() pins email/created_at on a non-admin UPDATE; the
  -- discount-era harness profiles table predates both columns.
  ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
`);

for (const m of [
  '20260922160000_person_name_policy.sql',
  '20260922170000_person_name_policy_order_updates.sql',
]) await db.exec(readFileSync(path.join(REPO, 'supabase/migrations', m), 'utf8'));

await db.exec(`
  CREATE TRIGGER profiles_guard_write
    BEFORE INSERT OR UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_profile_write();
`);

console.log('\n  -- is_valid_person_name() agrees with the browser validator --');
for (const [value, why] of VALID) {
  const r = await db.query(`SELECT public.is_valid_person_name($1) AS v`, [value]);
  ok(`db accepts ${JSON.stringify(value)} — ${why}`, r.rows[0].v === true);
}
for (const [value, why] of INVALID) {
  const r = await db.query(`SELECT public.is_valid_person_name($1) AS v`, [value]);
  ok(`db rejects ${JSON.stringify(value)} — ${why}`, r.rows[0].v === false);
}
{
  const r = await db.query(`SELECT public.is_valid_person_name(NULL) AS v`);
  ok('db rejects NULL', r.rows[0].v === false);
}

const CUST = '00000000-0000-0000-0000-000000000002';
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST]);
await db.query(`SELECT set_config('app.uid', $1, false), set_config('app.role', 'authenticated', false)`, [CUST]);

let seq = 0;
const book = (first, last) => db.query(
  `INSERT INTO orders (tracking_number, user_id, sender_first_name, sender_last_name,
                       receiver_first_name, receiver_last_name)
   VALUES ($1, $2, $3, $4, 'Ana', 'Reyes') RETURNING id`,
  [`TRK-NAME-${++seq}`, CUST, first, last]);
const tryIt = async (fn) => { try { const r = await fn(); return { ok: true, id: r?.rows?.[0]?.id }; } catch (e) { return { ok: false, message: e.message }; } };

console.log('\n  -- new bookings (prepare_order_insert) --');
ok('a new booking with "José" / "Peña" is accepted', (await tryIt(() => book('José', 'Peña'))).ok);
ok('a new booking with "Maria" / "Santos-Reyes" is accepted', (await tryIt(() => book('Maria', 'Santos-Reyes'))).ok);
ok('a new booking with a mononym (blank last name) is accepted', (await tryIt(() => book('Madonna', ''))).ok);
{
  const r = await tryIt(() => book('Juan123', 'Cruz'));
  ok('a new booking with "Juan123" is refused', r.ok === false, r);
  ok('the refusal names the policy', /letters, spaces, periods, hyphens and apostrophes/i.test(r.message || ''), r.message);
}
ok('a new booking with an emoji sender name is refused', (await tryIt(() => book('\u{1F600}', 'Cruz'))).ok === false);
ok('a new booking with "..." as a last name is refused', (await tryIt(() => book('Juan', '...'))).ok === false);

console.log('\n  -- editing an existing booking (guard_order_update) --');
const edit = (id, cols) => db.query(
  `UPDATE orders SET ${Object.keys(cols).map((c, i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1`,
  [id, ...Object.values(cols)]);
const okId = (await tryIt(() => book('Ana', 'Cruz'))).id;
ok('changing a name to "Ángela" is accepted', (await tryIt(() => edit(okId, { sender_first_name: 'Ángela' }))).ok);
ok('changing a name to "Ana1" is refused', (await tryIt(() => edit(okId, { sender_first_name: 'Ana1' }))).ok === false);
ok('changing a name to an emoji is refused', (await tryIt(() => edit(okId, { receiver_last_name: '\u{1F600}' }))).ok === false);
ok('writing only the combined sender_name with digits is refused (raw-update path)',
  (await tryIt(() => edit(okId, { sender_name: 'Ana 123' }))).ok === false);
ok('writing a valid combined sender_name is accepted (raw-update path)',
  (await tryIt(() => edit(okId, { sender_name: 'Ana Peña' }))).ok);

console.log('\n  -- legacy rows are neither rewritten nor frozen --');
const LEGACY = 'Juan #2 Cruz';   // would fail the policy today
const legacy = await db.query(
  `INSERT INTO orders (tracking_number, user_id, sender_first_name, sender_last_name,
                       receiver_first_name, receiver_last_name)
   VALUES ('TRK-LEGACY-1', $1, 'Ana', 'Cruz', 'Ben', 'Dizon') RETURNING id`, [CUST]);
const legacyId = legacy.rows[0].id;
// Simulate a pre-policy value already in the table, bypassing the trigger the
// same way historical data got there: a direct write with the trigger off.
await db.exec(`ALTER TABLE orders DISABLE TRIGGER USER`);
await db.query(`UPDATE orders SET sender_first_name=$2, sender_name=$2 WHERE id=$1`, [legacyId, LEGACY]);
await db.exec(`ALTER TABLE orders ENABLE TRIGGER USER`);

ok('the migration did not rewrite the legacy name',
  (await db.query(`SELECT sender_first_name FROM orders WHERE id=$1`, [legacyId])).rows[0].sender_first_name === LEGACY);
ok('an UNRELATED update to the legacy row still succeeds',
  (await tryIt(() => edit(legacyId, { receiver_phone: '09171234567' }))).ok);
ok('a status change on the legacy row still succeeds',
  (await tryIt(() => db.query(`UPDATE orders SET status='Assigned' WHERE id=$1`, [legacyId]))).ok);
ok('the legacy name is STILL there afterwards, untouched',
  (await db.query(`SELECT sender_first_name FROM orders WHERE id=$1`, [legacyId])).rows[0].sender_first_name === LEGACY);
ok('but CHANGING that legacy name to another invalid value is refused',
  (await tryIt(() => edit(legacyId, { sender_first_name: 'Juan #3' }))).ok === false);
ok('and correcting it to a conforming value is accepted',
  (await tryIt(() => edit(legacyId, { sender_first_name: 'Juan' }))).ok);

console.log('\n  -- profile edits (guard_profile_write) --');
const editProfile = (cols) => db.query(
  `UPDATE profiles SET ${Object.keys(cols).map((c, i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1`,
  [CUST, ...Object.values(cols)]);
ok('renaming a profile to "José Peña" is accepted', (await tryIt(() => editProfile({ name: 'José Peña' }))).ok);
ok('renaming a profile to "Jose 123" is refused', (await tryIt(() => editProfile({ name: 'Jose 123' }))).ok === false);
ok('the refused rename left the previous name intact',
  (await db.query(`SELECT name FROM profiles WHERE id=$1`, [CUST])).rows[0].name === 'José Peña');
{
  // Legacy profile name + an unrelated edit.
  await db.exec(`ALTER TABLE profiles DISABLE TRIGGER USER`);
  await db.query(`UPDATE profiles SET name='Old #Name' WHERE id=$1`, [CUST]);
  await db.exec(`ALTER TABLE profiles ENABLE TRIGGER USER`);
  ok('a profile carrying a legacy name can still be updated in other ways',
    (await tryIt(() => editProfile({ role: 'customer' }))).ok);
  ok('that legacy profile name was not rewritten',
    (await db.query(`SELECT name FROM profiles WHERE id=$1`, [CUST])).rows[0].name === 'Old #Name');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
await db.close();
if (failed) process.exit(1);
