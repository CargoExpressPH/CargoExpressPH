import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const customer = '00000000-0000-4000-8000-000000000041';
const admin = '00000000-0000-4000-8000-000000000042';
const conversation = '00000000-0000-4000-8000-000000000043';
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth; CREATE SCHEMA private;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL);
  CREATE TABLE public.conversations (
    id uuid PRIMARY KEY, customer_id uuid NOT NULL, status text NOT NULL,
    escalated boolean NOT NULL DEFAULT false
  );
  CREATE TABLE public.chat_messages (
    id uuid PRIMARY KEY, conversation_id uuid NOT NULL,
    sender_id uuid NOT NULL, sender_role text NOT NULL, message text NOT NULL
  );
  CREATE TABLE public.notifications (
    user_id uuid, title text, message text, type text, reference_id uuid
  );
`);
const migration = readFileSync(new URL('../supabase/migrations/20260924081343_secure_support_bot_and_handoff_notification.sql', import.meta.url), 'utf8');
await db.exec(migration);
await db.exec(`CREATE TRIGGER chat_messages_guard_insert BEFORE INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_message_insert();`);
await db.query(`INSERT INTO public.profiles VALUES ($1,'customer'),($2,'admin')`, [customer, admin]);
await db.query(`INSERT INTO public.conversations (id,customer_id,status) VALUES ($1,$2,'bot_active')`, [conversation, customer]);

await db.query(`SELECT set_config('request.jwt.claim.role','authenticated',false),
  set_config('request.jwt.claim.sub',$1,false)`, [customer]);
await assert.rejects(
  db.query(`INSERT INTO public.chat_messages VALUES (
    '00000000-0000-4000-8000-000000000051',$1,$2,'bot','Forged assistant reply')`, [conversation, customer]),
  /Sender role does not match/,
);
assert.equal((await db.query('SELECT count(*)::int AS count FROM public.chat_messages')).rows[0].count, 0);

await db.query(`INSERT INTO public.chat_messages VALUES (
  '00000000-0000-4000-8000-000000000052',$1,$2,'customer','I need help')`, [conversation, customer]);
await db.query(`SELECT set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`INSERT INTO public.chat_messages VALUES (
  '00000000-0000-4000-8000-000000000053',$1,$2,'bot','I can help')`, [conversation, customer]);
await assert.rejects(
  db.query(`INSERT INTO public.chat_messages VALUES (
    '00000000-0000-4000-8000-000000000054',$1,$2,'bot','Wrong owner')`, [conversation, admin]),
  /Invalid server bot message/,
);

await db.query(`UPDATE public.conversations SET status='waiting', escalated=true WHERE id=$1`, [conversation]);
await db.query(`UPDATE public.conversations SET status='waiting' WHERE id=$1`, [conversation]);
const { rows } = await db.query(`SELECT user_id, type, reference_id FROM public.notifications`);
assert.deepEqual(rows, [{ user_id: admin, type: 'chat_message', reference_id: conversation }]);
await db.close();
console.log('support chat sender identity and first handoff notification passed');
