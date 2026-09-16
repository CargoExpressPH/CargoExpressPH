import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE TABLE profiles(id uuid PRIMARY KEY, role text NOT NULL);
  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
  CREATE TABLE announcements(
    id uuid PRIMARY KEY, title text NOT NULL, content text NOT NULL,
    send_email boolean NOT NULL DEFAULT false, emailed_at timestamptz
  );
  CREATE TABLE email_subscriptions(email text PRIMARY KEY, subscribed boolean NOT NULL);
`);
await db.exec(readFileSync('supabase/migrations/20260916161000_durable_announcement_broadcasts.sql', 'utf8'));

const ANN = '10000000-0000-4000-8000-000000000001';
const W1 = '20000000-0000-4000-8000-000000000001';
const W2 = '20000000-0000-4000-8000-000000000002';
await db.query(`INSERT INTO announcements VALUES ($1,'Subject','Body',true,NULL)`, [ANN]);
await db.exec(`INSERT INTO email_subscriptions VALUES ('a@example.com',true),('b@example.com',true),('off@example.com',false)`);

const value = async (sql, params = []) => (await db.query(sql, params)).rows[0].value;
const claim1 = await value(`SELECT claim_announcement_email_broadcast($1,'Cargo <mail@example.com>',$2,120) value`, [ANN, W1]);
assert.equal(claim1.state, 'claimed');
assert.equal(Number(claim1.total), 2);
const busy = await value(`SELECT claim_announcement_email_broadcast($1,'changed@example.com',$2,120) value`, [ANN, W2]);
assert.equal(busy.state, 'busy', 'a concurrent worker must not own the same job');

const first = await value(`SELECT claim_announcement_email_recipient($1,$2,45) value`, [ANN, W1]);
assert.match(first.idempotency_key, /^[0-9a-f-]{36}$/);
const payload = { from: 'Cargo <mail@example.com>', to: first.email, subject: 'Subject', html: 'Body' };
const persisted = await value(`SELECT prepare_announcement_email_payload($1,$2,$3,$4,$5::jsonb) value`,
  [ANN, W1, first.id, first.recipient_token, JSON.stringify(payload)]);
assert.deepEqual(persisted, payload);
await db.query(`SELECT record_announcement_email_outcome($1,$2,$3,$4,'accepted','provider-1',NULL,60)`,
  [ANN, W1, first.id, first.recipient_token]);

const second = await value(`SELECT claim_announcement_email_recipient($1,$2,45) value`, [ANN, W1]);
await db.query(`SELECT record_announcement_email_outcome($1,$2,$3,$4,'retryable',NULL,'temporary failure',15)`,
  [ANN, W1, second.id, second.recipient_token]);
const partial = await value(`SELECT finish_announcement_email_broadcast($1,$2) value`, [ANN, W1]);
assert.equal(partial.state, 'partial');
assert.equal(Number(partial.accepted), 1);
assert.equal(Number(partial.retryable), 1);
assert.equal((await db.query(`SELECT emailed_at FROM announcements WHERE id=$1`, [ANN])).rows[0].emailed_at, null);

await db.query(`UPDATE announcement_email_recipients SET next_attempt_at=now() WHERE id=$1`, [second.id]);
await value(`SELECT claim_announcement_email_broadcast($1,'changed@example.com',$2,120) value`, [ANN, W2]);
const retry = await value(`SELECT claim_announcement_email_recipient($1,$2,45) value`, [ANN, W2]);
assert.equal(retry.id, second.id);
assert.equal(retry.idempotency_key, second.idempotency_key, 'provider key must survive retry');
assert.deepEqual(retry.delivery_payload, null, 'a never-sent row has no payload yet');
await db.query(`SELECT prepare_announcement_email_payload($1,$2,$3,$4,$5::jsonb)`,
  [ANN, W2, retry.id, retry.recipient_token, JSON.stringify({ ...payload, to: retry.email })]);
await db.query(`SELECT record_announcement_email_outcome($1,$2,$3,$4,'accepted','provider-2',NULL,60)`,
  [ANN, W2, retry.id, retry.recipient_token]);

// Force the final announcement write to fail. The RPC transaction must roll
// back, retaining accepted recipient outcomes and the active job claim.
await db.exec(`
  CREATE FUNCTION fail_announcement_completion() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'simulated completion failure'; END $$;
  CREATE TRIGGER fail_completion BEFORE UPDATE OF emailed_at ON announcements
  FOR EACH ROW EXECUTE FUNCTION fail_announcement_completion();
`);
await assert.rejects(() => value(`SELECT finish_announcement_email_broadcast($1,$2) value`, [ANN, W2]), /simulated completion failure/);
assert.equal((await db.query(`SELECT status FROM announcement_email_recipients WHERE id=$1`, [retry.id])).rows[0].status, 'accepted');
await db.exec(`DROP TRIGGER fail_completion ON announcements`);
const completed = await value(`SELECT finish_announcement_email_broadcast($1,$2) value`, [ANN, W2]);
assert.equal(completed.state, 'completed');
assert.ok((await db.query(`SELECT emailed_at FROM announcements WHERE id=$1`, [ANN])).rows[0].emailed_at);

// Expired uncertain claims are recovered with the same key inside the 23-hour
// window and moved to manual review after that provider window has elapsed.
const ANN2 = '10000000-0000-4000-8000-000000000002';
const W3 = '20000000-0000-4000-8000-000000000003';
await db.query(`UPDATE email_subscriptions SET subscribed=false WHERE email='b@example.com'`);
await db.query(`INSERT INTO announcements VALUES ($1,'Other','Body',true,NULL)`, [ANN2]);
await value(`SELECT claim_announcement_email_broadcast($1,'mail@example.com',$2,120) value`, [ANN2, W1]);
const uncertain = await value(`SELECT claim_announcement_email_recipient($1,$2,45) value`, [ANN2, W1]);
await db.query(`UPDATE announcement_email_recipients SET claim_expires_at=now()-interval '1 second' WHERE id=$1`, [uncertain.id]);
await db.query(`UPDATE announcement_email_broadcasts SET claim_expires_at=now()-interval '1 second' WHERE announcement_id=$1`, [ANN2]);
await value(`SELECT claim_announcement_email_broadcast($1,'mail@example.com',$2,120) value`, [ANN2, W3]);
const recovered = await value(`SELECT claim_announcement_email_recipient($1,$2,45) value`, [ANN2, W3]);
assert.equal(recovered.idempotency_key, uncertain.idempotency_key);
await db.query(`UPDATE announcement_email_recipients SET claim_expires_at=now()-interval '1 second', first_attempt_at=now()-interval '24 hours' WHERE id=$1`, [uncertain.id]);
await db.query(`UPDATE announcement_email_broadcasts SET claim_expires_at=now()-interval '1 second' WHERE announcement_id=$1`, [ANN2]);
await value(`SELECT claim_announcement_email_broadcast($1,'mail@example.com',$2,120) value`, [ANN2, W1]);
assert.equal((await db.query(`SELECT status FROM announcement_email_recipients WHERE id=$1`, [uncertain.id])).rows[0].status, 'needs_review');
const review = await value(`SELECT finish_announcement_email_broadcast($1,$2) value`, [ANN2, W1]);
assert.equal(review.state, 'needs_review');
assert.equal((await db.query(`SELECT emailed_at FROM announcements WHERE id=$1`, [ANN2])).rows[0].emailed_at, null);

console.log('Announcement broadcast database tests passed (claims, durable outcomes, retry key, expiry, atomic completion).');
await db.close();
