// Guards against N-1 (POST_DEPLOYMENT_TARGETED_FIX_REPORT.md): `path.dirname(new
// URL(import.meta.url).pathname)` leaves a literal leading slash and un-decoded
// percent-escapes on Windows, and mis-resolves as soon as the checkout path
// contains a space (this project's own folder does). `fileURLToPath` is the
// correct, cross-platform conversion. This test fails the moment any script
// reintroduces the broken pattern, on any OS — no Windows machine required to
// catch the regression.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = HERE;
const BROKEN_PATTERN = /new URL\(\s*import\.meta\.url\s*\)\.pathname/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.mjs') || entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const offenders = [];
for (const file of walk(SCRIPTS_DIR)) {
  const src = readFileSync(file, 'utf8');
  if (BROKEN_PATTERN.test(src)) offenders.push(path.relative(process.cwd(), file));
}

if (offenders.length > 0) {
  console.error('Windows-unsafe URL().pathname path resolution found in:');
  for (const f of offenders) console.error(`  - ${f}`);
  console.error('Use fileURLToPath(import.meta.url) instead.');
  process.exit(1);
}

console.log(`Script path portability check passed (${walk(SCRIPTS_DIR).length} files scanned, 0 use the Windows-unsafe pattern).`);
