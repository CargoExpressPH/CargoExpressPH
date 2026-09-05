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

const functions = [
  { slug: 'send-push', verifyJwt: false },
  { slug: 'process-push-deliveries', verifyJwt: true },
  { slug: 'submit-inquiry', verifyJwt: false },
];

// Deploy everything by default, or only the named slugs. Redeploying an
// unchanged function is harmless but bumps its version, which makes the
// deployment history useless for answering "when did this last change?".
const requested = process.argv.slice(2);
const selected = requested.length
  ? functions.filter(definition => requested.includes(definition.slug))
  : functions;
assert.equal(selected.length, requested.length || functions.length, `Unknown function slug in: ${requested.join(', ')}`);

for (const definition of selected) {
  const sourcePath = `supabase/functions/${definition.slug}/index.ts`;
  const source = readFileSync(sourcePath, 'utf8');
  const form = new FormData();
  form.append('metadata', JSON.stringify({
    name: definition.slug,
    entrypoint_path: 'index.ts',
    verify_jwt: definition.verifyJwt,
  }));
  form.append('file', new Blob([source], { type: 'application/typescript' }), 'index.ts');

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/functions/deploy?slug=${encodeURIComponent(definition.slug)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(`${definition.slug}: ${body?.message || body?.error || JSON.stringify(body)}`);
  assert.equal(body.slug, definition.slug);
  assert.equal(body.verify_jwt, definition.verifyJwt);
  assert.equal(body.status, 'ACTIVE');
  console.log(`${body.slug}: ACTIVE version ${body.version}, verify_jwt=${body.verify_jwt}`);
}
