import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const db = new PGlite();
let passed = 0;
let failed = 0;

function ok(desc, cond, extra) {
  if (cond) {
    passed++;
    console.log(`✅ ${desc}`);
  } else {
    failed++;
    console.error(`❌ ${desc}`, extra ? `\n   -> ${extra}` : '');
  }
}

async function run() {
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text);
    CREATE TABLE public.trips (
      id uuid PRIMARY KEY,
      trip_number text,
      origin text,
      destination text,
      departure_date date,
      status text,
      departure_at timestamptz
    );
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY,
      tracking_number text,
      user_id uuid,
      trip_id uuid REFERENCES public.trips(id),
      status text,
      actual_weight numeric,
      remaining_balance numeric
    );
    CREATE OR REPLACE FUNCTION ph_calendar_day(ts timestamptz) RETURNS date LANGUAGE sql AS $$ SELECT ts::date $$;
  `);

  const migrationCode = readFileSync(path.resolve(REPO, 'supabase/migrations/20260918000000_fix_trip_start_validation.sql'), 'utf8');
  await db.exec(migrationCode);
  
  // Create trigger
  await db.exec(`
    CREATE TRIGGER trips_guard_status_transition 
    BEFORE UPDATE OF status ON public.trips 
    FOR EACH ROW EXECUTE FUNCTION public.guard_trip_status_transition();
  `);

  const tripId = randomUUID();
  await db.exec(`INSERT INTO trips (id, trip_number, origin, destination, departure_date, status) VALUES ('${tripId}', 'TRIP-1', 'MNL', 'CEB', '2026-01-01', 'scheduled')`);

  async function tryUpdate() {
    try {
      await db.exec(`UPDATE trips SET status = 'in_progress' WHERE id = '${tripId}'`);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  const o1 = randomUUID();
  const o2 = randomUUID();

  // Test 1: No assigned bookings
  let res = await tryUpdate();
  ok('No assigned bookings -> blocked', !res.success && res.error.includes('no active shipments are ready'));

  // Test 2: Only cancelled bookings
  await db.exec(`INSERT INTO orders (id, tracking_number, trip_id, status, actual_weight) VALUES ('${o1}', 'T1', '${tripId}', 'Cancelled', 10)`);
  res = await tryUpdate();
  ok('Only cancelled bookings -> blocked', !res.success && res.error.includes('no active shipments are ready'));

  // Test 3: Active booking with zero actual weight
  await db.exec(`DELETE FROM orders`);
  await db.exec(`INSERT INTO orders (id, tracking_number, trip_id, status, actual_weight) VALUES ('${o1}', 'T1', '${tripId}', 'Picked Up', 0)`);
  res = await tryUpdate();
  ok('Active bookings with zero actual weight -> blocked', !res.success && res.error.includes('record pickup and actual cargo weight first'));

  // Test 4: Pending bookings
  await db.exec(`DELETE FROM orders`);
  await db.exec(`INSERT INTO orders (id, tracking_number, trip_id, status, actual_weight) VALUES ('${o1}', 'T1', '${tripId}', 'Pending', 10)`);
  res = await tryUpdate();
  ok('Non-ready active shipments -> blocked', !res.success && res.error.includes('not yet picked up'));

  // Test 5: Pending Cancellation
  await db.exec(`DELETE FROM orders`);
  await db.exec(`INSERT INTO orders (id, tracking_number, trip_id, status, actual_weight) VALUES ('${o1}', 'T1', '${tripId}', 'Pending Cancellation', 10)`);
  res = await tryUpdate();
  ok('Pending cancellation -> blocked', !res.success && res.error.includes('awaiting cancellation decision'));

  // Test 6: Eligible picked-up cargo with positive actual weight
  await db.exec(`DELETE FROM orders`);
  await db.exec(`INSERT INTO orders (id, tracking_number, trip_id, status, actual_weight) VALUES ('${o1}', 'T1', '${tripId}', 'Picked Up', 10)`);
  res = await tryUpdate();
  ok('Eligible picked-up cargo -> allowed', res.success);

  // Re-schedule trip for next test
  await db.exec(`UPDATE trips SET status = 'scheduled' WHERE id = '${tripId}'`);

  // Test 7: Eligible cargo mixed with cancelled bookings -> Cancelled records contribute nothing
  await db.exec(`DELETE FROM orders`);
  await db.exec(`INSERT INTO orders (id, tracking_number, trip_id, status, actual_weight) VALUES ('${o1}', 'T1', '${tripId}', 'Cancelled', 50)`);
  await db.exec(`INSERT INTO orders (id, tracking_number, trip_id, status, actual_weight) VALUES ('${o2}', 'T2', '${tripId}', 'Picked Up', 5)`);
  res = await tryUpdate();
  ok('Eligible cargo mixed with cancelled bookings -> allowed (and uses 5kg)', res.success);
  
  // Test load fetching
  const { rows } = await db.query(`SELECT current_weight FROM get_trips_load(ARRAY['${tripId}'::uuid])`);
  ok('Load fetching ignores cancelled weight', rows[0].current_weight == 5);

  if (failed > 0) process.exit(1);
  await db.close();
}

run().catch(e => { console.error(e); process.exit(1); });
