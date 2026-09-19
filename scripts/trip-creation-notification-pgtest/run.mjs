import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migrationPath = 'supabase/migrations/20260919231046_notify_customers_on_trip_creation.sql';
const migration = readFileSync(migrationPath, 'utf8');
const audiencePolicyMigrationPath = 'supabase/migrations/20260919232534_restrict_email_only_announcements.sql';
const audiencePolicyMigration = readFileSync(audiencePolicyMigrationPath, 'utf8');
const databaseSource = readFileSync('src/lib/database.js', 'utf8');
const createTripPage = readFileSync('src/pages/admin/CreateTripPage.jsx', 'utf8');
const announcementsPage = readFileSync('src/pages/admin/AnnouncementsPage.jsx', 'utf8');

const db = new PGlite();

await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA private;

  CREATE TABLE public.profiles (
    id UUID PRIMARY KEY,
    role TEXT NOT NULL
  );

  CREATE TABLE public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL,
    reference_id UUID
  );

  CREATE TABLE public.trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    departure_date TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE public.announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    send_email BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
  GRANT USAGE ON SCHEMA public TO authenticated;
  GRANT SELECT ON public.announcements TO authenticated;

  CREATE POLICY "Authenticated users can view announcements"
    ON public.announcements
    FOR SELECT
    TO authenticated
    USING (true);

  CREATE OR REPLACE FUNCTION private.notify_announcement_customers()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
  AS $function$
  BEGIN
    IF NEW.is_active THEN
      INSERT INTO public.notifications (user_id, title, message, type, reference_id)
      SELECT p.id, 'New Announcement', NEW.title, 'announcement', NEW.id
      FROM public.profiles AS p
      WHERE p.role = 'customer'
      ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
  END;
  $function$;

  CREATE TRIGGER announcements_notify_customers
  AFTER INSERT ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION private.notify_announcement_customers();
`);

await db.exec(migration);
await db.exec(audiencePolicyMigration);

const CUSTOMER_ONE = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_TWO = '10000000-0000-4000-8000-000000000002';
const ADMIN = '10000000-0000-4000-8000-000000000003';
const TRIP = '20000000-0000-4000-8000-000000000001';

await db.query(
  `INSERT INTO public.profiles (id, role) VALUES ($1, 'customer'), ($2, 'customer'), ($3, 'admin')`,
  [CUSTOMER_ONE, CUSTOMER_TWO, ADMIN],
);

await db.query(
  `INSERT INTO public.trips (id, origin, destination, departure_date)
   VALUES ($1, 'Bohol', 'Manila', '2026-09-25T00:00:00+08')`,
  [TRIP],
);

const tripNotifications = await db.query(`
  SELECT user_id, title, message, type, reference_id
  FROM public.notifications
  WHERE reference_id = $1
  ORDER BY user_id
`, [TRIP]);

assert.equal(tripNotifications.rows.length, 2, 'one trip notification must be created per customer');
assert.deepEqual(tripNotifications.rows.map(row => row.user_id), [CUSTOMER_ONE, CUSTOMER_TWO]);
for (const notification of tripNotifications.rows) {
  assert.equal(notification.title, 'New Trip Available');
  assert.equal(notification.type, 'trip_update');
  assert.equal(notification.reference_id, TRIP);
  assert.match(notification.message, /Bohol → Manila is scheduled for September 25, 2026/);
}

await db.query(`
  INSERT INTO public.announcements (title, content, audience)
  VALUES ('Public notice', 'Visible to customers', 'public')
`);
let announcementCount = await db.query(`
  SELECT count(*)::int AS count FROM public.notifications WHERE type = 'announcement'
`);
assert.equal(announcementCount.rows[0].count, 2, 'public announcements must still notify customers');

await db.query(`
  INSERT INTO public.announcements (title, content, send_email, audience)
  VALUES ('Trip email', 'Subscriber email only', true, 'email_only')
`);
announcementCount = await db.query(`
  SELECT count(*)::int AS count FROM public.notifications WHERE type = 'announcement'
`);
assert.equal(announcementCount.rows[0].count, 2, 'email-only records must not create duplicate notifications');

await db.exec('SET ROLE authenticated');
const customerVisibleAnnouncements = await db.query(`
  SELECT title FROM public.announcements ORDER BY title
`);
await db.exec('RESET ROLE');
assert.deepEqual(
  customerVisibleAnnouncements.rows.map(row => row.title),
  ['Public notice'],
  'authenticated customer reads must exclude email-only announcement records',
);

await assert.rejects(
  db.query(`INSERT INTO public.announcements (title, content, audience) VALUES ('Bad', 'Bad', 'unknown')`),
  /announcements_audience_check/,
);

assert.match(databaseSource, /audience:\s*'email_only'/);
assert.match(databaseSource, /query\.eq\('audience', 'public'\)/);
assert.match(createTripPage, /Also email subscribed customers/);
assert.match(createTripPage, /in-app notification automatically/);
assert.match(announcementsPage, /getAnnouncements\(\{ includeEmailOnly: true \}\)/);
assert.match(announcementsPage, /a\.audience === 'email_only'/);

await db.close();
console.log('Trip creation notification database tests passed.');
