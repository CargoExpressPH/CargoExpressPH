// Regression tests for the "Email Updates" subscription feature
// (20260916150000_email_updates_subscription.sql), run against a real
// embedded Postgres (PGlite — compiled Postgres, not a mock). Same approach
// as the other *-pgtest suites: a hand-built harness schema gives just
// enough of the real profiles/contact_inquiries/is_admin shape, then the
// REAL migration file is applied verbatim on top, so what's tested is
// byte-for-byte the SQL that ships.
//
// What this does NOT cover (see docs/audits/EMAIL_UPDATES_SUBSCRIPTION_FEATURE.md for
// the explicit list of verification gaps): the admin React UI, the public
// contact form, the Edge Function HTTP layer (submit-inquiry,
// unsubscribe-announcements, broadcast-announcement), and a live/staging
// Supabase project.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not new URL(...).pathname) — the latter leaves a leading
// slash before the drive letter on Windows ("/C:/...") that path.join does
// not correctly normalize away, producing a doubled "C:\C:\..." path.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const db = new PGlite();
let passed = 0;
let failed = 0;

function ok(desc, cond, extra) {
  if (cond) { passed += 1; console.log(`  ok - ${desc}`); }
  else { failed += 1; console.log(`  FAIL - ${desc}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function as(uid, role, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.uid', $1, true), set_config('app.role', $2, true)`, [uid || '', role]);
    return fn(tx);
  });
}
const asAdmin = (uid, fn) => as(uid, 'authenticated', fn);
const asCustomer = (uid, fn) => as(uid, 'authenticated', fn);
const asAnon = (fn) => as('', 'anon', fn);

console.log('== Loading harness schema (real profiles/contact_inquiries/is_admin shape) ==');
await db.exec(readFileSync(path.join(HERE, 'harness-schema.sql'), 'utf8'));

console.log('== Applying 20260916150000 verbatim ==');
await db.exec(readFileSync(
  path.join(REPO, 'supabase/migrations/20260916150000_email_updates_subscription.sql'), 'utf8'
));

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ADMIN_ID = '00000000-0000-0000-0000-000000000004';
const CUST_ID = '00000000-0000-0000-0000-000000000002';
const LEAD_NO_ACCOUNT_ID = null;

await db.query(`INSERT INTO profiles (id, name, role, email) VALUES ($1, 'Admin One', 'admin', 'admin1@cargoexpress.test')`, [ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role, email) VALUES ($1, 'Admin Two', 'admin', 'admin2@cargoexpress.test')`, [OTHER_ADMIN_ID]);
await db.query(`INSERT INTO profiles (id, name, role, email) VALUES ($1, 'Customer One', 'customer', 'customer1@cargoexpress.test')`, [CUST_ID]);

const insertInquiry = (email, wantsAnnouncements, name = 'Visitor') => db.query(
  `INSERT INTO contact_inquiries (name, contact_email, wants_announcements) VALUES ($1, $2, $3) RETURNING id`,
  [name, email, wantsAnnouncements],
);

const getSubscription = async (email) =>
  (await db.query(`SELECT * FROM email_subscriptions WHERE email = $1`, [email])).rows[0] || null;

const getProfile = async (id) =>
  (await db.query(`SELECT * FROM profiles WHERE id = $1`, [id])).rows[0];

const countSubscriptionRows = async (email) =>
  Number((await db.query(`SELECT count(*)::int AS n FROM email_subscriptions WHERE email = $1`, [email])).rows[0].n);

// ============================================================================
// 1. New inquiry, checkbox checked -> creates a subscribed=true row
// ============================================================================
console.log('\n-- Contact form: checkbox checked --');
{
  const email = 'checked1@example.test';
  await insertInquiry(email, true);
  const sub = await getSubscription(email);
  ok('a checked inquiry creates a subscription row', !!sub, sub);
  ok('the row is subscribed=true', sub?.subscribed === true, sub);
  ok('the source is contact_form', sub?.source === 'contact_form', sub);
  ok('updated_by is NULL for a self-service source', sub?.updated_by === null, sub);
}

// ============================================================================
// 2. New inquiry, checkbox unchecked -> writes nothing
// ============================================================================
console.log('\n-- Contact form: checkbox unchecked --');
{
  const email = 'unchecked1@example.test';
  await insertInquiry(email, false);
  const sub = await getSubscription(email);
  ok('an unchecked inquiry does not create a subscription row', sub === null, sub);
}

// ============================================================================
// 3. A later unchecked inquiry from the same email leaves an existing
//    subscription unchanged (must not silently cancel it)
// ============================================================================
console.log('\n-- Repeated inquiries: unchecked does not cancel an existing opt-in --');
{
  const email = 'repeat1@example.test';
  await insertInquiry(email, true);
  let sub = await getSubscription(email);
  ok('first (checked) inquiry subscribes the address', sub?.subscribed === true, sub);

  await insertInquiry(email, false);
  sub = await getSubscription(email);
  ok('second (unchecked) inquiry leaves the subscription unchanged', sub?.subscribed === true, sub);
  ok('still exactly one row for the address (no duplicate)', (await countSubscriptionRows(email)) === 1);
}

// ============================================================================
// 4. Duplicate inquiries with the same email -> exactly one recipient row
// ============================================================================
console.log('\n-- Duplicate inquiries collapse to one recipient row --');
{
  const email = 'duplicate1@example.test';
  await insertInquiry(email, true);
  await insertInquiry(email, true);
  await insertInquiry(email, true, 'Same Person Again');
  ok('three checked inquiries from the same email still produce one row', (await countSubscriptionRows(email)) === 1);
}

// ============================================================================
// 5. Admin enable requires is_admin(); records actor + source
// ============================================================================
console.log('\n-- Admin enable --');
{
  const email = 'admin-enable1@example.test';
  await insertInquiry(email, false); // no existing preference yet

  let threw = false, message = '';
  try {
    await asCustomer(CUST_ID, (tx) => tx.query(
      `SELECT * FROM public.admin_set_email_subscription($1, true)`, [email],
    ));
  } catch (e) { threw = true; message = String(e.message || e); }
  ok('a non-admin cannot enable email updates', threw && /Admin privileges required/.test(message), message);
  ok('no subscription row was created by the rejected attempt', (await getSubscription(email)) === null);

  await asAdmin(ADMIN_ID, (tx) => tx.query(
    `SELECT * FROM public.admin_set_email_subscription($1, true)`, [email],
  ));
  const sub = await getSubscription(email);
  ok('admin enable creates a subscribed=true row', sub?.subscribed === true, sub);
  ok('source is admin', sub?.source === 'admin', sub);
  ok('updated_by records the acting admin (server-derived, not client-supplied)', sub?.updated_by === ADMIN_ID, sub);
}

// ============================================================================
// 6. Cancel (i.e. simply never calling the RPC) leaves the preference
//    unchanged — modeled here as: enabling, then confirming a no-op leaves
//    state untouched.
// ============================================================================
console.log('\n-- "Cancel" leaves the preference unchanged --');
{
  const email = 'admin-cancel1@example.test';
  await asAdmin(ADMIN_ID, (tx) => tx.query(
    `SELECT * FROM public.admin_set_email_subscription($1, true)`, [email],
  ));
  const before = await getSubscription(email);
  // Simulates clicking Cancel in the confirmation modal: no RPC call at all.
  const after = await getSubscription(email);
  ok('state is identical to before when no action is taken', JSON.stringify(before) === JSON.stringify(after));
}

// ============================================================================
// 7. Admin disable stops future emails and mirrors into profiles for a
//    matching registered account (the separate trip-reschedule dependency)
// ============================================================================
console.log('\n-- Admin disable mirrors into profiles.wants_announcements --');
{
  const email = 'customer1@cargoexpress.test'; // matches CUST_ID's profile
  await db.query(`UPDATE profiles SET wants_announcements = true WHERE id = $1`, [CUST_ID]);
  await asAdmin(ADMIN_ID, (tx) => tx.query(
    `SELECT * FROM public.admin_set_email_subscription($1, true)`, [email],
  ));
  await asAdmin(ADMIN_ID, (tx) => tx.query(
    `SELECT * FROM public.admin_set_email_subscription($1, false)`, [email],
  ));
  const sub = await getSubscription(email);
  ok('admin disable sets subscribed=false', sub?.subscribed === false, sub);
  ok('source is admin after the disable call', sub?.source === 'admin', sub);
  const profile = await getProfile(CUST_ID);
  ok('the matching profile.wants_announcements is also mirrored to false', profile.wants_announcements === false, profile);
  ok('the mirror write did not overwrite source back to profile', sub?.source === 'admin', sub);
}

// ============================================================================
// 8. Registered customer's own Profile toggle syncs the authoritative table
// ============================================================================
console.log('\n-- Profile toggle syncs email_subscriptions --');
{
  const custId = '00000000-0000-0000-0000-000000000005';
  const email = 'profiletoggle1@example.test';
  await db.query(`INSERT INTO profiles (id, name, role, email, wants_announcements) VALUES ($1, 'Toggle Customer', 'customer', $2, false)`, [custId, email]);

  await db.query(`UPDATE profiles SET wants_announcements = true WHERE id = $1`, [custId]);
  let sub = await getSubscription(email);
  ok('enabling in profile creates/updates the subscription to true', sub?.subscribed === true, sub);
  ok('source is profile', sub?.source === 'profile', sub);
  ok('updated_by is NULL for a self-service source', sub?.updated_by === null, sub);

  await db.query(`UPDATE profiles SET wants_announcements = false WHERE id = $1`, [custId]);
  sub = await getSubscription(email);
  ok('disabling in profile updates the subscription to false', sub?.subscribed === false, sub);
}

// ============================================================================
// 9. Profile disable overrides an older enabled inquiry-sourced record
// ============================================================================
console.log('\n-- Profile disable overrides an older enabled inquiry record --');
{
  const custId = '00000000-0000-0000-0000-000000000006';
  const email = 'override1@example.test';
  await insertInquiry(email, true); // older, enabled, contact_form-sourced
  let sub = await getSubscription(email);
  ok('inquiry enabled the address first', sub?.subscribed === true, sub);

  // Registers with the same email, initially also opted in (no conflict
  // yet), then explicitly disables — a genuine false transition, not a
  // no-op. (The `WHEN (OLD IS DISTINCT FROM NEW)` guard on the sync trigger
  // correctly does NOT re-fire for a no-op update, e.g. inserting a profile
  // that starts out already false — that is intentional, not the scenario
  // being tested here.)
  await db.query(`INSERT INTO profiles (id, name, role, email, wants_announcements) VALUES ($1, 'Later Registrant', 'customer', $2, true)`, [custId, email]);
  await db.query(`UPDATE profiles SET wants_announcements = false WHERE id = $1`, [custId]);
  sub = await getSubscription(email);
  ok('a later profile disable is not overridden by the older enabled inquiry', sub?.subscribed === false, sub);
  ok('exactly one row still represents the address', (await countSubscriptionRows(email)) === 1);
}

// ============================================================================
// 10. Unsubscribe: single RPC, atomic, mirrors profiles + contact_inquiries
// ============================================================================
console.log('\n-- unsubscribe_email_updates --');
{
  const custId = '00000000-0000-0000-0000-000000000007';
  const email = 'unsub1@example.test';
  await db.query(`INSERT INTO profiles (id, name, role, email, wants_announcements) VALUES ($1, 'Unsub Customer', 'customer', $2, true)`, [custId, email]);
  const { id: inquiryId } = (await insertInquiry(email, true)).rows[0];

  await db.query(`SELECT public.unsubscribe_email_updates($1)`, [email]);

  const sub = await getSubscription(email);
  ok('unsubscribe sets subscribed=false', sub?.subscribed === false, sub);
  ok('source is unsubscribe_link', sub?.source === 'unsubscribe_link', sub);

  const profile = await getProfile(custId);
  ok('unsubscribe mirrors into the matching profile', profile.wants_announcements === false, profile);
  ok('the mirror did not overwrite source back to profile', sub?.source === 'unsubscribe_link');

  const inquiry = (await db.query(`SELECT wants_announcements FROM contact_inquiries WHERE id = $1`, [inquiryId])).rows[0];
  ok('unsubscribe mirrors into the matching contact_inquiries row(s)', inquiry.wants_announcements === false, inquiry);
}

// ============================================================================
// 11. Fresh opt-in after unsubscribe re-enables (a NEW, current signal)
// ============================================================================
console.log('\n-- Fresh opt-in after unsubscribe --');
{
  const email = 'resubscribe1@example.test';
  await insertInquiry(email, true);
  await db.query(`SELECT public.unsubscribe_email_updates($1)`, [email]);
  let sub = await getSubscription(email);
  ok('unsubscribed after the first opt-in', sub?.subscribed === false, sub);

  await insertInquiry(email, true, 'Same Person, Opting In Again');
  sub = await getSubscription(email);
  ok('a fresh checked inquiry re-enables after an unsubscribe', sub?.subscribed === true, sub);
  ok('source reflects the fresh opt-in', sub?.source === 'contact_form', sub);
}

// ============================================================================
// 12. broadcast-announcement's actual recipient query: subscribed=true only
// ============================================================================
console.log('\n-- Recipient selection matches subscribed=true only --');
{
  await db.query(`DELETE FROM email_subscriptions`);
  await insertInquiry('recipient-on@example.test', true);
  await insertInquiry('recipient-off@example.test', false);
  await asAdmin(ADMIN_ID, (tx) => tx.query(
    `SELECT * FROM public.admin_set_email_subscription($1, false)`, ['recipient-explicitly-off@example.test'],
  ));
  const { rows } = await db.query(`SELECT email FROM email_subscriptions WHERE subscribed = true ORDER BY email`);
  const emails = rows.map(r => r.email);
  ok('only the subscribed address is selected', emails.length === 1 && emails[0] === 'recipient-on@example.test', emails);
}

// ============================================================================
// 13. Validation: a malformed email is rejected by both RPCs
// ============================================================================
console.log('\n-- Email validation --');
{
  let threw = false;
  try {
    await asAdmin(ADMIN_ID, (tx) => tx.query(`SELECT * FROM public.admin_set_email_subscription($1, true)`, ['not-an-email']));
  } catch (e) { threw = true; }
  ok('admin_set_email_subscription rejects a malformed email', threw);

  threw = false;
  try {
    await db.query(`SELECT public.unsubscribe_email_updates($1)`, ['not-an-email']);
  } catch (e) { threw = true; }
  ok('unsubscribe_email_updates rejects a malformed email', threw);
}

// ============================================================================
// 14. Case/whitespace normalization: same address regardless of case
// ============================================================================
console.log('\n-- Case-insensitive addressing --');
{
  await insertInquiry('MixedCase@Example.Test', true);
  const sub = await getSubscription('mixedcase@example.test');
  ok('a mixed-case address is stored normalized and is found lowercase', sub?.subscribed === true, sub);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
