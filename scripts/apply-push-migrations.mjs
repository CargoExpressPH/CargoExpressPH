import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'dotenv/config';

const token = process.env.SUPABASE_ACCESS_TOKEN
  || process.env.SUPABASE_PERSONAL_ACCESS_TOKEN
  || process.env.supabase_PAT;
const projectUrl = process.env.VITE_SUPABASE_URL || '';
const projectRef = new URL(projectUrl).hostname.split('.')[0];
assert.ok(token, 'Supabase PAT is missing');
assert.ok(projectRef, 'Supabase project URL is missing');

const migrations = [
  ['20260904235457', 'complete_push_delivery_system', 'supabase/migrations/20260904235457_complete_push_delivery_system.sql'],
  ['20260904235511', 'secure_push_registrations_and_policies', 'supabase/migrations/20260904235511_secure_push_registrations_and_policies.sql'],
  ['20260904235517', 'server_notification_event_coverage', 'supabase/migrations/20260904235517_server_notification_event_coverage.sql'],
  ['20260905003149', 'complete_order_notification_atomicity', 'supabase/migrations/20260905003149_complete_order_notification_atomicity.sql'],
  ['20260905051734', 'harden_push_operations', 'supabase/migrations/20260905051734_harden_push_operations.sql'],
];

const query = async sql => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.message || body?.error || JSON.stringify(body));
  return body;
};

const versions = migrations.map(([version]) => `'${version}'`).join(', ');
const applied = await query(`
  SELECT version FROM supabase_migrations.schema_migrations
  WHERE version IN (${versions}) ORDER BY version;
`);

// Only the versions this project has not recorded yet, and only as one
// transaction: a half-applied notification pipeline is the state that silently
// drops or doubles customer messages. Re-running once everything is recorded is
// a no-op rather than an error, so this stays the single entry point.
const appliedVersions = new Set(applied.map(row => row.version));
const pending = migrations.filter(([version]) => !appliedVersions.has(version));
if (pending.length === 0) {
  console.log(`All ${migrations.length} push migrations are already recorded; nothing to apply.`);
  process.exit(0);
}
console.log(`Applying: ${pending.map(([version, name]) => `${version}_${name}`).join(', ')}`);

const historyColumns = await query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations';
`);
const columnNames = new Set(historyColumns.map(row => row.column_name));
for (const required of ['version', 'statements', 'name']) {
  assert.ok(columnNames.has(required), `Migration history column is missing: ${required}`);
}

const migrationSql = pending.map(([version, name, path]) => `
${readFileSync(path, 'utf8')}
INSERT INTO supabase_migrations.schema_migrations (version, statements, name)
VALUES ('${version}', ARRAY['Applied through audited push migration workflow'], '${name}');
`).join('\n');

await query(`BEGIN;\n${migrationSql}\nCOMMIT;`);

const verified = await query(`
  SELECT version FROM supabase_migrations.schema_migrations
  WHERE version IN (${versions}) ORDER BY version;
`);
assert.deepEqual(verified.map(row => row.version), migrations.map(([version]) => version));
console.log(`Applied ${pending.length} migration(s) atomically; ${verified.length} of ${migrations.length} now recorded.`);
