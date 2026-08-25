import { useEffect, useState } from 'react';
import CustomSelect from './CustomSelect';

/**
 * The barangay table is loaded as its own chunk instead of being imported at
 * the top of this file.
 *
 * It is 5,976 names — 125 KB, 26 KB gzipped. RegisterPage is one of the four
 * eagerly-imported auth pages, so a static import puts the whole table into
 * the ENTRY bundle: +26 KB gzip on first paint, for data that is not read
 * until somebody has picked a city, on an app whose users are on phones on
 * intermittent connections.
 *
 * This is still a file in our own bundle, not a network API — no third-party
 * latency, and the service worker caches the chunk after first use the way it
 * caches every route chunk. The only cost is that the very first barangay
 * dropdown on a cold cache waits for a same-origin chunk, and that wait
 * overlaps with the customer choosing a province and a city.
 *
 * Module-scoped, so the fetch happens once per session however many of these
 * are mounted (booking renders two).
 */
let barangayModule = null;
let barangayPromise = null;
const loadBarangays = () => {
  barangayPromise ||= import('../../constants/phBarangays')
    .then((mod) => { barangayModule = mod; return mod; })
    // A failed chunk load must not take the form down with it: the lookup
    // then returns [] and the field degrades to the free-text input it was
    // before this feature existed.
    .catch(() => { barangayModule = { getBarangays: () => [] }; return barangayModule; });
  return barangayPromise;
};

/**
 * Barangay picker — a dropdown of the barangays that actually exist in the
 * chosen city, from the static PSGC list in `constants/phBarangays.js`.
 *
 * It emits a plain string through the same `{ target: { value } }` shape a
 * native <select> does, so callers keep saving a string into the existing text
 * columns (`profiles.address_barangay`, the address string built for
 * `orders`). Nothing about the schema changes.
 *
 * Two fallbacks, both load-bearing:
 *
 * 1. **No list for this city → a free-text input.** Booking allows an
 *    "Other Area" province with a hand-typed city, and that city is by
 *    definition not in our coverage data. A dropdown with nothing in it would
 *    make those bookings impossible to submit, so the field degrades to what
 *    it was before rather than to a dead control.
 *
 * 2. **A stored value the list does not contain → kept as an extra option.**
 *    Every barangay saved before this change was typed by hand, so plenty read
 *    "Poblacion" where PSGC says "Poblacion I", and PSGC itself renames
 *    barangays. CustomSelect falls back to its first option when the value
 *    matches nothing, which would silently show "Select Barangay" over a
 *    profile that has one — the customer's saved address, invisible. Carrying
 *    the old value as an option shows it, keeps it selected, and lets them
 *    replace it deliberately.
 */
const BarangaySelect = ({
  id,
  province,
  city,
  value = '',
  onChange,
  className = '',
  disabled = false,
  placeholder = 'Select Barangay',
  ...rest
}) => {
  // Re-render once the chunk lands. This state is only a trigger — the data
  // lives in the module-scoped cache, so a later mount reads it synchronously
  // and never flashes the fallback.
  const [loaded, setLoaded] = useState(() => !!barangayModule);
  useEffect(() => {
    if (barangayModule) return undefined;
    let alive = true;
    loadBarangays().then(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  // Show a disabled dropdown, not the free-text fallback, for the moment the
  // chunk is in flight with a city already chosen (a returning customer whose
  // profile autofills the form). Swapping an input for a select under the
  // cursor is worse than a control that is briefly not ready.
  if (!loaded && city) {
    return (
      <CustomSelect id={id} className={`form-select ${className}`.trim()} value="" disabled {...rest}>
        <option value="">Loading barangays…</option>
      </CustomSelect>
    );
  }

  const options = barangayModule?.getBarangays(province, city) || [];

  if (options.length === 0) {
    return (
      <input
        id={id}
        className={`form-input ${className}`.trim()}
        value={value}
        onChange={onChange}
        placeholder={city ? 'Barangay name' : 'Select a city first'}
        autoComplete="address-level3"
        autoCapitalize="words"
        disabled={disabled}
        {...rest}
      />
    );
  }

  const isKnown = !value || options.includes(value);

  return (
    <CustomSelect
      id={id}
      className={`form-select ${className}`.trim()}
      value={value}
      onChange={onChange}
      disabled={disabled || !city}
      {...rest}
    >
      <option value="">{city ? placeholder : 'Select a city first'}</option>
      {!isKnown && <option value={value}>{value} (as previously saved)</option>}
      {options.map(b => <option key={b} value={b}>{b}</option>)}
    </CustomSelect>
  );
};

export default BarangaySelect;
