/**
 * ── Human-name policy ──────────────────────────────────────────────────────
 *
 * This is CargoExpress PH's CHOSEN policy for the fields that hold a person's
 * name. It is deliberately NOT a definition of what a valid human name is —
 * real names worldwide contain characters this rejects. It is a pragmatic
 * input rule for this application's forms, chosen so that the names actually
 * entered here (Filipino and Spanish-influenced Latin-script names) are
 * accepted while obvious junk, placeholders and injected data are not.
 *
 * ALLOWED
 *   - Unicode LETTERS from any script — ñ, á/é/í/ó/ú, ü, and equally Å, ł,
 *     Ω, 日 — plus combining marks, so a decomposed "José" (J-o-s-e + U+0301)
 *     is accepted exactly like the precomposed form.
 *   - Spaces between name parts.
 *   - Periods, for initials and suffixes: "J. Santos", "Jose Rizal Jr."
 *   - Hyphens and apostrophes (ASCII ' and the typographic U+2019 that iOS
 *     autocorrect produces), for "Maria Santos-Reyes" and "O'Brien".
 *
 * REJECTED
 *   - Digits: "Juan123".
 *   - Emoji and other symbols.
 *   - Any other punctuation: commas, backticks, underscores, @, #, /, etc.
 *     (The previous version of this validator allowed commas and backticks;
 *     they are not part of the chosen policy and are now refused.)
 *   - Anything with no letter at all: "...", "   ", "--", an emoji-only name.
 *
 * NORMALISATION
 *   Input is compared in Unicode NFC form so that the same name typed on a
 *   Mac (often NFD) and on Windows (NFC) validates identically. The caller's
 *   original string is never rewritten — this module only ever reports an
 *   error. Stored names are left exactly as the person typed them.
 *
 * MIRRORED SERVER-SIDE
 *   public.is_valid_person_name(TEXT), added in migration
 *   20260922160000_person_name_policy.sql, is the enforcement point. This
 *   file is the fast, friendly UI half of the same rule; a direct API call
 *   that skips it still hits the database check.
 */

/** Every character the policy permits. */
const PERSON_NAME_ALLOWED = /^[\p{L}\p{M} .'’-]+$/u;
/** At least one of them must be an actual letter. */
const PERSON_NAME_HAS_LETTER = /\p{L}/u;

export const PERSON_NAME_MIN_LENGTH = 2;
export const PERSON_NAME_MAX_LENGTH = 100;

/**
 * Validates one human-name field (a first name, a last name, or a single
 * full-name field). Returns an error string, or null when the value passes.
 *
 * Surrounding whitespace is ignored for every check, so " Juan " is the same
 * input as "Juan" — but, again, nothing here modifies the caller's value.
 */
export const validateName = (name) => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return 'Required field.';

  // NFC before testing: on macOS an accented vowel typed with a dead key
  // arrives decomposed, and comparing the decomposed form against the same
  // rule must give the same answer.
  const normalized = trimmed.normalize('NFC');

  if (!PERSON_NAME_ALLOWED.test(normalized) || !PERSON_NAME_HAS_LETTER.test(normalized)) {
    return "Please enter a valid name (letters, spaces, periods, hyphens and apostrophes only).";
  }

  if (trimmed.length < PERSON_NAME_MIN_LENGTH) return 'Name must be at least 2 characters long.';
  if (trimmed.length > PERSON_NAME_MAX_LENGTH) return 'Name is too long.';

  return null;
};

export const validateAddressLine = (line) => {
  if (!line || !line.trim()) return 'Required field.';

  // Address should contain at least one letter or number
  const hasAlphanumeric = /[A-Za-z0-9]/.test(line);
  if (!hasAlphanumeric) {
    return 'Must contain valid words or numbers.';
  }

  return null;
};

export const validateFacebookName = (name) => {
  if (!name || !name.trim()) return 'Required field.';

  const hasAlphanumeric = /[A-Za-z0-9]/.test(name);
  if (!hasAlphanumeric) {
    return 'Please enter a valid Facebook name or link.';
  }

  return null;
};
