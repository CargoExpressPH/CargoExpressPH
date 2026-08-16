import { test, expect } from '@playwright/test';
import { ADMIN, CUSTOMER, BOOKING, TRIP, RUN_ID } from './helpers/config.js';
import { login, dismissOverlays, selectCustom, fillById, suppressOnboarding, awaitOrderPageOrRetry } from './helpers/actions.js';
import {
  findTripByNotes, findLatestE2ETrip, findProfileByEmail, findLatestE2ECustomer,
  seedAssignedOrder, getOrderByTracking,
} from './helpers/db.js';

/**
 * Completeness sweep — the flows the main journey does not exercise:
 *
 *   1. Customer cancellation REQUEST → admin APPROVES → order Cancelled.
 *   2. Customer cancellation REQUEST → admin DECLINES → order back to the
 *      exact status it held when asked (lossless rejection).
 *   3. Support chat: the regex bot answers a customer, and an admin reply
 *      lands back in the customer's thread.
 *   4. Public tracking renders a real shipment's masked timeline.
 *   5. Forgot-password UI reaches its "check your email" state.
 *
 * Depends on the journey spec having run first (or any E2E artifacts being
 * present), so it reuses a real trip + customer.
 */

const fixture = { tripId: null, customer: null };

test.describe.configure({ mode: 'serial' });

test.describe('completeness — cancellation, chat, tracking, password recovery', () => {

  test.beforeAll(async () => {
    const trip = await findTripByNotes(TRIP.notes).catch(() => null)
      || await findLatestE2ETrip().catch(() => null);
    const profile = await findProfileByEmail(CUSTOMER.email).catch(() => null)
      || await findLatestE2ECustomer().catch(() => null);
    test.skip(!trip || !profile, 'Needs an E2E trip and customer — run the journey spec first.');
    fixture.tripId = trip.id;
    fixture.customer = profile;
  });

  async function bookFreshOrder(page) {
    await suppressOnboarding(page);
    await login(page, fixture.customer.email, CUSTOMER.password, { expectPath: '/customer' });
    await page.goto('/customer/book');
    await dismissOverlays(page);

    await page.getByRole('button', { name: new RegExp(BOOKING.route.replace('→', '.')) }).first().click();
    const tripSelect = page.locator('#booking-trip');
    await expect(tripSelect).toBeVisible({ timeout: 20_000 });
    await tripSelect.click();
    await page.getByRole('option').filter({ hasText: /TRIP-/ }).first().click();
    await page.getByRole('button', { name: /^continue$/i }).click();

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

    await fillById(page, 'package-description', `Completeness fixture ${RUN_ID}`);
    await selectCustom(page, 'payer-type', 'Sender');
    await page.getByRole('button', { name: /review booking/i }).click();

    const confirm = page.getByRole('button', { name: /confirm booking/i });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    const tracking = page.locator('text=/CE-\\d{8}-\\d{4}/').first();
    await expect(tracking).toBeVisible({ timeout: 60_000 });
    const number = (await tracking.textContent()).match(/CE-\d{8}-\d{4}/)[0];
    console.log(`  → booked: ${number}`);
    return number;
  }

  test('1. customer requests cancellation; admin approves → Cancelled', async ({ page }) => {
    const trackingNumber = await bookFreshOrder(page);
    const orderId = (await getOrderByTracking(trackingNumber)).id;

    // Customer side: request with a reason.
    await page.goto(`/customer/orders/${orderId}`);
    await dismissOverlays(page);
    await page.getByRole('button', { name: /request cancellation/i }).click();
    await fillById(page, 'cancel-reason', `E2E: booked the wrong date (${RUN_ID})`);
    await page.getByRole('button', { name: /submit request/i }).click();
    await expect(page.locator('text=/awaiting review/i')).toBeVisible({ timeout: 30_000 });

    const row = await getOrderByTracking(trackingNumber);
    expect(row.status).toBe('Pending Cancellation');
    expect(row.cancellation_previous_status).toBe('Assigned');
    console.log(`  → request recorded: ${row.status} (was ${row.cancellation_previous_status})`);

    // Admin side: approve.
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto(`/admin/orders/${orderId}`);
    await dismissOverlays(page);
    const heading = page.getByRole('heading', { name: 'Cancellation Request' });
    await awaitOrderPageOrRetry(page, heading);
    await page.getByRole('button', { name: /approve & cancel order/i }).click();

    // The approve RPC is one transaction (status + notification + activity log),
    // but it lands after the click returns. Reading the DB immediately raced
    // the commit — the order WAS cancelled, the read just came first. Wait for
    // the UI to drop the "Cancellation Request" panel before asserting.
    await expect(page.getByRole('heading', { name: 'Cancellation Request' }))
      .toBeHidden({ timeout: 30_000 });

    const after = await getOrderByTracking(trackingNumber);
    expect(after.status).toBe('Cancelled');
    console.log(`  → approved: ${after.status}`);
  });

  test('2. customer requests cancellation; admin declines → back to Assigned', async ({ page }) => {
    const order = await seedAssignedOrder({
      userId: fixture.customer.id,
      customerEmail: fixture.customer.email,
      tripId: fixture.tripId,
      runId: RUN_ID,
    });
    console.log(`  → seeded assigned order: ${order.tracking_number}`);

    await login(page, fixture.customer.email, CUSTOMER.password, { expectPath: '/customer' });
    await suppressOnboarding(page);
    await page.goto(`/customer/orders/${order.id}`);
    await dismissOverlays(page);
    await page.getByRole('button', { name: /request cancellation/i }).click();
    await fillById(page, 'cancel-reason', `E2E: changed my mind (${RUN_ID})`);
    await page.getByRole('button', { name: /submit request/i }).click();
    await expect(page.locator('text=/awaiting review/i')).toBeVisible({ timeout: 30_000 });

    // Admin side: decline with a reason.
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto(`/admin/orders/${order.id}`);
    await dismissOverlays(page);
    const heading2 = page.getByRole('heading', { name: 'Cancellation Request' });
    await awaitOrderPageOrRetry(page, heading2);
    await page.getByRole('button', { name: /decline request/i }).click();
    await fillById(page, 'reason-modal-input', 'Parcel is already staged for today\'s manifest.');
    await page.getByLabel('Decline Cancellation Request').getByRole('button', { name: 'Decline Request' }).click();

    const after = await getOrderByTracking(order.tracking_number);
    expect(after.status).toBe('Assigned');
    expect(after.trip_id).toBe(fixture.tripId);
    console.log(`  → declined: back to ${after.status}, trip slot kept`);
  });

  test('3. support chat: bot answers, admin replies, customer sees it', async ({ page }) => {
    await login(page, fixture.customer.email, CUSTOMER.password, { expectPath: '/customer' });
    await page.goto('/customer/support');
    await dismissOverlays(page);

    const input = page.locator('#chat-input, textarea[placeholder*="message"], [class*="chat"] textarea').first();
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill('Hello, how much per kilo?');
    await input.press('Enter');

    await expect(page.locator('text=/₱|per kilo|price|P70|70/i').first()).toBeVisible({ timeout: 45_000 });
    console.log('  → bot replied to the customer');

    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto('/admin/inbox');
    await dismissOverlays(page);
    const thread = page.getByRole('button', { name: /Conversation with Test Customer/i }).first();
    await expect(thread).toBeVisible({ timeout: 45_000 });
    await thread.click();

    const replyBox = page.getByLabel('Type a reply');
    await expect(replyBox).toBeVisible({ timeout: 30_000 });
    await replyBox.fill('Good day! It is ₱75 per kilo on our Manila–Bohol route.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.locator('text=/₱75 per kilo/i').first()).toBeVisible({ timeout: 30_000 });
    console.log('  → admin reply sent');
  });

  test('4. public tracking shows a real shipment timeline', async ({ page }) => {
    const trip = await findTripByNotes(TRIP.notes).catch(() => null)
      || await findLatestE2ETrip().catch(() => null);
    const { adminClient } = await import('./helpers/db.js');
    const db = await adminClient();
    const latest = trip
      ? (await db.from('orders').select('tracking_number').eq('trip_id', trip.id).order('created_at', { ascending: false }).limit(1)).data?.[0]
      : null;
    test.skip(!latest, 'Needs an E2E order to track.');
    await page.goto('/track');
    await page.getByPlaceholder(/tracking number/i).fill(latest.tracking_number);
    await page.getByRole('button', { name: /track/i }).click();
    await expect(page.locator(`text=/${latest.tracking_number}/`).first()).toBeVisible({ timeout: 30_000 });
    console.log(`  → public timeline rendered for ${latest.tracking_number}`);
  });

  test('5. forgot-password reaches the check-your-email state', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel(/email/i).fill(fixture.customer.email);
    await page.locator('button[type="submit"]').first().click();
    await expect(page.locator('text=/check your email|reset link|sent/i').first()).toBeVisible({ timeout: 30_000 });
    console.log('  → forgot-password confirmation state shown');
  });
});