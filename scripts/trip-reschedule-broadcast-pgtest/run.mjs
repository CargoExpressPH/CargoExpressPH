// Regression coverage for POST_DEPLOYMENT_TARGETED_FIX_REPORT.md item 2/N-2:
// the public "email this schedule update to all subscribers" option on trip
// reschedule. Applies the real original trigger migration (20260910020000)
// plus the real forward-fix migration (20260917100000) against an embedded
// Postgres, with the same net/vault mocking pattern already used by
// payment-refund-recovery-pgtest — pg_net/Vault are live-project extensions
// PGlite cannot install, so the network/secret calls are recorded instead of
// actually sent, and the original migration's `CREATE EXTENSION pg_net` line
// is stripped before exec (nothing else about that file is modified).
//
// Covers: reschedule without the public option (private courtesy email path
// only), reschedule with it (private path suppressed, public broadcast
// created, CTA snapshot propagated), an unchanged-schedule no-op (neither
// path fires), and a second genuine reschedule getting its own distinct
// broadcast.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const db = new PGlite();

const value = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  CREATE TABLE profiles(id uuid PRIMARY KEY, role text NOT NULL);
  CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT true
  $$;

  CREATE TABLE trips(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'scheduled',
    departure_date timestamptz,
    arrival_date timestamptz
  );

  CREATE TABLE announcements(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, content text NOT NULL,
    send_email boolean NOT NULL DEFAULT false, emailed_at timestamptz,
    cta_label text, cta_url text
  );
  CREATE TABLE email_subscriptions(email text PRIMARY KEY, subscribed boolean NOT NULL);

  -- Local stand-ins for extensions that only exist in the live project.
  -- net.http_post calls are recorded (not sent) so the tests can assert
  -- exactly when the private courtesy-email path did/did not fire.
  CREATE SCHEMA vault;
  CREATE TABLE vault.decrypted_secrets (name TEXT, decrypted_secret TEXT);
  INSERT INTO vault.decrypted_secrets VALUES
    ('project_url', 'https://example.supabase.co'),
    ('service_role_key', 'test-service-role-key');

  CREATE SCHEMA net;
  CREATE TABLE net.calls (id BIGSERIAL PRIMARY KEY, url TEXT, body JSONB, called_at timestamptz DEFAULT now());
  CREATE OR REPLACE FUNCTION net.http_post(url TEXT, headers JSONB DEFAULT '{}'::JSONB, body JSONB DEFAULT '{}'::JSONB, timeout_milliseconds INTEGER DEFAULT 5000)
  RETURNS BIGINT LANGUAGE plpgsql AS $$
  DECLARE v_id BIGINT;
  BEGIN
    INSERT INTO net.calls (url, body) VALUES (url, body) RETURNING id INTO v_id;
    RETURN v_id;
  END $$;
`);

// The real trigger migration, minus the one line PGlite cannot run
// (`CREATE EXTENSION ... pg_net`) — everything else is executed verbatim.
const triggerMigration = readFileSync(
  path.join(REPO, 'supabase/migrations/20260910020000_trip_reschedule_email_trigger.sql'),
  'utf8',
).replace(/CREATE EXTENSION IF NOT EXISTS pg_net.*?;\n/, '');
await db.exec(triggerMigration);

// The real durable-announcement-broadcast migration (F-03) — creates
// announcement_email_broadcasts/recipients and the 5 RPCs my forward
// migration below extends/reuses.
await db.exec(readFileSync(
  path.join(REPO, 'supabase/migrations/20260916161000_durable_announcement_broadcasts.sql'),
  'utf8',
));

await db.exec(readFileSync(
  path.join(REPO, 'supabase/migrations/20260917100000_public_trip_reschedule_broadcast.sql'),
  'utf8',
));

let passed = 0;
let failed = 0;
const ok = (description, condition, extra = null) => {
  if (condition) { passed += 1; console.log(`  ok - ${description}`); return; }
  failed += 1;
  console.log(`  FAIL - ${description}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);
};

const TRIP = '30000000-0000-4000-8000-000000000001';
await db.query(
  `INSERT INTO trips (id, status, departure_date, arrival_date) VALUES ($1, 'scheduled', '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z')`,
  [TRIP],
);

// ── 1. Reschedule WITHOUT the public option: only the private courtesy path fires ──
const r1 = await value(
  `SELECT reschedule_trip($1, '2026-10-05T00:00:00Z', '2026-10-07T00:00:00Z', false, NULL) AS result`,
  [TRIP],
);
ok('genuine reschedule reports schedule_changed = true', r1.result.schedule_changed === true, r1.result);
const callsAfterPrivate = await rows(`SELECT * FROM net.calls ORDER BY id`);
ok('unchecked option: exactly one private courtesy-email call fired', callsAfterPrivate.length === 1, callsAfterPrivate);
ok('the private call targets email-trip-reschedule', callsAfterPrivate[0]?.url?.includes('email-trip-reschedule'), callsAfterPrivate[0]);

// ── 2. Re-submitting the SAME dates (double-click) is a no-op, no new call ──
const r1b = await value(
  `SELECT reschedule_trip($1, '2026-10-05T00:00:00Z', '2026-10-07T00:00:00Z', false, NULL) AS result`,
  [TRIP],
);
ok('re-submitting identical dates reports schedule_changed = false', r1b.result.schedule_changed === false, r1b.result);
const callsAfterNoop = await rows(`SELECT * FROM net.calls`);
ok('unchanged schedule does not fire another private call', callsAfterNoop.length === 1, callsAfterNoop);

// ── 3. Reschedule WITH the public option: private path suppressed ──
const r2 = await value(
  `SELECT reschedule_trip($1, '2026-10-10T00:00:00Z', '2026-10-12T00:00:00Z', true, 'Weather advisory') AS result`,
  [TRIP],
);
ok('public-option reschedule reports schedule_changed = true', r2.result.schedule_changed === true, r2.result);
ok('public reason is carried through', r2.result.public_reason === 'Weather advisory', r2.result);
const callsAfterPublic = await rows(`SELECT * FROM net.calls`);
ok('public option: no additional private courtesy-email call fired', callsAfterPublic.length === 1, callsAfterPublic);

// The client (src/lib/database.js) is what actually calls createAnnouncement
// after seeing schedule_changed === true here; simulate that call the same
// way createTrip's existing announcement blast does, including the new CTA
// snapshot, to prove the reused F-03 pipeline still works end to end.
const ANN = '40000000-0000-4000-8000-000000000001';
const WORKER = '50000000-0000-4000-8000-000000000001';
await db.query(
  `INSERT INTO announcements (id, title, content, send_email, cta_label, cta_url) VALUES ($1, 'Schedule Update', 'Body', true, 'View Updated Schedule', 'https://cargoexpress-ph.online/schedules')`,
  [ANN],
);
await db.exec(`INSERT INTO email_subscriptions VALUES ('inquiry-only@example.com', true), ('registered-no-booking@example.com', true)`);
const claim = await value(
  `SELECT claim_announcement_email_broadcast($1, 'CargoExpress <updates@example.com>', $2, 120) AS result`,
  [ANN, WORKER],
);
ok('public broadcast job claims successfully', claim.result.state === 'claimed', claim.result);
ok('public broadcast reaches inquiry-only/no-booking subscribers too', Number(claim.result.total) === 2, claim.result);
ok('CTA label snapshot propagated onto the broadcast job', claim.result.cta_label === 'View Updated Schedule', claim.result);
ok('CTA url snapshot propagated onto the broadcast job', claim.result.cta_url === 'https://cargoexpress-ph.online/schedules', claim.result);

// ── 4. A later, genuinely different reschedule is its own distinct event ──
const r3 = await value(
  `SELECT reschedule_trip($1, '2026-10-20T00:00:00Z', '2026-10-22T00:00:00Z', false, NULL) AS result`,
  [TRIP],
);
ok('a later genuine reschedule is reported as changed again', r3.result.schedule_changed === true, r3.result);
const callsAfterSecondPrivate = await rows(`SELECT * FROM net.calls`);
ok('the later reschedule (private path) fires its own courtesy call', callsAfterSecondPrivate.length === 2, callsAfterSecondPrivate);

// ── 5. Non-admin cannot reschedule at all ──
await db.exec(`CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;`);
await assert.rejects(
  () => db.query(`SELECT reschedule_trip($1, '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z', false, NULL)`, [TRIP]),
  /Admin privileges required/,
);
ok('non-admin is rejected by reschedule_trip', true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
