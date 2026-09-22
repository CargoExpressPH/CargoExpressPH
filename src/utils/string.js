/**
 * Title-case a name as it is being TYPED.
 *
 * Deliberately gentle, because this runs on every keystroke: it does not trim
 * and does not collapse spaces, or the space someone just typed between their
 * first and last name would vanish under the cursor. Use `normalizeName` for
 * the value that gets saved.
 *
 * Word boundaries include hyphens and apostrophes, so "anne-marie" becomes
 * "Anne-Marie" and "o'brien" becomes "O'Brien" — both ordinary in the names
 * this app handles.
 *
 * A word is lower-cased before capitalising ONLY when it is entirely
 * upper-case. That fixes the caps-lock case ("BEA SARONG" → "Bea Sarong")
 * without flattening the intercaps people write deliberately: "McDonald" and
 * "dela Cruz-MacArthur" keep their shape, where a blunt
 * `toLowerCase()` first would hand back "Mcdonald".
 *
 * Non-strings return '' rather than throwing — the previous implementation
 * called .replace() on whatever it was given.
 */
export const toTitleCase = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\s\-']+/g, (word) => {
    const body = word === word.toUpperCase() ? word.toLowerCase() : word;
    return body.charAt(0).toUpperCase() + body.slice(1);
  });
};

/**
 * The value to SAVE: title-cased, trimmed, and with runs of whitespace
 * collapsed to single spaces.
 *
 * This is the guarantee the database gets, and it is separate from
 * `toTitleCase` on purpose. The on-input transform cannot trim without
 * fighting the person typing, so "bea  sarong " reaches submit with its extra
 * spaces intact; this is where they come off. It also covers the paths a
 * keystroke handler never sees — a pasted value, an autofilled one, or a draft
 * restored from storage.
 */
export const normalizeName = (value) =>
  toTitleCase(String(value ?? '').replace(/\s+/g, ' ').trim());

/**
 * Splits a single "full name" value (e.g. `profiles.name`, which is not
 * itself split into first/last) into { firstName, lastName } for a form that
 * has separate First/Last Name fields but only a combined name to seed them
 * from — the "use my registered address" autofill in BookShipmentPage, for
 * one. Splits on the FIRST space: "Juan Dela Cruz" -> "Juan" / "Dela Cruz".
 * A single word (no space) becomes firstName only, lastName '' — mirrors the
 * exact same rule the sender_name/receiver_name -> first/last DB backfill
 * uses (20260922100000_split_sender_receiver_names.sql), so a value that
 * round-trips through both paths splits identically either way.
 */
export const splitFullName = (value) => {
  const trimmed = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1) };
};

/**
 * Title-case an address line as it is being TYPED — Street/Subdivision,
 * Lot/Block/Purok, Landmark.
 *
 * Unlike `toTitleCase`, this never lowercases anything: it only forces the
 * first letter of each word to upper-case and leaves the rest of the word
 * exactly as typed. Addresses legitimately carry acronyms and deliberate
 * caps — "STI School", "SM City", "NA" — and the caps-lock flattening
 * `toTitleCase` does for names ("STI" → "Sti") would destroy those here.
 *
 * Word boundaries match `toTitleCase` (hyphens and apostrophes don't split
 * a word), and it is gentle the same way: no trimming, no space collapsing,
 * so it's safe to run on every keystroke.
 */
export const toAddressCase = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\s\-']+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
};
