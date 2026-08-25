/* -----------------------------------------------------------------------
   token-lint.mjs — Fails the build on references to CSS custom properties
   that are never defined.

   Why this exists:
   `var(--text-primary, #f1f5f9)` shipped in both PWA install banners. There
   is no `--text-primary` token, so the fallback always won: near-white text
   on the white `--surface` in light mode, measured at 1.10:1 — invisible.
   It survived review because both banners were authored against a dark
   sheet, where the same fallback measures 14.95:1 and looks correct.

   The failure mode is silent by construction. CSS does not warn on an
   undefined custom property; it quietly takes the fallback, or drops the
   declaration entirely when there is no fallback. Nothing in the build,
   the type system or the test suite notices. The same bug had already been
   found and fixed once by hand in `.booking-submitting-card`
   (customer-mobile-refresh.css) — the comment there documents an identical
   --bg-primary / --text-primary pair. This lint is what stops the third one.

   A fallback does NOT make a reference safe. A hardcoded fallback colour is
   theme-blind by definition, so it is the bug, not the mitigation. Every
   reference must resolve to a real token.
   ----------------------------------------------------------------------- */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const SRC = 'src';
const SCANNED_EXT = new Set(['.css', '.jsx', '.js']);

/** Properties that are legitimately set at runtime rather than in a stylesheet. */
const RUNTIME_DEFINED = new Set([
  // Set by JS on the element before use; the 50% fallbacks are the resting state.
  '--ripple-x',
  '--ripple-y',
  // Injected as an inline style by BrandLogo (src/components/ui/BrandLogo.jsx)
  // so responsive rules can still override it; the 40px fallbacks are the rest.
  '--brand-logo-size',
  // Written to <html> by useKeyboardInset (src/hooks/useKeyboardInset.js) while
  // SupportChatPage is mounted: the height of the on-screen keyboard, which
  // `dvh` does not report under this app's `interactive-widget=resizes-visual`
  // viewport. The 0px fallbacks are the no-keyboard resting state, and it is a
  // length rather than a colour, so no theme can be got wrong by it.
  '--keyboard-inset',
]);

/**
 * Strip comments before scanning. `tokens.css` documents the
 * `rgba(var(--x-rgb), alpha)` convention in prose, and a naive scan reads that
 * placeholder as a real reference.
 */
function stripComments(src, file) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (file.endsWith('.jsx') || file.endsWith('.js')) {
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  }
  return out;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (SCANNED_EXT.has(extname(full))) acc.push(full);
  }
  return acc;
}

const files = walk(SRC);

// ── 1. Collect every defined custom property ────────────────────────────────
// A definition is `--name:` appearing at the start of a declaration. Matching
// on `var(--name)` is deliberately excluded — that is a use, not a definition.
const defined = new Set(RUNTIME_DEFINED);
for (const file of files) {
  const src = stripComments(readFileSync(file, 'utf8'), file);
  for (const m of src.matchAll(/(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)) {
    defined.add(m[1]);
  }
}

// ── 2. Check every reference resolves ───────────────────────────────────────
const violations = [];
for (const file of files) {
  const src = stripComments(readFileSync(file, 'utf8'), file);
  for (const m of src.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    const name = m[1];
    if (defined.has(name)) continue;
    violations.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      name,
      // Show whether a fallback is masking it — that is what makes it silent.
      masked: /^var\(\s*--[A-Za-z0-9_-]+\s*,/.test(m[0] + src.slice(m.index + m[0].length, m.index + m[0].length + 2)),
    });
  }
}

if (violations.length > 0) {
  console.error('\ntoken-lint FAILED — undefined CSS custom properties referenced:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.name}`);
  }
  console.error(
    `\n${violations.length} reference(s) to properties that are never defined.\n` +
    'A var() fallback does not make this safe: a hardcoded fallback colour cannot\n' +
    'follow the theme, so it renders wrong in one of the two themes. Point the\n' +
    'reference at a real token in src/styles/tokens.css, or add the token there.\n' +
    'If the property is genuinely assigned at runtime, add it to RUNTIME_DEFINED\n' +
    'in scripts/token-lint.mjs with a comment saying what sets it.\n'
  );
  process.exit(1);
}

console.log(`token-lint passed (${defined.size} tokens defined, ${files.length} files scanned).`);
