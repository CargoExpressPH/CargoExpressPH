// Reproduce the anonymous public-tracking projection regression using only
// synthetic data in PGlite. This executes the historical hardened RPC and the
// latest migration's RPC definition; it never contacts Supabase.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = (name) => readFileSync(path.join(repo, 'supabase/migrations', name), 'utf8');
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
    trip_id uuid REFERENCES public.trips(id),
    created_at timestamptz,
    updated_at timestamptz
  );
`);

const maskSql = migration('20260723120000_harden_public_tracking.sql')
  .match(/CREATE OR REPLACE FUNCTION public\.mask_name\([\s\S]*?\n\$\$;/)?.[0];
assert.ok(maskSql, 'extract mask_name helper from its migration');
await db.exec(maskSql);

const historicSql = migration('20260806000000_harden_public_rpcs.sql')
  .match(/DROP FUNCTION IF EXISTS public\.track_order_public\(TEXT\);[\s\S]*?GRANT EXECUTE ON FUNCTION public\.track_order_public\(TEXT\) TO anon, authenticated;/)?.[0];
assert.ok(historicSql, 'extract the earlier hardened anonymous RPC');
await db.exec(historicSql);

await db.exec(`
  INSERT INTO public.trips (id, arrival_date, departure_date)
  VALUES ('10000000-0000-0000-0000-000000000001', '2026-09-30T00:00:00Z', '2026-09-25T00:00:00Z');
  INSERT INTO public.orders (
    id, tracking_number, status, sender_name, receiver_name, origin, destination,
    package_description, actual_weight, shipping_cost, trip_id, created_at, updated_at
  ) VALUES (
    '20000000-0000-0000-0000-000000000001', 'CE-20260922-1234', 'Assigned',
    'Synthetic Sender', 'Synthetic Receiver', 'Bohol', 'Manila',
    'Synthetic confidential package description that is longer than forty characters',
    37.25, 9876.54, '10000000-0000-0000-0000-000000000001',
    '2026-09-22T01:00:00Z', '2026-09-22T02:00:00Z'
  );
`);

await db.query('SET ROLE anon');
const before = await db.query(`SELECT * FROM public.track_order_public('CE-20260922-1234')`);
assert.equal(before.rows.length, 1);
assert.equal('shipping_cost' in before.rows[0], false);
assert.ok(before.rows[0].package_description.length <= 41, 'historic public description is capped at 40 characters plus ellipsis');
console.log('PASS: earlier hardened anon projection hides shipping_cost and truncates the package description.');

await db.query('RESET ROLE');
const currentSql = migration('20260922120000_trip_start_dates_and_actual_arrival.sql')
  .match(/DROP FUNCTION IF EXISTS public\.track_order_public\(TEXT\);[\s\S]*?GRANT EXECUTE ON FUNCTION public\.track_order_public\(TEXT\) TO anon, authenticated;/)?.[0];
assert.ok(currentSql, 'extract the latest anonymous RPC from the current migration');
await db.exec(currentSql);

await db.query('SET ROLE anon');
const after = await db.query(`SELECT * FROM public.track_order_public('CE-20260922-1234')`);
assert.equal(after.rows.length, 1);
assert.equal(Number(after.rows[0].shipping_cost), 9876.54);
assert.equal(after.rows[0].package_description, 'Synthetic confidential package description that is longer than forty characters');
assert.equal(Number(after.rows[0].actual_weight), 37.25);
console.log('REPRODUCED: latest anon RPC returns exact shipping_cost, actual_weight, and the full package description.');

await db.close();
