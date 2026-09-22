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

async function expectFailure(desc, action, text) {
  try {
    await action();
    ok(desc, false, 'operation unexpectedly succeeded');
  } catch (error) {
    ok(desc, String(error.message).includes(text), error.message);
  }
}

const shiftDay = (day, offset) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

async function run() {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, name text, role text);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT current_setting('app.is_admin', true) = 'true'
    $$;
    CREATE OR REPLACE FUNCTION public.mask_name(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT value
    $$;
    CREATE TABLE public.trips (
      id uuid PRIMARY KEY,
      trip_number text NOT NULL,
      origin text NOT NULL,
      destination text NOT NULL,
      departure_date timestamptz,
      arrival_date timestamptz,
      status text NOT NULL,
      departure_at timestamptz
    );
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY,
      tracking_number text,
      sender_name text,
      receiver_name text,
      origin text,
      destination text,
      package_description text,
      actual_weight numeric,
      shipping_cost numeric,
      trip_id uuid REFERENCES public.trips(id),
      status text,
      remaining_balance numeric,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.activity_logs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      admin_id uuid,
      admin_name text NOT NULL DEFAULT 'Unknown Admin',
      module text NOT NULL,
      action text NOT NULL,
      record_type text,
      record_id uuid,
      record_ref text,
      previous_value jsonb,
      new_value jsonb,
      details text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION public.guard_activity_log_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.admin_id := auth.uid();
      SELECT name INTO NEW.admin_name FROM public.profiles WHERE id = auth.uid();
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER activity_logs_guard_insert BEFORE INSERT ON public.activity_logs
    FOR EACH ROW EXECUTE FUNCTION public.guard_activity_log_insert();
  `);

  const migration = readFileSync(
    path.resolve(REPO, 'supabase/migrations/20260922120000_trip_start_dates_and_actual_arrival.sql'),
    'utf8',
  );
  await db.exec(migration);
  ok('Migration applies in isolated PostgreSQL-compatible test database', true);
  const tripDetailSource = readFileSync(path.resolve(REPO, 'src/pages/admin/TripDetailPage.jsx'), 'utf8');
  ok('Admin reschedule UI forwards the entered reason to the audited RPC',
    /handleReschedule = async \(\{[^}]*change_reason/.test(tripDetailSource)
      && /public_reason, change_reason/.test(tripDetailSource));

  const adminId = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, name, role) VALUES ($1, 'QA Admin', 'admin')`, [adminId]);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('app.is_admin', 'true', false)`, [adminId]);

  const { rows: todayRows } = await db.query(`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS today`);
  const today = todayRows[0].today;
  const yesterday = shiftDay(today, -1);
  const tomorrow = shiftDay(today, 1);
  const atPHMidnight = (day) => `${day}T00:00:00+08:00`;
  await expectFailure('Historical actual timestamps cannot be inserted by clients', () =>
    db.query(`
      INSERT INTO public.trips (id, trip_number, origin, destination, departure_date, status, departure_at)
      VALUES ($1, 'FORGED', 'Manila', 'Cebu', $2::timestamptz, 'scheduled', now())
    `, [randomUUID(), atPHMidnight(today)]),
  'recorded by the server');

  const missingDateId = randomUUID();
  await db.query(`
    INSERT INTO public.trips (id, trip_number, origin, destination, departure_date, status)
    VALUES ($1, 'NO-DATE', 'Manila', 'Cebu', NULL, 'scheduled')
  `, [missingDateId]);
  const { rows: missingDateGate } = await db.query(`SELECT gate_state FROM public.get_trip_start_date_gates(ARRAY[$1::uuid])`, [missingDateId]);
  ok('Trip with no scheduled day fails closed in the UI gate', missingDateGate[0]?.gate_state === 'missing_date');

  const makeTrip = async (departureDay, tripNumber) => {
    const id = randomUUID();
    await db.query(`
      INSERT INTO public.trips (id, trip_number, origin, destination, departure_date, arrival_date, status)
      VALUES ($1, $2, 'Manila', 'Cebu', $3::timestamptz, $4::timestamptz, 'scheduled')
    `, [id, tripNumber, atPHMidnight(departureDay), atPHMidnight(shiftDay(departureDay, 2))]);
    await db.query(`
      INSERT INTO public.orders (id, tracking_number, trip_id, status, actual_weight, remaining_balance)
      VALUES ($1, $2, $3, 'Picked Up', 5, 0)
    `, [randomUUID(), `QA-${tripNumber}`, id]);
    return id;
  };

  const earlyId = await makeTrip(tomorrow, 'EARLY');
  const { rows: earlyGate } = await db.query(`SELECT gate_state FROM public.get_trip_start_date_gates(ARRAY[$1::uuid])`, [earlyId]);
  ok('Future trip is marked before_date by server gate', earlyGate[0]?.gate_state === 'before_date');
  await expectFailure('Database rejects starting before scheduled Manila date', () =>
    db.query(`UPDATE public.trips SET status = 'in_progress' WHERE id = $1`, [earlyId]),
  'scheduled to depart');

  const overdueId = await makeTrip(yesterday, 'OVERDUE');
  const { rows: overdueGate } = await db.query(`SELECT gate_state FROM public.get_trip_start_date_gates(ARRAY[$1::uuid])`, [overdueId]);
  ok('Past trip is marked overdue by server gate', overdueGate[0]?.gate_state === 'overdue');
  await expectFailure('Database rejects starting an overdue trip until rescheduled', () =>
    db.query(`UPDATE public.trips SET status = 'in_progress' WHERE id = $1`, [overdueId]),
  'Overdue');

  const todayId = await makeTrip(today, 'TODAY');
  const { rows: todayGate } = await db.query(`SELECT gate_state, ph_today::text FROM public.get_trip_start_date_gates(ARRAY[$1::uuid])`, [todayId]);
  ok('Same-day trip is startable according to server Manila date', todayGate[0]?.gate_state === 'today' && todayGate[0]?.ph_today === today);
  const eta = `${tomorrow}T12:00:00+08:00`;
  await db.query(`
    UPDATE public.trips
       SET status = 'in_progress',
           departure_at = '2000-01-01T00:00:00Z',
           estimated_arrival_at = $2::timestamptz
     WHERE id = $1
  `, [todayId, eta]);
  const { rows: started } = await db.query(`SELECT status, departure_at, estimated_arrival_at, arrived_at FROM public.trips WHERE id = $1`, [todayId]);
  ok('Same-day start succeeds and server overwrites caller-supplied departure timestamp', started[0]?.status === 'in_progress' && new Date(started[0].departure_at).getUTCFullYear() >= 2026);
  ok('Optional hub ETA is saved separately from existing arrival_date', started[0]?.estimated_arrival_at && started[0]?.arrived_at === null);
  await expectFailure('Caller cannot edit a recorded actual departure timestamp', () =>
    db.query(`UPDATE public.trips SET departure_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [todayId]),
  'Actual departure is set only');
  await expectFailure('Caller cannot forge actual hub arrival before Mark Arrived', () =>
    db.query(`UPDATE public.trips SET arrived_at = now() WHERE id = $1`, [todayId]),
  'Actual arrival is set only');
  await db.query(`UPDATE public.trips SET status = 'arrived' WHERE id = $1`, [todayId]);
  const { rows: arrived } = await db.query(`SELECT departure_at, estimated_arrival_at, arrived_at FROM public.trips WHERE id = $1`, [todayId]);
  ok('Mark Arrived stamps a separate actual arrival time', Boolean(arrived[0]?.arrived_at && new Date(arrived[0].arrived_at) >= new Date(arrived[0].departure_at)));
  ok('Mark Arrived preserves the estimate rather than treating it as actual',
    new Date(arrived[0]?.estimated_arrival_at).getTime() === new Date(started[0]?.estimated_arrival_at).getTime());

  const legacyTripId = randomUUID();
  await db.query(`
    INSERT INTO public.trips (id, trip_number, origin, destination, departure_date, status, departure_at)
    VALUES ($1, 'LEGACY-IN-PROGRESS', 'Manila', 'Cebu', $2::timestamptz, 'in_progress', NULL)
  `, [legacyTripId, atPHMidnight(today)]);
  await db.query(`UPDATE public.trips SET status = 'arrived' WHERE id = $1`, [legacyTripId]);
  const { rows: legacyArrived } = await db.query(`SELECT departure_at, arrived_at FROM public.trips WHERE id = $1`, [legacyTripId]);
  ok('Legacy trip arrival is recorded without fabricating a missing departure timestamp',
    legacyArrived[0]?.departure_at === null && Boolean(legacyArrived[0]?.arrived_at));

  const noEtaId = await makeTrip(today, 'NO-ETA');
  await expectFailure('An estimate at or before actual departure is rejected', () =>
    db.query(`UPDATE public.trips SET status = 'in_progress', estimated_arrival_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [noEtaId]),
  'must be later than actual departure');
  const { rows: failedStart } = await db.query(`SELECT status, departure_at FROM public.trips WHERE id = $1`, [noEtaId]);
  ok('Rejected start leaves status and timestamps unchanged', failedStart[0]?.status === 'scheduled' && failedStart[0]?.departure_at === null);
  await db.query(`UPDATE public.trips SET status = 'in_progress' WHERE id = $1`, [noEtaId]);
  const { rows: noEtaStarted } = await db.query(`SELECT estimated_arrival_at, arrived_at FROM public.trips WHERE id = $1`, [noEtaId]);
  ok('No estimate remains explicitly unknown and no arrival is fabricated', noEtaStarted[0]?.estimated_arrival_at === null && noEtaStarted[0]?.arrived_at === null);

  await expectFailure('Non-admin cannot read the start date gate', async () => {
    await db.query(`SELECT set_config('app.is_admin', 'false', false)`);
    return db.query(`SELECT * FROM public.get_trip_start_date_gates(ARRAY[$1::uuid])`, [todayId]);
  }, 'Admin privileges required');
  await db.query(`SELECT set_config('app.is_admin', 'true', false)`);

  const rescheduleId = await makeTrip(yesterday, 'RESCHEDULE');
  await expectFailure('Generic table update cannot bypass the required reschedule reason and audit event', () =>
    db.query(`UPDATE public.trips SET departure_date = $2::timestamptz WHERE id = $1`, [rescheduleId, atPHMidnight(tomorrow)]),
  'Use the authorized trip reschedule action');
  await expectFailure('Authorized reschedule action cannot set a past Manila day', () =>
    db.query(`SELECT public.reschedule_trip($1, $2::timestamptz, $3::timestamptz, false, null, 'Weather delay')`, [rescheduleId, atPHMidnight(shiftDay(yesterday, -1)), atPHMidnight(today)]),
  'cannot be rescheduled to a past Manila date');
  const { rows: rescheduled } = await db.query(`
    SELECT public.reschedule_trip($1, $2::timestamptz, $3::timestamptz, false, null, $4) AS result
  `, [rescheduleId, atPHMidnight(tomorrow), atPHMidnight(shiftDay(tomorrow, 2)), 'Vehicle maintenance delay']);
  const { rows: logs } = await db.query(`SELECT admin_id, admin_name, previous_value, new_value, details FROM public.activity_logs WHERE record_id = $1`, [rescheduleId]);
  ok('Reschedule stores old and new dates with reason in the existing activity log',
    rescheduled[0]?.result?.schedule_changed === true && logs.length === 1
      && logs[0].previous_value.departure_date
      && logs[0].new_value.departure_date
      && logs[0].details.includes('Vehicle maintenance delay'));
  ok('Reschedule activity log is attributed to the authenticated admin', logs[0]?.admin_id === adminId && logs[0]?.admin_name === 'QA Admin');
  await expectFailure('Cached legacy reschedule call cannot bypass required audit reason', () =>
    db.query(`SELECT public.reschedule_trip($1, $2::timestamptz, $3::timestamptz, false, null)`, [rescheduleId, atPHMidnight(today), atPHMidnight(tomorrow)]),
  'rescheduling reason is required');

  const { rows: tracking } = await db.query(`SELECT trip_departure_date, trip_departure_at, trip_estimated_arrival_at, trip_arrived_at FROM public.track_order_public($1)`, [`QA-TODAY`]);
  ok('Public tracking RPC returns only the explicit trip timing fields from the trip', tracking.length === 1 && tracking[0].trip_departure_at && tracking[0].trip_arrived_at);

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.close();
  if (failed) process.exit(1);
}

run().catch(async (error) => {
  console.error(error);
  await db.close();
  process.exit(1);
});
