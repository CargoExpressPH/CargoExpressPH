#!/usr/bin/env node
// ── R-01: trip-capacity race — REPRODUCTION SCRIPT (not yet run) ───────────
//
// STATUS: the finding is UNVERIFIED. This script is the means to settle it;
// it has NOT been executed in this environment, because no genuine concurrent
// PostgreSQL environment is available here:
//
//   * `psql`, `pg_ctl`, `postgres` and `docker` are all absent from PATH.
//   * The repository's database harness is PGlite, a single Postgres backend
//     compiled to WASM. It has exactly ONE connection, and queries are fully
//     serialized — a probe confirmed the interleaving
//     "A begin -> A commit -> B begin -> B commit", i.e. the second
//     transaction cannot start until the first has committed. A single-
//     connection engine cannot exhibit, or rule out, a lost-update race.
//   * node-postgres (`pg`) is not a dependency of this project.
//
// Sequential tests CANNOT establish concurrency safety, so no locking change
// has been made to guard_order_update(). Run this first.
//
// ── WHAT IS SUSPECTED ─────────────────────────────────────────────────────
// guard_order_update() (current definition:
// supabase/migrations/20260922100000_split_sender_receiver_names.sql) checks
// capacity like this:
//
//     SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0) INTO v_current_load
//       FROM public.orders o
//      WHERE o.trip_id = NEW.trip_id AND o.id <> NEW.id AND o.status <> 'Cancelled';
//     IF (v_current_load + COALESCE(NEW.actual_weight, 0))
//        > (trip_row.capacity + v_capacity_allowance) THEN RAISE ...
//
// The UPDATE holds a row lock on the order BEING CHANGED, and `SELECT * INTO
// trip_row FROM public.trips` is a plain read with no FOR UPDATE/SHARE. Under
// READ COMMITTED — Supabase's default — two transactions updating DIFFERENT
// orders on the SAME trip each aggregate the other's pre-update weight, so
// both can pass a check that their combined effect violates. Nothing
// serializes the read against the other's write.
//
// ── HOW TO RUN ────────────────────────────────────────────────────────────
//   1. Start a throwaway PostgreSQL 15+ (NEVER production, NEVER staging):
//        docker run --rm -e POSTGRES_PASSWORD=pw -p 5433:5432 postgres:15
//   2. npm i --no-save pg
//   3. DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
//        node scripts/trip-capacity-race/two-session-race.mjs
//
// The script opens TWO real connections, applies the real capacity rule,
// and drives them through an interleaving that a single-connection harness
// cannot produce. Authorization and constraints are left enabled; the
// existing units (kg), the 200 kg allowance and the cancellation exclusion
// are reproduced exactly as the migration has them.
//
// ── WHAT IT ASSERTS ───────────────────────────────────────────────────────
//   SCENARIO 1 (valid, must SUCCEED): two concurrent updates that together
//     stay within capacity both commit. A fix must not break this.
//   SCENARIO 2 (conflicting, must FAIL for one): remaining permitted load
//     100 kg; two different orders on the same trip each add 80 kg
//     concurrently. Correct behaviour is that exactly ONE commits. If BOTH
//     commit and the trip ends up 60 kg over, R-01 is REPRODUCED.
//
// ── IF IT REPRODUCES ──────────────────────────────────────────────────────
// The fix is per-trip coordination so the capacity read and the write cannot
// both pass against stale totals — e.g. `SELECT ... FROM public.trips WHERE
// id = NEW.trip_id FOR UPDATE` (or pg_advisory_xact_lock on the trip id)
// taken BEFORE the SUM. Note for a reassignment between two trips: both
// trips must be locked in a DETERMINISTIC order (e.g. ascending uuid), or two
// simultaneous swaps in opposite directions will deadlock. The same
// coordination has to cover every writer of the load: guard_order_update()
// (pickup weight, assignment, reassignment), prepare_order_insert(), and
// reassign_trip(). None of that is implemented, because none of it is
// justified until this script reproduces the failure.

import { setTimeout as sleep } from 'node:timers/promises';

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error('SKIPPED: set DATABASE_URL to a THROWAWAY PostgreSQL instance.');
  console.error('         Never point this at production or staging — it writes data.');
  process.exit(2);
}

let pg;
try { pg = (await import('pg')).default; }
catch {
  console.error('SKIPPED: node-postgres is not installed. Run: npm i --no-save pg');
  process.exit(2);
}

const { Client } = pg;
const CAPACITY = 1000;        // trips.capacity, kg
const ALLOWANCE = 200;        // v_capacity_allowance in guard_order_update()
const CEILING = CAPACITY + ALLOWANCE;

let passed = 0, failed = 0;
const ok = (d, c, extra) => { if (c) { passed++; console.log(`  ok   ${d}`); } else { failed++; console.log(`  FAIL ${d}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); } };

const admin = new Client({ connectionString: DSN });
await admin.connect();

console.log('== Building an isolated fixture (schema: capacity_race) ==');
await admin.query(`DROP SCHEMA IF EXISTS capacity_race CASCADE; CREATE SCHEMA capacity_race;`);
await admin.query(`SET search_path TO capacity_race`);
await admin.query(`
  CREATE TABLE capacity_race.trips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    capacity numeric NOT NULL,
    origin text DEFAULT 'Bohol',
    destination text DEFAULT 'Manila'
  );
  CREATE TABLE capacity_race.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id uuid REFERENCES capacity_race.trips(id),
    actual_weight numeric,
    status text DEFAULT 'Assigned'
  );

  -- The capacity block of guard_order_update(), reproduced verbatim from
  -- 20260922100000_split_sender_receiver_names.sql: same aggregate, same
  -- exclusions (self, Cancelled), same 200 kg allowance, same absence of any
  -- per-trip lock. Only the surrounding unrelated blocks are omitted.
  CREATE FUNCTION capacity_race.guard_capacity() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    trip_row capacity_race.trips%ROWTYPE;
    v_current_load NUMERIC;
    v_capacity_allowance CONSTANT NUMERIC := ${ALLOWANCE};
  BEGIN
    IF NEW.trip_id IS NOT NULL AND NEW.status <> 'Cancelled' THEN
      SELECT * INTO trip_row FROM capacity_race.trips WHERE id = NEW.trip_id;
      IF trip_row.capacity > 0
         AND (OLD.trip_id IS DISTINCT FROM NEW.trip_id
              OR NEW.actual_weight IS DISTINCT FROM OLD.actual_weight)
      THEN
        SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0)
          INTO v_current_load
          FROM capacity_race.orders o
         WHERE o.trip_id = NEW.trip_id
           AND o.id <> NEW.id
           AND o.status <> 'Cancelled';

        IF (v_current_load + COALESCE(NEW.actual_weight, 0)) > (trip_row.capacity + v_capacity_allowance) THEN
          RAISE EXCEPTION 'Cannot accept booking: exceeds maximum van capacity of % kg. This trip is carrying % kg.',
            trip_row.capacity + v_capacity_allowance, v_current_load;
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END $$;

  CREATE TRIGGER orders_guard_update BEFORE UPDATE ON capacity_race.orders
    FOR EACH ROW EXECUTE FUNCTION capacity_race.guard_capacity();
`);

const session = async () => { const c = new Client({ connectionString: DSN }); await c.connect(); await c.query(`SET search_path TO capacity_race`); return c; };
const a = await session();
const b = await session();

async function setUp(existingLoad) {
  await admin.query(`TRUNCATE capacity_race.orders, capacity_race.trips CASCADE`);
  const t = await admin.query(`INSERT INTO capacity_race.trips (capacity) VALUES ($1) RETURNING id`, [CAPACITY]);
  const tripId = t.rows[0].id;
  // One already-loaded order, plus the two that will race.
  await admin.query(`INSERT INTO capacity_race.orders (trip_id, actual_weight, status) VALUES ($1, $2, 'Picked Up')`, [tripId, existingLoad]);
  // A cancelled order that must stay excluded from the total.
  await admin.query(`INSERT INTO capacity_race.orders (trip_id, actual_weight, status) VALUES ($1, 500, 'Cancelled')`, [tripId]);
  const o1 = await admin.query(`INSERT INTO capacity_race.orders (trip_id, actual_weight) VALUES ($1, NULL) RETURNING id`, [tripId]);
  const o2 = await admin.query(`INSERT INTO capacity_race.orders (trip_id, actual_weight) VALUES ($1, NULL) RETURNING id`, [tripId]);
  return { tripId, o1: o1.rows[0].id, o2: o2.rows[0].id };
}

const load = async (tripId) => Number((await admin.query(
  `SELECT COALESCE(SUM(actual_weight),0) AS l FROM capacity_race.orders
    WHERE trip_id=$1 AND status <> 'Cancelled'`, [tripId])).rows[0].l);

/** Both sessions read, then both write, then both commit — the interleaving a single connection cannot produce. */
async function race(o1, o2, kg1, kg2) {
  await a.query('BEGIN'); await b.query('BEGIN');
  const r1 = a.query(`UPDATE capacity_race.orders SET actual_weight=$2 WHERE id=$1`, [o1, kg1]).then(() => null, e => e);
  await sleep(50);                       // let A's trigger read before B writes
  const r2 = b.query(`UPDATE capacity_race.orders SET actual_weight=$2 WHERE id=$1`, [o2, kg2]).then(() => null, e => e);
  const [e1, e2] = [await r1, await r2];
  const c1 = e1 ? a.query('ROLLBACK').then(() => 'rolled back') : a.query('COMMIT').then(() => 'committed', e => 'commit failed: ' + e.message);
  const c2 = e2 ? b.query('ROLLBACK').then(() => 'rolled back') : b.query('COMMIT').then(() => 'committed', e => 'commit failed: ' + e.message);
  return { a: { error: e1?.message ?? null, outcome: await c1 }, b: { error: e2?.message ?? null, outcome: await c2 } };
}

// ── SCENARIO 1 — valid concurrent updates must BOTH succeed ───────────────
console.log(`\n== Scenario 1: two concurrent updates that FIT (ceiling ${CEILING} kg) ==`);
{
  const { tripId, o1, o2 } = await setUp(1000);   // 200 kg of headroom
  const r = await race(o1, o2, 80, 80);           // 160 kg total: fits
  const total = await load(tripId);
  ok('session A committed', r.a.outcome === 'committed', r.a);
  ok('session B committed', r.b.outcome === 'committed', r.b);
  ok(`final load is 1160 kg, within the ${CEILING} kg ceiling`, total === 1160, total);
  ok('the cancelled 500 kg order is still excluded from the total', total === 1160, total);
}

// ── SCENARIO 2 — the race itself ──────────────────────────────────────────
console.log(`\n== Scenario 2: remaining permitted load 100 kg; two orders add 80 kg each ==`);
{
  const { tripId, o1, o2 } = await setUp(CEILING - 100);   // exactly 100 kg left
  const r = await race(o1, o2, 80, 80);
  const total = await load(tripId);
  const bothCommitted = r.a.outcome === 'committed' && r.b.outcome === 'committed';
  console.log(`  session A: ${r.a.outcome}${r.a.error ? ' — ' + r.a.error : ''}`);
  console.log(`  session B: ${r.b.outcome}${r.b.error ? ' — ' + r.b.error : ''}`);
  console.log(`  final load: ${total} kg (ceiling ${CEILING} kg)`);

  ok('exactly one of the two 80 kg updates was accepted', !bothCommitted, r);
  ok(`final load does not exceed the ${CEILING} kg ceiling`, total <= CEILING, total);

  if (bothCommitted && total > CEILING) {
    console.log(`\n  *** R-01 REPRODUCED: both updates passed the capacity check against`);
    console.log(`      stale totals and the trip is ${total - CEILING} kg over the ceiling. ***`);
  }
}

await a.end(); await b.end();
await admin.query(`DROP SCHEMA IF EXISTS capacity_race CASCADE`);
await admin.end();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
