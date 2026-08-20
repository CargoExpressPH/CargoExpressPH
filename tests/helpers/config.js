import dotenv from 'dotenv';

// .env supplies the Supabase/Vite settings; .env.test supplies the test
// credentials and wins where both define a key.
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.test', override: true });

// Allow Node.js db client to connect even in environments with local TLS interception
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * Test configuration and per-run identities.
 *
 * The ADMIN account must already exist. It cannot be created by the suite:
 * `guard_profile_write` forces every self-registered profile to
 * role='customer', so an admin can only be minted with SQL or a service-role
 * key — neither of which belongs in a browser test. Put the credentials in
 * .env.test (gitignored) or export them in the shell.
 */
const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.test.example to .env.test and fill in the ` +
      `admin credentials, or export ${name} before running the suite.`
    );
  }
  return value;
};

export const ADMIN = {
  get email() { return required('E2E_ADMIN_EMAIL'); },
  get password() { return required('E2E_ADMIN_PASSWORD'); },
};

/**
 * A unique-per-run stamp. Every artifact the suite creates carries it, so a
 * failed run leaves data you can identify and clean up, and two runs never
 * collide on the UNIQUE constraints (profiles.email in particular).
 */
export const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The customer is registered fresh each run rather than reused. Re-using one
 * account would mean the second run books against a profile that already has
 * orders, and the dashboard assertions could no longer attribute a figure to
 * the order this run created.
 *
 * The domain is deliberately a .test TLD — reserved by RFC 2606, so it can
 * never route to a real inbox even if a confirmation email is ever enabled.
 */
export const CUSTOMER = {
  name: 'Test Customer',
  email: `e2e.customer.${RUN_ID}@cargoexpressph-e2e.test`,
  password: 'E2eCustomer!2026',
  phone: '09171234567',
  facebook: `E2E Customer ${RUN_ID}`,
  address: {
    province: 'Metro Manila',
    city: 'Makati',
    barangay: 'Poblacion',
    street: 'Kalayaan Avenue',
    lotBlock: 'Lot 4 Block 9',
    landmark: 'Near the barangay hall',
  },
};

/**
 * Booking figures. Chosen so every downstream assertion is exact:
 *   10 kg x PHP 75/kg = PHP 750.00 shipping cost
 *   PHP 500.00 collected in CASH at pickup
 *   PHP 250.00 outstanding  → 'partial', appears on the Unsettled tab
 *
 * PRICE_PER_KG is written onto the trip the suite creates, so it does not
 * depend on whatever company_information.default_price_per_kg happens to be.
 */
export const BOOKING = {
  route: 'Manila → Bohol',
  pricePerKg: 75,
  capacityKg: 1000,
  actualWeightKg: 10,
  get shippingCost() { return this.actualWeightKg * this.pricePerKg; }, // 750
  partialPayment: 500,
  get outstanding() { return this.shippingCost - this.partialPayment; }, // 250
  packageDescription: 'E2E test parcel — two boxes of documents',
  receiver: {
    name: 'Test Receiver',
    phone: '09189876543',
    facebook: `E2E Receiver ${RUN_ID}`,
    province: 'Bohol',
    city: 'Tagbilaran City',
    barangay: 'Cogon',
    street: 'CPG Avenue',
    lotBlock: 'Lot 12',
    landmark: 'Across the plaza',
  },
};

const TRIP_DAY_OFFSET = 14 + Math.floor(Math.random() * 180);

export const TRIP = {
  label: 'Manila → Bohol',
  notes: `E2E run ${RUN_ID}`,
  departureOffset: TRIP_DAY_OFFSET,
  arrivalOffset: TRIP_DAY_OFFSET + 2,
};

export const ANNOUNCEMENT = {
  title: `E2E Announcement ${RUN_ID}`,
  content: 'Automated end-to-end test announcement. Safe to delete.',
};

/** `YYYY-MM-DDTHH:mm` — the format a datetime-local input expects. */
export const datetimeLocal = (daysFromNow, hour = 8) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Parses "₱1,234.56" / "PHP 1,234.56" / "1234.56" into a Number. */
export const parsePeso = (text) => {
  if (text == null) return NaN;
  const cleaned = String(text).replace(/[^0-9.\-]/g, '');
  return cleaned === '' ? NaN : Number(cleaned);
};
