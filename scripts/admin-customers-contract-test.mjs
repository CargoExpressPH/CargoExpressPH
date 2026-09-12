import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const page = readFileSync('src/pages/admin/CustomersPage.jsx', 'utf8');
const database = readFileSync('src/lib/database.js', 'utf8');
const migration = readFileSync('supabase/migrations/20260912022000_admin_customer_directory.sql', 'utf8');

assert.match(page, /<table className="data-table customer-directory-table">/);
for (const heading of ['Customer', 'Contact', 'Location', 'Bookings', 'Outstanding', 'Last booking', 'Status', 'Action']) {
  assert.match(page, new RegExp(`>${heading}<`), `desktop table is missing ${heading}`);
}
assert.match(page, /customer-directory-mobile-card/);
assert.match(page, /@media \(max-width: 1000px\)/);
assert.doesNotMatch(page, /customers-grid|customer-card stagger-item/);
assert.match(page, /Phone not provided/);
assert.match(page, /No bookings yet/);
assert.match(page, /balance > 0 &&/);
assert.match(page, /maxLength=\{100\}/);

const mobileMarkup = page.match(/<div className="customer-directory-mobile"[\s\S]*?<div className="customer-directory-pagination">/)?.[0] || '';
assert.ok(mobileMarkup, 'mobile customer list markup is missing');
assert.doesNotMatch(mobileMarkup, /customer\.email/, 'mobile cards must not expose email addresses');

assert.match(database, /supabase\.rpc\('get_admin_customers'/);
assert.match(database, /supabase\.rpc\('get_admin_customer_provinces'/);
assert.doesNotMatch(database.match(/export const getCustomers[\s\S]*?^};/m)?.[0] || '', /\.from\('orders'\)/);

assert.match(migration, /SECURITY DEFINER/g);
assert.match(migration, /SET search_path = public/g);
assert.match(migration, /auth\.uid\(\) IS NULL OR NOT public\.is_admin\(\)/g);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_admin_customers/);
assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_orders_user_id/);
assert.match(migration, /COALESCE\(o\.shipping_cost, 0\)[\s\S]*COALESCE\(o\.discount_amount, 0\)[\s\S]*COALESCE\(o\.amount_paid, 0\)/);

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE SCHEMA auth;

  CREATE TABLE public.profiles (
    id UUID PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    address_city VARCHAR(255),
    address_province VARCHAR(255),
    role VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE public.orders (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.profiles(id),
    status VARCHAR(30) NOT NULL,
    shipping_cost NUMERIC,
    discount_amount NUMERIC,
    amount_paid NUMERIC,
    created_at TIMESTAMPTZ NOT NULL
  );

  CREATE FUNCTION auth.uid() RETURNS UUID
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID $$;

  CREATE FUNCTION public.is_admin() RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  $$;

  INSERT INTO public.profiles VALUES
    ('00000000-0000-4000-8000-000000000001', 'Admin', 'admin@example.test', NULL, NULL, NULL, 'admin', '2026-01-01T00:00:00Z'),
    ('00000000-0000-4000-8000-000000000002', 'Ana Customer', 'ana@example.test', '09170000001', 'Cebu City', 'Cebu', 'customer', '2026-01-05T00:00:00Z'),
    ('00000000-0000-4000-8000-000000000003', 'Bea No Booking', 'bea@example.test', NULL, 'Tagbilaran', NULL, 'customer', '2026-03-01T00:00:00Z'),
    ('00000000-0000-4000-8000-000000000004', 'Carlo Active', 'carlo@example.test', '09170000003', 'Panglao', 'Bohol', 'customer', '2026-02-01T00:00:00Z');

  INSERT INTO public.orders VALUES
    ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Pending', 1000, 100, 400, '2026-02-10T00:00:00Z'),
    ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'Delivered', 500, 0, 500, '2026-02-20T00:00:00Z'),
    ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', 'Assigned', 500, 0, 500, '2026-03-05T00:00:00Z');

  SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false);
`);

await db.exec(migration);
await db.exec(migration);

const all = await db.query(`SELECT * FROM public.get_admin_customers(1, 15, '', 'all', NULL, 'newest')`);
assert.equal(all.rows.length, 3);
assert.equal(Number(all.rows[0].total_count), 3);
assert.equal(all.rows[0].name, 'Bea No Booking');

const ana = all.rows.find(row => row.name === 'Ana Customer');
assert.equal(Number(ana.total_bookings), 2);
assert.equal(Number(ana.outstanding_balance), 500);
assert.equal(ana.directory_status, 'with_balance');
assert.equal(new Date(ana.last_booking_at).toISOString(), '2026-02-20T00:00:00.000Z');

const active = all.rows.find(row => row.name === 'Carlo Active');
assert.equal(active.directory_status, 'active');
assert.equal(Number(active.outstanding_balance), 0);

const balanceOnly = await db.query(`SELECT name FROM public.get_admin_customers(1, 15, '', 'with_balance', NULL, 'highest_balance')`);
assert.deepEqual(balanceOnly.rows.map(row => row.name), ['Ana Customer']);

const pendingOnly = await db.query(`SELECT name FROM public.get_admin_customers(1, 15, '', 'pending', NULL, 'newest')`);
assert.deepEqual(pendingOnly.rows.map(row => row.name), ['Ana Customer']);

const noBookings = await db.query(`SELECT name FROM public.get_admin_customers(1, 15, '', 'no_bookings', NULL, 'newest')`);
assert.deepEqual(noBookings.rows.map(row => row.name), ['Bea No Booking']);

const searched = await db.query(`SELECT name FROM public.get_admin_customers(1, 15, 'tagbilaran', 'all', NULL, 'name_asc')`);
assert.deepEqual(searched.rows.map(row => row.name), ['Bea No Booking']);

const province = await db.query(`SELECT name FROM public.get_admin_customers(1, 15, '', 'all', 'Cebu', 'name_asc')`);
assert.deepEqual(province.rows.map(row => row.name), ['Ana Customer']);

const pageTwo = await db.query(`SELECT name, total_count FROM public.get_admin_customers(2, 2, '', 'all', NULL, 'name_asc')`);
assert.deepEqual(pageTwo.rows.map(row => row.name), ['Carlo Active']);
assert.equal(Number(pageTwo.rows[0].total_count), 3);

const provinces = await db.query(`SELECT province FROM public.get_admin_customer_provinces()`);
assert.deepEqual(provinces.rows.map(row => row.province), ['Bohol', 'Cebu']);

await db.exec(`SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false);`);
await assert.rejects(
  db.query(`SELECT * FROM public.get_admin_customers()`),
  /Admin access required/,
);

await db.close();
console.log('Admin customer directory contract tests passed.');
