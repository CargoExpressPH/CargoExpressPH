// Isolated characterization of the CURRENT pickup-payment RPC boundary.
// This uses PGlite only; it never connects to Supabase or a provider.
// The RPC body is loaded verbatim from the latest migration. The minimal
// fixture intentionally supplies the order's payable amount and the real
// prerequisite helper/GCash guard, but does not model every production
// pricing trigger or provider integration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const migration = (name) => readFileSync(path.join(repo, 'supabase/migrations', name), 'utf8');
const db = new PGlite();
const adminId = '00000000-0000-0000-0000-000000000001';
const customerId = '00000000-0000-0000-0000-000000000002';

await db.exec(readFileSync(path.join(here, 'payment-ledger-pgtest/harness-schema.sql'), 'utf8'));
await db.exec(migration('20260909010000_payment_ledger_integrity_columns.sql'));
await db.exec(`
  ALTER TABLE public.orders
    ADD COLUMN discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN discount_reason TEXT,
    ADD COLUMN discount_notes TEXT;
`);

// Use the actual payable helper definition from the shipping-discount
// migration, then the actual payment guard and both historical/current RPC
// definitions. This ensures the tested RPC is the deployed migration body.
const discountSql = migration('20260911020000_shipping_discount_guards.sql');
const payableHelper = discountSql.match(/CREATE OR REPLACE FUNCTION public\.order_payable_amount\([\s\S]*?\n\$\$;/)?.[0];
assert.ok(payableHelper, 'extract authoritative order_payable_amount helper');
await db.exec(payableHelper);
await db.exec(migration('20260909030000_manual_payment_hardening.sql'));
await db.exec(migration('20260911030000_record_pickup_payment_discount.sql'));
await db.exec(migration('20260920120000_fix_pickup_payment_discount_race.sql'));

await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Test Admin', 'admin'), ($2, 'Test Customer', 'customer')`, [adminId, customerId]);

async function createOrder(tracking) {
  const { rows } = await db.query(
    `INSERT INTO orders (tracking_number, shipping_cost, remaining_balance, status, user_id)
     VALUES ($1, 1000, 1000, 'Assigned', $2) RETURNING id`,
    [tracking, customerId],
  );
  return rows[0].id;
}

async function recordPickup(orderId, amount) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', 'authenticated', true)`, [adminId]);
    return tx.query(
      `SELECT * FROM record_pickup_payment(
        p_order_id => $1::uuid,
        p_actual_weight => 10::numeric,
        p_payment_method => 'cash',
        p_payer_type => 'sender',
        p_pickup_photos => '[]'::jsonb,
        p_promised_payment_date => NULL::date,
        p_amount => $2::numeric,
        p_reference => NULL::text,
        p_payment_date => CURRENT_DATE,
        p_receipt_url => NULL::text,
        p_payment_type => 'Initial Payment',
        p_notes => 'isolated boundary audit',
        p_idempotency_key => NULL::uuid,
        p_admin_verified_receipt => false,
        p_discount_amount => 0::numeric,
        p_discount_reason => NULL::text,
        p_discount_notes => NULL::text
      )`,
      [orderId, amount],
    );
  });
}

async function ledger(orderId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total
       FROM payment_transactions WHERE order_id = $1`,
    [orderId],
  );
  return rows[0];
}

const normalOrder = await createOrder('AUDIT-VALID');
const normalResult = await recordPickup(normalOrder, 1000);
assert.equal(normalResult.rows[0].payment_status, 'paid');
assert.deepEqual(await ledger(normalOrder), { count: 1, total: '1000.00' });
console.log('PASS: exact payable amount is recorded once and settles the fixture.');

const overOrder = await createOrder('AUDIT-OVER');
await recordPickup(overOrder, 1500);
const overLedger = await ledger(overOrder);
const overBalance = await db.query('SELECT amount_paid, remaining_balance, payment_status FROM orders WHERE id = $1', [overOrder]);
assert.equal(overLedger.count, 1);
assert.equal(Number(overLedger.total), 1500);
assert.equal(Number(overBalance.rows[0].amount_paid), 1500);
assert.equal(Number(overBalance.rows[0].remaining_balance), 0);
assert.equal(overBalance.rows[0].payment_status, 'paid');
console.log('REPRODUCED: pickup RPC accepts 1500 against the fixture payable 1000 and credits all 1500.');

const negativeOrder = await createOrder('AUDIT-NEGATIVE');
const negativeResult = await recordPickup(negativeOrder, -25);
assert.equal(negativeResult.rows[0].status, 'Picked Up');
assert.deepEqual(await ledger(negativeOrder), { count: 0, total: '0' });
console.log('REPRODUCED: pickup RPC accepts -25 as a no-payment pickup and writes no payment row.');

await db.close();
