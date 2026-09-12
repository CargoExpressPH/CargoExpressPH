// F-007 — customer service-area mass-assignment fix, regression test.
//
// Same approach as scripts/shipping-discount-pgtest and
// scripts/payment-notification-pgtest: a real embedded Postgres (PGlite)
// running harness-schema.sql (the real pre-fix orders INSERT RLS policy +
// prepare_order_insert(), copied verbatim from the migrations that last
// defined them: 20260524190000 and 20260911020000), then the REAL new
// migration (20260912030000) is applied verbatim on top. The BEFORE
// scenarios below prove the vulnerability was real under the actual
// pre-fix SQL; the AFTER scenarios prove the actual shipped migration
// closes it.
//
// RLS is genuinely enforced (not just simulated): `SET LOCAL ROLE` switches
// the real Postgres role for the transaction, the same way Supabase's
// PostgREST layer always connects as `authenticated` and lets row_security
// decide the rest — see payment-notification-pgtest/run.mjs for the same
// pattern and its own note on why this is safe to rely on here.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..');

const db = new PGlite();

let passed = 0, failed = 0;
const failures = [];

function ok(desc, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${desc}`); }
  else { failed++; failures.push(desc); console.log(`  FAIL - ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function asUser(uid, role, fn) {
  return db.transaction(async (tx) => {
    const pgRole = role || 'authenticated';
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', $2, true)`, [uid || '', pgRole]);
    await tx.query(`SET LOCAL ROLE ${pgRole}`);
    return fn(tx);
  });
}

console.log('== Loading pre-fix harness schema (real RLS policy + trigger, verbatim) ==');
await db.exec(readFileSync(path.join(HERE, 'harness-schema.sql'), 'utf8'));

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const CUST_ID  = '00000000-0000-0000-0000-000000000002';
// Inserted as the bootstrapping superuser role, bypassing RLS — exactly like
// every other harness's fixture setup.
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Admin One', 'admin')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role) VALUES ($1, 'Customer One', 'customer')`, [CUST_ID]);

async function tryInsert(uid, role, fields) {
  const cols = ['user_id', ...Object.keys(fields)];
  const vals = [uid, ...Object.values(fields)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  try {
    const r = await asUser(uid, role, tx => tx.query(
      `INSERT INTO orders (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      vals
    ));
    return { ok: true, row: r.rows[0] };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== BASELINE (pre-migration): reproduce the actual F-003/F-007 vulnerability ==');
{
  const r = await tryInsert(CUST_ID, 'authenticated', {
    sender_province: 'Bohol',
    service_area_status: 'approved',
    service_area_remarks: 'forged by a tampered client request',
  });
  ok(
    'BEFORE fix: a customer INSERT forging service_area_status=\'approved\' succeeds — the vulnerability is real under the actual pre-fix RLS policy + trigger',
    r.ok && r.row.service_area_status === 'approved' && r.row.service_area_remarks === 'forged by a tampered client request',
    r
  );
}

console.log('\n== Applying the real F-007 fix migration (20260912030000) verbatim ==');
try {
  const sql = readFileSync(path.join(REPO, 'supabase/migrations', '20260912030000_restrict_service_area_customer_insert.sql'), 'utf8');
  await db.exec(sql);
  console.log('  applied 20260912030000_restrict_service_area_customer_insert.sql');
} catch (e) {
  console.error('  ERROR applying 20260912030000:', e.message);
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════════
// NOTE on what these next two scenarios actually prove: a BEFORE INSERT
// trigger runs and finishes rewriting NEW before the RLS WITH CHECK clause
// is ever evaluated, so prepare_order_insert() has already overwritten both
// fields to a safe, derived value by the time the new RLS check would run —
// the check can never actually observe, let alone reject, the forged input.
// This means the INSERT succeeds (as it always did), but the vulnerability
// is still fully closed: what matters is that the STORED value is never the
// forged one. The RLS clause added in this migration is real, inert
// defense-in-depth for a hypothetical future where the trigger's own
// derivation is weakened or removed — it is not, and cannot be, what is
// actually stopping today's exploit; the trigger is. Confirmed by directly
// reading the row this insert actually produced, not merely whether it
// raised an error.
console.log('\n== Scenario: AFTER fix, forging service_area_status is neutralized — the stored value is never the forged one ==');
{
  const r = await tryInsert(CUST_ID, 'authenticated', {
    sender_province: 'Bohol',
    service_area_status: 'approved',
  });
  ok(
    'a customer INSERT forging service_area_status=\'approved\' succeeds but is stored as \'standard\' (server-derived), never as the forged \'approved\'',
    r.ok && r.row.service_area_status === 'standard',
    r
  );
}

console.log('\n== Scenario: AFTER fix, forging service_area_remarks is neutralized — the stored value is never the forged one ==');
{
  const r = await tryInsert(CUST_ID, 'authenticated', {
    sender_province: 'Bohol',
    service_area_remarks: 'trying to sneak in a remark at booking time',
  });
  ok(
    'a customer INSERT forging service_area_remarks succeeds but is stored as NULL, never as the forged text',
    r.ok && r.row.service_area_remarks === null,
    r
  );
}

console.log('\n== Scenario: AFTER fix, a standard-province booking is correctly derived, even if the client claims otherwise ==');
{
  const r = await tryInsert(CUST_ID, 'authenticated', {
    sender_province: 'Bohol',
    // Client attempts to force for_review on a perfectly normal booking —
    // the trigger must override this, not merely permit it as one of two
    // "allowed" values.
    service_area_status: 'for_review',
  });
  ok(
    'a Bohol (standard) booking is server-derived to \'standard\' regardless of what the client requested',
    r.ok && r.row.service_area_status === 'standard' && r.row.service_area_remarks === null,
    r
  );
}

console.log('\n== Scenario: AFTER fix, an out-of-coverage booking is correctly flagged for review, even if the client omits the flag ==');
{
  const r = await tryInsert(CUST_ID, 'authenticated', {
    // Not one of the six standard provinces — this is what BookShipmentPage
    // actually submits once "Other Area" is chosen: the customer's own
    // free-text province, never the literal string "Other Area" itself.
    sender_province: 'Zamboanga del Sur',
  });
  ok(
    'an out-of-coverage booking is server-derived to \'for_review\' even though the client sent no service_area_status at all',
    r.ok && r.row.service_area_status === 'for_review' && r.row.service_area_remarks === null,
    r
  );
}

console.log('\n== Scenario: AFTER fix, every standard-service-area province is still recognized correctly ==');
{
  for (const province of ['Bohol', 'Metro Manila', 'Cavite', 'Batangas', 'Laguna', 'Bulacan']) {
    const r = await tryInsert(CUST_ID, 'authenticated', { sender_province: province });
    ok(`'${province}' is derived as 'standard' (regression: matches src/constants/phLocations.js's service-area list)`, r.ok && r.row.service_area_status === 'standard', r);
  }
}

console.log('\n== Scenario: AFTER fix, an admin-created (walk-in) booking is derived the same way, not exempted ==');
{
  const r = await tryInsert(ADMIN_ID, 'authenticated', {
    sender_province: 'Some Unlisted Province',
  });
  ok(
    'an admin-created booking from an out-of-coverage province is ALSO derived to \'for_review\' — the derivation is unconditional, matching the discount_amount-zeroing precedent on the same trigger',
    r.ok && r.row.service_area_status === 'for_review',
    r
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:', failures);
  process.exit(1);
}
console.log('All service-area-mass-assignment checks passed.');
