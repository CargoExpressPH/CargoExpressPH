import { test, expect } from '@playwright/test';
import { ADMIN, CUSTOMER, TRIP, RUN_ID } from './helpers/config.js';
import { login, dismissOverlays } from './helpers/actions.js';
import {
  findTripByNotes, findProfileByEmail, findLatestE2ETrip, findLatestE2ECustomer,
  seedUnweighedOrderAtHub, tryDispatch, getOrderByTracking, deleteOrder,
} from './helpers/db.js';

/**
 * Bug #3 — the dispatch gate must refuse an UNWEIGHED parcel.
 *
 * Why this needs a seeded row: an unweighed parcel has shipping_cost 0 and
 * remaining_balance 0, because weight is the only pricing input and it has not
 * been captured. The old gate asked `remaining_balance > 0`, read that ₱0.00 as
 * "nothing is owed", and dispatched cargo that had never been billed. The fix
 * asks "was it weighed?" first.
 *
 * Every UI route to 'Arrived at Hub' runs through pickup, and pickup refuses to
 * submit without a weight — so the application cannot produce the row this gate
 * exists to catch. The only honest way to test it is to construct that row
 * directly and then attempt the dispatch.
 *
 * The seed uses the ADMIN's own session and RLS policies, not a service-role
 * key: it does nothing an admin could not do through PostgREST anyway.
 *
 * Depends on migration 20260806030000. If that has not been applied, the first
 * test fails with the order moving to 'Out for Delivery' — which is the bug,
 * correctly reported.
 */

const fixture = { orderId: null, trackingNumber: null };

test.describe.configure({ mode: 'serial' });

test.describe('dispatch gate — unweighed cargo cannot be sent out for delivery', () => {

  test.beforeAll(async () => {
    // Prefer this run's own artifacts; fall back to the most recent E2E ones so
    // the spec can also be run on its own, not only as the tail of a full-suite
    // invocation (RUN_ID is per-process, so a standalone run has no trip of its
    // own to find).
    const trip = await findTripByNotes(TRIP.notes).catch(() => null)
      || await findLatestE2ETrip().catch(() => null);
    const profile = await findProfileByEmail(CUSTOMER.email).catch(() => null)
      || await findLatestE2ECustomer().catch(() => null);

    test.skip(!trip || !profile,
      'Needs an E2E trip and customer to attach the fixture to — run the journey spec first.');

    const order = await seedUnweighedOrderAtHub({
      userId: profile.id,
      customerEmail: profile.email,
      tripId: trip.id,
      runId: RUN_ID,
    });

    fixture.orderId = order.id;
    fixture.trackingNumber = order.tracking_number;
    console.log(`  → seeded unweighed order at hub: ${order.tracking_number}`);
  });

  test.afterAll(async () => {
    // This fixture is an invalid state by construction — do not leave it in the
    // database to confuse the reports or a later run.
    if (fixture.orderId) {
      await deleteOrder(fixture.orderId);
      console.log(`  → cleaned up fixture order ${fixture.trackingNumber}`);
    }
  });

  test('the seeded order really is unweighed and unpriced at the hub', async () => {
    const order = await getOrderByTracking(fixture.trackingNumber);

    expect(order.status).toBe('Arrived at Hub');
    expect(order.actual_weight, 'fixture must have no weight').toBeFalsy();
    expect(Number(order.shipping_cost || 0), 'unweighed means unpriced').toBe(0);
    // The trap: a ₱0.00 balance that means "never billed", not "fully paid".
    expect(Number(order.remaining_balance || 0)).toBe(0);
    expect(order.payment_status, 'derive_payment_status must not call this paid').not.toBe('paid');
  });

  test('the database refuses the dispatch', async () => {
    const { data, error } = await tryDispatch(fixture.orderId);

    expect(error, 'guard_order_update should have raised — an unweighed parcel must not dispatch').not.toBeNull();
    expect(error.message).toMatch(/not been weighed|no price yet/i);
    expect(data ?? []).toHaveLength(0);

    // And the row must be untouched.
    const after = await getOrderByTracking(fixture.trackingNumber);
    expect(after.status).toBe('Arrived at Hub');
  });

  test('the admin UI surfaces the refusal instead of appearing to succeed', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password, { expectPath: '/admin' });
    await page.goto(`/admin/orders`);
    await dismissOverlays(page);

    await page.getByText(fixture.trackingNumber).first().click();
    await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}/, { timeout: 30_000 });

    // The badge must say unpriced, not settled — the same ₱0.00 that fooled the
    // gate also used to render "Unpaid" beside "Settled".
    await expect(page.getByText('Not yet weighed — no price')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Settled', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /advance to "Out for Delivery"/i }).click();

    // The admin must be told why, and the status must not have moved.
    await expect(
      page.locator('.toast').filter({ hasText: /not been weighed|no price yet/i }).first()
    ).toBeVisible({ timeout: 30_000 });

    // Assert on the STATUS BADGE, not on the absence of the words "Out for
    // Delivery" — that phrase legitimately appears on this page as an upcoming
    // step in the tracking timeline, so its presence proves nothing either way.
    await expect(page.getByLabel('Status: Arrived at Hub')).toBeVisible();
    expect((await getOrderByTracking(fixture.trackingNumber)).status).toBe('Arrived at Hub');
  });

  test('weighing it clears the gate', async ({ page }) => {
    // The counterpart assertion: the gate blocks unweighed cargo, not all cargo.
    // Without this, a gate that rejected everything would still pass above.
    const { adminClient } = await import('./helpers/db.js');
    const db = await adminClient();

    const { error: weighError } = await db
      .from('orders')
      .update({ actual_weight: 5 })
      .eq('id', fixture.orderId);
    expect(weighError).toBeNull();

    const priced = await getOrderByTracking(fixture.trackingNumber);
    expect(Number(priced.shipping_cost), 'the trigger should have priced it').toBeGreaterThan(0);

    // Now unpaid rather than unpriced, so the PAYMENT half of the gate applies:
    // a prepaid shipment with a balance and no promise date is still held.
    const { error: heldError } = await tryDispatch(fixture.orderId);
    expect(heldError, 'unpaid prepaid cargo is held at the hub').not.toBeNull();
    expect(heldError.message).toMatch(/still owing|promise date/i);

    // Record a promise date — the documented, logged override — and it goes.
    const promise = new Date();
    promise.setDate(promise.getDate() + 7);
    await db
      .from('orders')
      .update({ promised_payment_date: promise.toISOString().slice(0, 10) })
      .eq('id', fixture.orderId);

    const { error: dispatchError } = await tryDispatch(fixture.orderId);
    expect(dispatchError, 'a weighed order with a promise date must dispatch').toBeNull();
    expect((await getOrderByTracking(fixture.trackingNumber)).status).toBe('Out for Delivery');
  });
});
