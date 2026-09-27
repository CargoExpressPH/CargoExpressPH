// Test the access change against the live schema snapshot with synthetic users.
// This runs entirely in PGlite; no production records or API credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, as } from '../db-simplification-pgtest/harness.mjs';
import { seed, newOrder, ADMIN, CUST, CUST2 } from '../db-simplification-pgtest/fixtures.mjs';

const stage1 = '20260926100000_simplify_stage1_derive_and_compat.sql';
const stage2 = '20260926110000_simplify_stage2_drop_columns.sql';
const migration = '20260927013807_optimize_rls_policy_initplans.sql';
const rollback = 'supabase/maintenance/rollback_optimize_rls_policy_initplans.sql';
const policySnapshot = async (db) => (await db.query(`
  SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public'
   ORDER BY tablename, policyname
`)).rows;

async function asAuthenticated(db, uid, fn) {
  return as(db, uid, 'authenticated', async (tx) => {
    await tx.exec('SET LOCAL ROLE authenticated');
    return fn(tx);
  });
}

async function attempt(fn) {
  try { return { allowed: true, value: await fn() }; }
  catch (error) {
    // A rejected RLS INSERT aborts only its own test transaction.
    if (!/row-level security policy/i.test(error.message)) throw error;
    return { allowed: false };
  }
}

async function exercise(db) {
  const first = await newOrder(db, { uid: CUST });
  const second = await newOrder(db, { uid: CUST2 });
  const results = {};
  const insert = async (actor, owner) => attempt(() => asAuthenticated(db, actor, async (tx) => (
    tx.query('INSERT INTO public.conversations (customer_id) VALUES ($1) RETURNING id', [owner])
  )));
  results.inserts = {
    anotherCustomer: (await insert(CUST, CUST2)).allowed,
    own: (await insert(CUST, CUST)).allowed,
    otherOwn: (await insert(CUST2, CUST2)).allowed,
  };

  for (const [name, uid] of [['customer', CUST], ['otherCustomer', CUST2], ['admin', ADMIN]]) {
    results[name] = await asAuthenticated(db, uid, async (tx) => {
      const orders = (await tx.query('SELECT user_id::text FROM public.orders ORDER BY id')).rows.map((r) => r.user_id);
      const profiles = (await tx.query('SELECT id::text FROM public.profiles ORDER BY id')).rows.map((r) => r.id);
      const conversations = (await tx.query('SELECT customer_id::text FROM public.conversations ORDER BY id')).rows.map((r) => r.customer_id);
      return { orders, profiles, conversations };
    });
  }

  const update = async (uid, target) => asAuthenticated(db, uid, async (tx) => (
    (await tx.query('UPDATE public.profiles SET name = name WHERE id = $1 RETURNING id', [target])).rows.length
  ));
  results.updates = {
    own: await update(CUST, CUST),
    anotherCustomer: await update(CUST, CUST2),
    admin: await update(ADMIN, CUST2),
  };


  assert.deepEqual(results.customer.orders, [CUST], 'customer sees only own orders');
  assert.deepEqual(results.otherCustomer.orders, [CUST2], 'other customer sees only own orders');
  assert.deepEqual(results.admin.orders.sort(), [CUST, CUST2].sort(), 'admin sees both customers orders');
  assert.deepEqual(results.customer.profiles, [CUST], 'customer sees only own profile');
  assert.deepEqual(results.customer.conversations, [CUST], 'customer sees only own conversations');
  assert.deepEqual(results.otherCustomer.conversations, [CUST2], 'other customer sees only own conversations');
  assert.deepEqual(results.admin.conversations.sort(), [CUST, CUST2].sort(), 'admin sees both conversations');
  assert.equal(results.admin.profiles.length, 3, 'admin sees all profiles');
  assert.deepEqual(results.updates, { own: 1, anotherCustomer: 0, admin: 1 });
  assert.deepEqual(results.inserts, { own: true, otherOwn: true, anotherCustomer: false });
  assert.ok(first.id && second.id);
  return results;
}

const beforeDb = await makeDb({ migrations: [stage1, stage2] });
let before;
let originalPolicies;
try {
  originalPolicies = await policySnapshot(beforeDb);
  await seed(beforeDb);
  before = await exercise(beforeDb);
} finally {
  await beforeDb.close();
}

const afterDb = await makeDb({ migrations: [stage1, stage2, migration] });
try {
  const optimizedPolicies = await policySnapshot(afterDb);
  const changed = optimizedPolicies.filter((p, index) => JSON.stringify(p) !== JSON.stringify(originalPolicies[index]));
  assert.equal(changed.length, 36, 'only the 36 intended policies change');
  await seed(afterDb);
  const after = await exercise(afterDb);
  assert.deepEqual(after, before, 'all customer/admin access decisions are unchanged');

  await afterDb.exec(readFileSync(rollback, 'utf8'));
  assert.deepEqual(await policySnapshot(afterDb), originalPolicies, 'rollback restores every original policy');
  console.log('RLS migration and rollback: customer ownership, admin reads, updates, and inserts passed.');
} finally {
  await afterDb.close();
}
