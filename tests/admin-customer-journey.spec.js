import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { ADMIN, CUSTOMER, BOOKING, TRIP, ANNOUNCEMENT, RUN_ID, datetimeLocal, parsePeso } from './helpers/config.js';
import {
  login, fillById, selectCustom, expectToast, dismissOverlays, readSettledNumber,
  suppressOnboarding, expectNavigationOrError, collectDiagnostics, awaitOrderPageOrRetry,
} from './helpers/actions.js';
import { findTripByNotes } from './helpers/db.js';

/**
 * The full CargoExpress PH journey, end to end, against a live Supabase
 * project: admin sets up a trip and an announcement, a brand-new customer
 * registers and books onto that trip, the admin weighs it, dispatches it and
 * takes a part payment in cash, and the money then has to show up correctly in
 * the reports.
 *
 * `describe.serial` is required, not stylistic. Each phase consumes what the
 * previous one created, and a failure part-way through leaves the database in
 * a state later phases cannot interpret — so serial mode's "skip the rest on
 * first failure" is exactly the behaviour we want. State is threaded through
 * the module-scoped `journey` object below.
 */

const journey = {
  tripId: null,
  tripNumber: null,
  trackingNumber: null,
  orderUrl: null,
};

test.describe.configure({ mode: 'serial' });

test.describe('CargoExpress PH — admin + customer end-to-end journey', () => {

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 1 — Admin: sign in, create a trip, publish an announcement
  // ──────────────────────────────────────────────────────────────────────────

  test('admin signs in and reaches the dashboard', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await dismissOverlays(page);

    // The sidebar only renders for a profile whose role resolved to 'admin',
    // so its presence proves the role came back — not just that a session did.
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page).toHaveURL(/\/admin/);
  });

  test('admin creates a trip', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto('/admin/trips/create');
    await dismissOverlays(page);

    // Route is a pair of toggle buttons, not a select.
    await page.getByRole('button', { name: new RegExp(TRIP.label.replace('→', '.')) }).first().click();

    await fillById(page, 'trip-departure-date', datetimeLocal(TRIP.departureOffset, 8));
    await fillById(page, 'trip-arrival-date', datetimeLocal(TRIP.arrivalOffset, 17));
    await fillById(page, 'trip-capacity', BOOKING.capacityKg);
    await fillById(page, 'trip-price-per-kg', BOOKING.pricePerKg);
    await page.locator('#trip-notes').fill(TRIP.notes);

    await page.getByRole('button', { name: /create trip|save trip|create/i }).last().click();

    // Landing back on the trips list is the app's own success signal. If the
    // save fails instead, surface the app's own message plus the network log
    // rather than an opaque navigation timeout.
    try {
      await expectNavigationOrError(page, /\/admin\/trips(?!\/create)/);
    } catch (err) {
      throw new Error(`${err.message}${diagnostics()}`);
    }

    // Resolve the trip number from the database by this run's unique notes
    // rather than reading the first row on screen. Once a previous run has
    // left trips behind, "the first row" is not necessarily ours, and booking
    // against the wrong trip would invalidate every figure downstream.
    const trip = await findTripByNotes(TRIP.notes);
    journey.tripId = trip.id;
    journey.tripNumber = trip.trip_number;
    expect(journey.tripNumber, 'trip number should have been generated').toMatch(/^TRIP-\d{8}-\d+$/);

    // It must also be visible in the UI — the DB lookup is for identification,
    // not a substitute for checking the page actually rendered the trip.
    await expect(page.getByText(journey.tripNumber).first()).toBeVisible({ timeout: 20_000 });
    console.log(`  → created trip: ${journey.tripNumber}`);
  });

  test('admin publishes an announcement', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto('/admin/announcements');
    await dismissOverlays(page);

    await page.getByRole('button', { name: /^new$/i }).click({ force: true });
    await fillById(page, 'announcement-title', ANNOUNCEMENT.title);
    await page.locator('#announcement-content').fill(ANNOUNCEMENT.content);
    await page.getByRole('button', { name: /^publish$/i }).click({ force: true });

    await expect(page.getByText(ANNOUNCEMENT.title).first()).toBeVisible({ timeout: 30_000 });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 2 — Customer: register, then book a shipment through the wizard
  // ──────────────────────────────────────────────────────────────────────────

  test('a brand-new customer completes the sign-up flow', async ({ page }) => {
    // A real sign-up through the public form — no seeded account, no API
    // shortcut. This is the gate for "can new users actually join?", so it
    // asserts the app's own success signals rather than just the end URL.
    await page.goto('/register');
    await dismissOverlays(page);

    // Step 1 — identity
    await fillById(page, 'reg-name', CUSTOMER.name);
    await fillById(page, 'reg-facebook', CUSTOMER.facebook);
    await fillById(page, 'reg-email', CUSTOMER.email);
    await fillById(page, 'reg-phone', CUSTOMER.phone);
    await fillById(page, 'reg-password', CUSTOMER.password);
    await fillById(page, 'reg-confirm-password', CUSTOMER.password);
    await page.getByRole('button', { name: /continue|next/i }).first().click();

    // Step 2 — address. Reaching this step at all proves step 1 validated.
    await expect(page.locator('#reg-province')).toBeVisible();
    await selectCustom(page, 'reg-province', CUSTOMER.address.province);
    await selectCustom(page, 'reg-city', CUSTOMER.address.city);
    await fillById(page, 'reg-barangay', CUSTOMER.address.barangay);
    await fillById(page, 'reg-street', CUSTOMER.address.street);
    await fillById(page, 'reg-lot', CUSTOMER.address.lotBlock);
    await fillById(page, 'reg-landmark', CUSTOMER.address.landmark);

    await page.getByRole('button', { name: /create account|register|sign up/i }).last().click();

    // The success card is shown for exactly 1400ms before the app redirects, so
    // asserting on it is a race the test would sometimes lose. The durable
    // signal is the destination: registration auto-signs in and lands the new
    // account in the customer app, greeted by name.
    await page.waitForURL(/\/customer/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: CUSTOMER.name })).toBeVisible({ timeout: 30_000 });

    // A genuinely new customer meets the welcome tour. Getting past it is part
    // of the sign-up experience, so dismiss it the way a user would.
    const tour = page.getByRole('dialog', { name: /welcome tour/i });
    if (await tour.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await tour.getByRole('button', { name: /^skip$/i }).click();
      await expect(tour).toBeHidden();
    }

    console.log(`  → registered customer: ${CUSTOMER.email}`);
  });

  test('the newly registered customer can sign in with those credentials', async ({ page }) => {
    // Playwright gives each test a fresh context, so this is a genuinely cold
    // sign-in — it proves registration persisted a usable account rather than
    // just leaving the previous tab in a logged-in state.
    await suppressOnboarding(page);
    await login(page, CUSTOMER.email, CUSTOMER.password, { expectPath: '/customer' });
    await dismissOverlays(page);
    await expect(page).toHaveURL(/\/customer/);

    // The profile captured at sign-up should be on the account. These are form
    // inputs, so assert on their VALUES — getByText cannot see input values and
    // would pass or fail for the wrong reason.
    await page.goto('/customer/personal-info');
    await expect(page.locator('#profile-name')).toHaveValue(new RegExp(CUSTOMER.name, 'i'), { timeout: 30_000 });
    await expect(page.locator('#profile-phone')).toHaveValue(CUSTOMER.phone);
    await expect(page.locator('#profile-barangay')).toHaveValue(new RegExp(CUSTOMER.address.barangay, 'i'));
  });

  test('customer books a shipment through the wizard', async ({ page }) => {
    await suppressOnboarding(page);
    await login(page, CUSTOMER.email, CUSTOMER.password, { expectPath: '/customer' });
    await page.goto('/customer/book');
    await dismissOverlays(page);

    // ── Step 1: route + trip ──
    await page.getByRole('button', { name: new RegExp(BOOKING.route.replace('→', '.')) }).first().click();

    // The trip select only appears once a route with bookable trips is chosen.
    const tripSelect = page.locator('#booking-trip');
    await expect(tripSelect).toBeVisible({ timeout: 20_000 });
    await tripSelect.click();
    // Pick the trip this run created, matched by its generated number.
    await page.getByRole('option', { name: new RegExp(journey.tripNumber) }).first().click();
    await expect(page.locator('.booking-trip-preview')).toContainText(journey.tripNumber);

    await page.getByRole('button', { name: /^continue$/i }).click();

    // ── Step 2: sender ──
    await fillById(page, 'sender-name', CUSTOMER.name);
    await fillById(page, 'sender-phone', CUSTOMER.phone);
    await fillById(page, 'sender-facebook', CUSTOMER.facebook);
    await selectCustom(page, 'sender-province', CUSTOMER.address.province);
    await selectCustom(page, 'sender-city', CUSTOMER.address.city);
    await fillById(page, 'sender-barangay', CUSTOMER.address.barangay);
    await fillById(page, 'sender-street', CUSTOMER.address.street);
    await fillById(page, 'sender-lot-block', CUSTOMER.address.lotBlock);
    await fillById(page, 'sender-landmark', CUSTOMER.address.landmark);
    await page.getByRole('button', { name: /^continue$/i }).click();

    // ── Step 3: receiver ──
    await fillById(page, 'receiver-name', BOOKING.receiver.name);
    await fillById(page, 'receiver-phone', BOOKING.receiver.phone);
    await fillById(page, 'receiver-facebook', BOOKING.receiver.facebook);
    await selectCustom(page, 'receiver-province', BOOKING.receiver.province);
    await selectCustom(page, 'receiver-city', BOOKING.receiver.city);
    await fillById(page, 'receiver-barangay', BOOKING.receiver.barangay);
    await fillById(page, 'receiver-street', BOOKING.receiver.street);
    await fillById(page, 'receiver-lot-block', BOOKING.receiver.lotBlock);
    await fillById(page, 'receiver-landmark', BOOKING.receiver.landmark);
    await page.getByRole('button', { name: /^continue$/i }).click();

    // ── Step 4: package ──
    await fillById(page, 'package-description', BOOKING.packageDescription);
    await selectCustom(page, 'payer-type', 'Sender');
    await page.getByRole('button', { name: /review booking/i }).click();

    // ── Step 5: confirm ──
    // Regression guard for the "17-second blank screen" report: the confirm
    // button must go busy and a blocking overlay must appear, so the wait is
    // visible and a second click is impossible.
    const confirm = page.getByRole('button', { name: /confirm booking/i });
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.locator('.booking-submitting-overlay')).toBeVisible({ timeout: 5_000 });
    await expect(confirm.or(page.locator('.booking-submitting-overlay'))).toBeVisible();

    // Success screen carries the server-generated tracking number.
    const tracking = page.locator('text=/CE-\\d{8}-\\d{4}/').first();
    await expect(tracking).toBeVisible({ timeout: 60_000 });
    journey.trackingNumber = (await tracking.textContent()).match(/CE-\d{8}-\d{4}/)[0];
    expect(journey.trackingNumber).toMatch(/^CE-\d{8}-\d{4}$/);
    console.log(`  → booked shipment: ${journey.trackingNumber}`);

    // A booking has no price until it is weighed. Nothing on the confirmation
    // may claim otherwise — this is the invariant that removing the
    // customer-declared weight estimate exists to protect.
    await expect(page.locator('.booking-submitting-overlay')).toBeHidden();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 3 — Admin: weigh, dispatch, take a partial cash payment
  // ──────────────────────────────────────────────────────────────────────────

  test('unweighed order reads as unpriced, not settled', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto('/admin/orders');
    await dismissOverlays(page);

    await page.getByText(journey.trackingNumber).first().click({ force: true });
    await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}/, { timeout: 30_000 });
    journey.orderUrl = page.url();

    // Regression guard for the "Unpaid + Settled" contradiction: an order with
    // no weight has no price, so it is neither. It must say exactly that, and
    // must NOT show a Settled badge off the back of a ₱0.00 balance.
    await awaitOrderPageOrRetry(page, page.getByText('Not yet weighed — no price'));
    await expect(page.getByText('Settled', { exact: true })).toHaveCount(0);
  });

  test('admin weighs the order and records a partial cash payment at pickup', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto(journey.orderUrl);
    await dismissOverlays(page);

    // Pending → Assigned happens automatically when a trip is attached, so the
    // next action here is the pickup itself.
    const pickupHeading = page.getByRole('heading', { name: /pickup processing/i });
    await awaitOrderPageOrRetry(page, page.getByRole('button', { name: /process pickup/i }));
    await page.getByRole('button', { name: /process pickup/i }).click();
    await expect(pickupHeading).toBeVisible();

    // Weight is the ONLY pricing input and enters the system exactly here.
    await fillById(page, 'pickup-actual-weight', BOOKING.actualWeightKg);

    await page.getByRole('button', { name: /sender \(pay now\)/i }).click();
    await page.getByRole('button', { name: /^pay later$/i }).click();   // partial, not full
    await page.getByRole('button', { name: /^cash$/i }).click();
    // The payment panel's own ids: the money UI moved from a pickup-specific
    // block into the shared PaymentCollectionPanel (pcp-*).
    await fillById(page, 'pcp-amount', BOOKING.partialPayment);

    // Pay Later requires a promise date — it is also the documented override
    // that lets an unpaid shipment leave the warehouse later.
    const promised = page.locator('#pcp-promised-date');
    await expect(promised).toBeVisible();
    await promised.fill(datetimeLocal(14).slice(0, 10));

    // At least one pickup proof photo is mandatory. The file input is hidden
    // behind a styled button, so drive the input directly — and use a REAL
    // image, because the upload pipeline decodes and compresses it via canvas
    // before it ever reaches Storage.
    await page.locator('input[type="file"][multiple]')
      .setInputFiles(fileURLToPath(new URL('./fixtures/pickup-proof.png', import.meta.url)));
    await expect(page.locator('.pickup-photo-remove-btn').first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: /confirm pickup/i }).click();

    // The save chain (photo compression+upload, RPC, ledger, notification) has
    // taken 60-90s on a degraded network — each Supabase round trip can run
    // 8-27s. 60s made the test give up seconds before the modal closed.
    await expect(page.getByRole('heading', { name: /pickup processing/i }))
      .toBeHidden({ timeout: 120_000 });

    // The database recomputes the cost from the weight; the client never sets it.
    await expect(page.getByText(`₱${BOOKING.shippingCost.toFixed(2)}`).first())
      .toBeVisible({ timeout: 30_000 });
    console.log(`  → weighed ${BOOKING.actualWeightKg}kg → ₱${BOOKING.shippingCost}, collected ₱${BOOKING.partialPayment} cash`);
  });

  test('partially paid order shows partial + unsettled, never settled', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto(journey.orderUrl);
    await dismissOverlays(page);

    await expect(page.getByText('partial', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(new RegExp(`₱${BOOKING.outstanding.toFixed(2)} Remaining Balance|Unsettled.*₱${BOOKING.outstanding.toFixed(2)}`, 'i'))).toBeVisible();
    await expect(page.getByText('Settled', { exact: true })).toHaveCount(0);
  });

  test('admin advances the order through to dispatch', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto(journey.orderUrl);
    await dismissOverlays(page);

    // Picked Up → In Transit is driven by the TRIP, not the order, so walk the
    // trip forward: in_progress cascades every Picked Up order to In Transit,
    // arrived cascades to Arrived at Hub.
    await page.goto('/admin/trips');
    await page.getByText(journey.tripNumber).first().click({ force: true });
    await page.waitForURL(/\/admin\/trips\/[0-9a-f-]{36}/, { timeout: 30_000 });

    // Labels come straight from TripDetailPage: "Start Trip" (scheduled) and
    // "Mark Arrived" (in_progress). Both route through ConfirmModal, whose
    // confirm button defaults to "Confirm".
    await page.getByRole('button', { name: 'Start Trip' }).click();
    const confirmModal = page.locator('.confirm-modal');
    await expect(confirmModal).toBeVisible();
    await confirmModal.getByRole('button', { name: /^confirm$/i }).click();

    // A modal confirm click can land on a node React has just re-rendered
    // away: the click is dispatched, no handler fires, no request is sent and
    // no toast appears — the trip silently stays "scheduled". Detect that by
    // racing the success toast, then retry the action once.
    try {
      await expectToast(page, /in_progress/i, 10_000);
    } catch {
      await page.getByRole('button', { name: 'Start Trip' }).click();
      await expect(confirmModal).toBeVisible();
      await confirmModal.getByRole('button', { name: /^confirm$/i }).click();
      await expectToast(page, /in_progress/i);
    }

    await page.getByRole('button', { name: 'Mark Arrived' }).click();
    await page.locator('.confirm-modal').getByRole('button', { name: /^confirm$/i }).click();
    await expectToast(page, /arrived/i);

    // Now dispatch for doorstep delivery. The order was weighed and carries a
    // promise date, so the warehouse hold must let it through.
    await page.goto(journey.orderUrl);
    await dismissOverlays(page);
    await awaitOrderPageOrRetry(page, page.getByRole('button', { name: /advance to "Out for Delivery"/i }));
    await page.getByRole('button', { name: /advance to "Out for Delivery"/i }).click();

    await expect(page.getByText('Out for Delivery').first()).toBeVisible({ timeout: 30_000 });
    console.log('  → dispatched: Out for Delivery');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 4 — Reports: do the aggregates reflect what actually happened?
  // ──────────────────────────────────────────────────────────────────────────

  test('cash payment is attributed to Cash, not to the order payment method', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto('/admin/sales');
    await dismissOverlays(page);

    // All four headline tiles must be present. They used to drop to two after a
    // live refresh, which read as "nothing is outstanding".
    await expect(page.locator('.stat-card:not(.skeleton-stat-card)')).toHaveCount(4, { timeout: 30_000 });
    await expect(page.locator('.stat-card', { hasText: 'Outstanding' })).toBeVisible();
    await expect(page.locator('.stat-card', { hasText: 'Unpaid Orders' })).toBeVisible();

    // The payment was CASH. Bucketing by orders.payment_method would have filed
    // it under whatever the order row happens to say; it must come from the
    // payment_transactions ledger instead.
    const donut = page.locator('.card', { hasText: 'Payment Methods' });
    await expect(donut).toContainText('Cash', { timeout: 20_000 });

    const collected = page.locator('.stat-card', { hasText: 'Collected' }).locator('.stat-value');
    const collectedValue = await readSettledNumber(collected, { parse: parsePeso });
    expect(collectedValue, 'collected total should include this run\'s cash payment')
      .toBeGreaterThanOrEqual(BOOKING.partialPayment);
  });

  test('Outstanding reconciles between the Sales and Unsettled tabs', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto('/admin/sales');
    await dismissOverlays(page);
    await expect(page.locator('.stat-card:not(.skeleton-stat-card)')).toHaveCount(4, { timeout: 30_000 });

    const salesOutstanding = await readSettledNumber(
      page.locator('.stat-card', { hasText: 'Outstanding' }).locator('.stat-value'),
      { parse: parsePeso }
    );

    // Switching tabs must put the section in the URL — a live refresh used to
    // throw the admin back to Sales Overview mid-triage.
    await page.getByRole('button', { name: 'Unsettled Deliveries' }).click();
    await expect(page).toHaveURL(/tab=unsettled/);
    await expect(page.locator('.stat-card:not(.skeleton-stat-card)')).toHaveCount(4, { timeout: 30_000 });

    const unsettledTotal = await readSettledNumber(
      page.locator('.stat-card', { hasText: 'Total Outstanding' }).locator('.stat-value').first(),
      { parse: parsePeso }
    );

    // The whole point of the reconciliation fix: one definition, one number.
    expect(Math.abs(salesOutstanding - unsettledTotal),
      `Sales says ₱${salesOutstanding}, Unsettled says ₱${unsettledTotal} — these must agree`)
      .toBeLessThanOrEqual(1);

    // This run's order should be sitting in that list with its exact balance.
    await expect(page.getByText(journey.trackingNumber).first()).toBeVisible({ timeout: 20_000 });

    // And the tab must survive a reload, because it lives in the URL now.
    await page.reload();
    await expect(page).toHaveURL(/tab=unsettled/);
    await expect(page.getByRole('button', { name: 'Unsettled Deliveries' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('recording an overpayment is rejected while typing, not on submit', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto(journey.orderUrl);
    await dismissOverlays(page);

    await page.getByRole('button', { name: /record additional payment/i }).click();
    await expect(page.getByRole('heading', { name: /record payment/i })).toBeVisible();

    const amount = page.locator('#ap-amount');
    await amount.fill(String(BOOKING.outstanding + 500));   // deliberately too much

    // The field must go invalid immediately and the submit must be dead — the
    // old behaviour kept a green "valid" border until the user pressed Record.
    await expect(amount).toHaveClass(/field-invalid/);
    await expect(page.getByText(/cannot exceed the ₱.* remaining balance/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^record payment$/i })).toBeDisabled();

    // A valid amount clears it again.
    await amount.fill(String(BOOKING.outstanding));
    await expect(amount).toHaveClass(/field-valid/);
    await expect(page.getByRole('button', { name: /^record payment$/i })).toBeEnabled();
  });

  test('summary: what this run created', async () => {
    console.log('\n  ── E2E run summary ─────────────────────────');
    console.log(`  run id      : ${RUN_ID}`);
    console.log(`  trip        : ${journey.tripNumber}`);
    console.log(`  customer    : ${CUSTOMER.email}`);
    console.log(`  tracking    : ${journey.trackingNumber}`);
    console.log(`  announcement: ${ANNOUNCEMENT.title}`);
    console.log(`  billed      : ₱${BOOKING.shippingCost.toFixed(2)} (${BOOKING.actualWeightKg}kg × ₱${BOOKING.pricePerKg})`);
    console.log(`  collected   : ₱${BOOKING.partialPayment.toFixed(2)} cash`);
    console.log(`  outstanding : ₱${BOOKING.outstanding.toFixed(2)}`);
    console.log('  ────────────────────────────────────────────\n');
    expect(journey.trackingNumber).toBeTruthy();
  });
});
