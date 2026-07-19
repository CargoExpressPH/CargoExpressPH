/* -----------------------------------------------------------------------
   axe-lint.mjs — Static accessibility lint for JSX source.
   Runs as part of `npm test` alongside smoke-check.mjs.

   Philosophy:
   - Zero runtime dependencies (pure Node).
   - Must pass clean on the current codebase — no false positives.
   - Catches only unambiguous, high-impact regressions:
       • <img> without alt (alt="" allowed for decorative)
       • <button> / <a> without accessible name or aria-label
       • <input> without aria-label, title, or placeholder
       • empty aria-label="" / aria-labelledby=""
       • duplicate id attributes within a single file
   - For multi-line JSX, each element is collapsed to one line before
     matching, so attribute positions report the line where the tag opens.
   ----------------------------------------------------------------------- */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = 'src';
const JSX_EXT = new Set(['.jsx', '.js']);
const TAGS_WITH_LABEL = new Set(['button', 'a']);

const violations = [];

// Recursively collect .jsx/.js files under a directory.
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (JSX_EXT.has(extname(full))) acc.push(full);
  }
  return acc;
}

// Walk the source and produce a stream of tokens representing JSX elements.
// Each token is one of:
//   { kind: 'open',   tag, raw, startLine, selfClosing }
//   { kind: 'close',  tag, startLine }   // matches </Tag>
//   { kind: 'void',   tag, raw, startLine } // <br/>, <hr/> — self-closing void
//
// We do NOT attempt a full JSX parse. We find "<Tag...>" or "</Tag...>" by
// scanning to the first '>' that is not inside a quoted string or {...}.
function extractElements(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source[i] === '<') {
      const next = source[i + 1] || '';
      // Closing tag: </Tag ...>
      if (next === '/' && /[A-Za-z]/.test(source[i + 2] || '')) {
        const startLine = source.slice(0, i).split('\n').length;
        const m = source.slice(i + 2).match(/^([A-Za-z][\w.-]*)/);
        if (m) {
          // advance past the closing tag's '>'
          let j = source.indexOf('>', i);
          if (j === -1) break;
          tokens.push({ kind: 'close', tag: m[1], startLine });
          i = j + 1;
          continue;
        }
        i++;
        continue;
      }
      // Opening tag: <Tag ...>
      if (/[A-Za-z]/.test(next)) {
        const startLine = source.slice(0, i).split('\n').length;
        const m = source.slice(i + 1).match(/^([A-Za-z][\w.-]*)/);
        // Find end of opening tag: first '>' not inside quotes or braces.
        let j = i + 1;
        let quote = null;
        let braceDepth = 0;
        while (j < n) {
          const ch = source[j];
          if (quote) {
            if (ch === quote) quote = null;
          } else if (ch === '"' || ch === "'") {
            quote = ch;
          } else if (ch === '{') {
            braceDepth++;
          } else if (ch === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
          } else if (ch === '>' && braceDepth === 0) {
            break;
          }
          j++;
        }
        if (j < n && m) {
          const raw = source.slice(i, j + 1);
          // Self-closing if the char immediately before '>' is '/'.
          const selfClosing = raw.trimEnd().endsWith('/');
          tokens.push({ kind: 'open', tag: m[1], raw, startLine, selfClosing });
        }
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return tokens;
}

// Extract attribute value for a given attr name from a collapsed tag string.
// Handles: name="val", name='val', name={expr}, name (boolean)
//
// The trailing `(?=\\s|\\=|\\/|\\>|$)` lookahead ensures the attribute name
// is complete — it prevents "aria-label" from matching inside "aria-labelledby".
function getAttr(tagStr, attrName) {
  const re = new RegExp(`${attrName}(?=\\s|\\=|\\/|\\>|$)(?:\\s*=\\s*("([^"]*)"|'([^']*)'|\\{([^}]*)\\}))?`);
  const m = tagStr.match(re);
  if (!m) return undefined;          // attribute absent
  if (m[1] === undefined) return ''; // boolean attribute present, value ''
  return m[2] ?? m[3] ?? m[4] ?? '';  // quoted or braced value
}

function hasAttr(tagStr, attrName) {
  return new RegExp(`${attrName}(?=\\s|\\=|\\/|\\>|$)`).test(tagStr);
}

function isHidden(tagStr) {
  if (hasAttr(tagStr, 'aria-hidden') || getAttr(tagStr, 'aria-hidden') === 'true') return true;
  if (hasAttr(tagStr, 'hidden')) return true;
  // Inline style hiding the element: style={{ display: 'none' }} or visibility: 'hidden'.
  // Matches the common JSX pattern for hidden file inputs behind custom buttons.
  const styleVal = getAttr(tagStr, 'style') || '';
  if (styleVal.includes('display') && styleVal.includes('none') && /display['"]?\s*:\s*['"]?none/.test(styleVal)) return true;
  if (styleVal.includes('visibility') && /visibility['"]?\s*:\s*['"]?hidden/.test(styleVal)) return true;
  return false;
}

function checkFile(file) {
  const source = readFileSync(file, 'utf8');
  const tokens = extractElements(source);

  // Track depth of open <label> elements so we can recognize the accessible
  // "label-wrapping-input" pattern (<label><input/>Text</label>), which is
  // valid even without htmlFor/id linkage.
  let labelDepth = 0;

  for (const tok of tokens) {
    if (tok.kind === 'close') {
      if (tok.tag === 'label' && labelDepth > 0) labelDepth--;
      continue;
    }
    // tok.kind === 'open'
    const { tag, raw, startLine, selfClosing } = tok;
    const collapsed = raw.replace(/\s+/g, ' ');

    // Skip elements explicitly hidden from AT
    if (isHidden(collapsed)) {
      if (tag === 'label' && !selfClosing) labelDepth++;
      continue;
    }

    // 1. <img> must have alt (decorative alt="" is allowed)
    if (tag === 'img') {
      if (!hasAttr(collapsed, 'alt')) {
        violations.push({
          file, line: startLine, tag,
          rule: 'img-alt',
          msg: '<img> is missing an alt attribute. Add alt="..." or alt="" if decorative.',
        });
      }
    }

    // 2. <button> and <a> must have an accessible name. We only flag
    //    self-closing/empty variants to avoid false positives on elements
    //    whose visible text appears as children.
    if (TAGS_WITH_LABEL.has(tag) && selfClosing) {
      const hasLabelAttr =
        hasAttr(collapsed, 'aria-label') ||
        hasAttr(collapsed, 'aria-labelledby') ||
        hasAttr(collapsed, 'title');
      if (!hasLabelAttr) {
        violations.push({
          file, line: startLine, tag,
          rule: `${tag}-label`,
          msg: `Self-closing <${tag} /> has no accessible name. Add aria-label, aria-labelledby, or title.`,
        });
      }
    }

    // 3. <input> (non-hidden type) needs an accessible name. Valid sources:
    //      - aria-label / aria-labelledby / title / placeholder
    //      - id (assumed linked to a sibling <label htmlFor=>)
    //      - being wrapped inside an open <label>...</label>
    if (tag === 'input') {
      const type = (getAttr(collapsed, 'type') || 'text').toLowerCase();
      if (type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'image' && type !== 'reset') {
        const hasName =
          hasAttr(collapsed, 'aria-label') ||
          hasAttr(collapsed, 'aria-labelledby') ||
          hasAttr(collapsed, 'title') ||
          hasAttr(collapsed, 'placeholder') ||
          hasAttr(collapsed, 'id') ||
          labelDepth > 0; // wrapped in <label>
        if (!hasName) {
          violations.push({
            file, line: startLine, tag,
            rule: 'input-label',
            msg: `<input type="${type}"> has no accessible name. Add aria-label, link a <label>, or wrap it in <label>...</label>.`,
          });
        }
      }
    }

    // 4. Empty aria-label="" or aria-labelledby="" is always wrong
    const ariaLabel = getAttr(collapsed, 'aria-label');
    if (ariaLabel !== undefined && ariaLabel.trim() === '') {
      violations.push({
        file, line: startLine, tag,
        rule: 'aria-label-empty',
        msg: 'Empty aria-label="". Remove it or provide a value.',
      });
    }
    const ariaLabelledby = getAttr(collapsed, 'aria-labelledby');
    if (ariaLabelledby !== undefined && ariaLabelledby.trim() === '') {
      violations.push({
        file, line: startLine, tag,
        rule: 'aria-labelledby-empty',
        msg: 'Empty aria-labelledby="". Remove it or provide an id reference.',
      });
    }

    // Track <label> depth (non-self-closing labels only)
    if (tag === 'label' && !selfClosing) labelDepth++;
  }

  // 5. Duplicate id attributes within a single file
  const idMatches = source.matchAll(/\bid\s*=\s*{"([^"]+)"\}|\bid\s*=\s*"([^"]+)"/g);
  const seenIds = new Map(); // id -> firstLine
  const idLineMap = buildLineIndex(source);
  for (const m of idMatches) {
    const id = m[1] ?? m[2];
    if (!id) continue;
    const line = lineAt(idLineMap, m.index);
    if (seenIds.has(id)) {
      violations.push({
        file, line, tag: '(id)',
        rule: 'duplicate-id',
        msg: `Duplicate id="${id}". First seen at line ${seenIds.get(id)}.`,
      });
    } else {
      seenIds.set(id, line);
    }
  }
}

// Build an index of byte offsets at the start of each line, for line lookup.
function buildLineIndex(s) {
  const idx = [0];
  for (let k = 0; k < s.length; k++) if (s[k] === '\n') idx.push(k + 1);
  return idx;
}
function lineAt(lineIndex, offset) {
  // binary search for largest lineStart <= offset
  let lo = 0, hi = lineIndex.length - 1, ans = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineIndex[mid] <= offset) { ans = mid + 1; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// ── Run ─────────────────────────────────────────────────────────────────
const files = walk(ROOT);
for (const f of files) {
  try { checkFile(f); }
  catch (err) {
    // Never crash the whole test run on a single unreadable file; report it.
    violations.push({ file: f, line: 0, tag: '(parse)', rule: 'parse-error', msg: err.message });
  }
}

if (violations.length > 0) {
  console.error(`\n❌ axe-lint found ${violations.length} accessibility issue(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.msg}`);
  }
  console.error(`\naxe-lint failed.`);
  process.exit(1);
}

console.log(`axe-lint passed (${files.length} files scanned).`);
