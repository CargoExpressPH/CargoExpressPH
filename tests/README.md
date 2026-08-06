# End-to-end tests

Playwright suite driving the real application against the **live Supabase
project configured in `.env`**. Point it at a development or staging project.

## Setup

```bash
cp .env.test.example .env.test     # then fill in E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
npm run test:e2e
```

The dev server starts automatically (`npm run dev` on :5173) and is reused if
one is already running.

### The admin account must already exist

The suite cannot create it. `guard_profile_write` forces every self-registered
profile to `role='customer'`, so an admin can only be minted with SQL or a
service-role key — neither belongs in a browser test. Create one in the
Supabase dashboard, then put its credentials in `.env.test`.

The **customer** is registered fresh by the suite on every run, with a
timestamped address on the reserved `.test` TLD, so runs never collide on
`profiles.email`.

## Running

```bash
npm run test:e2e                       # full journey, headless
npm run test:e2e:headed                # watch it drive the browser
npm run test:e2e:ui                    # interactive runner
npm run test:e2e:report                # open the last HTML report
npx playwright test tests/smoke.setup.spec.js    # harness check, no credentials needed
```

## What the journey covers

`admin-customer-journey.spec.js`, in order:

| # | Phase | What it proves |
|---|---|---|
| 1 | Admin signs in | Session **and** role resolve; the admin sidebar renders |
| 2 | Create trip | Manila → Bohol, 1000 kg, ₱75/kg, dated a week out |
| 3 | Publish announcement | Appears in the list after publish |
| 4 | Register customer | Two-step wizard, auto sign-in, lands in the customer app |
| 5 | Book a shipment | Five-step wizard onto *this run's* trip; asserts the submitting overlay appears; captures the server-generated `CE-YYYYMMDD-NNNN` |
| 6 | Unweighed order | Reads **"Not yet weighed — no price"**, and shows **no** `Settled` badge |
| 7 | Weigh + part-pay | 10 kg → ₱750 billed by the database; ₱500 cash collected at pickup |
| 8 | Partial state | Shows `partial` + `Unsettled — ₱250.00 owing`, never `Settled` |
| 9 | Dispatch | Trip cascade → `Out for Delivery` past the warehouse hold |
| 10 | Cash attribution | ₱500 lands in the **Cash** bucket, sourced from the ledger |
| 11 | Outstanding reconciles | Sales tile and Unsettled total agree; `?tab=unsettled` survives a reload |
| 12 | Overpayment | Invalid **while typing** — red border, helper text, submit disabled |

`dispatch-gate.spec.js` (Bug #3) seeds the one state the UI cannot produce — an
order at `Arrived at Hub` with no weight — and proves the gate refuses it, that
the admin UI surfaces the refusal rather than appearing to succeed, and that
weighing it clears the gate. The fixture is deleted in `afterAll`; it is an
invalid state by construction and must not be left in the reports.

The seed is created the way a real order is: **INSERT as the customer**
(the only INSERT policy on `orders` is `user_id = auth.uid()` — there is no
admin insert policy, which is correct design), then **UPDATE as the admin** to
walk the status forward. No service-role key is used anywhere; the tests can do
nothing an admin could not do in the app.

Figures are chosen so every assertion is exact: 10 kg × ₱75 = ₱750 billed,
₱500 collected, ₱250 outstanding.

## Design notes

**Serial, single worker, zero retries.** The suite drives one shared database
through a stateful journey — each phase consumes what the last one created.
Parallelism would race the phases through the same rows. Retries would be worse
than failing: none of these steps is idempotent, so a retried "create trip"
leaves a second trip and a retried payment records a second payment.

**`channel: 'chrome'`.** Playwright's bundled Chromium has no macOS 12 build,
which is what this project is developed on, so the suite drives the
system-installed Google Chrome. On macOS 13+ you can drop the channel.

**Video is off.** Same reason — the bundled ffmpeg has no macOS 12 build, and
leaving video on makes every test fail at `newPage()` before it runs. Traces
(filmstrip + DOM + network) are retained on failure instead.

**Custom widgets need custom handling.** `CustomSelect` is a button plus a
`role="listbox"`, not a `<select>`, so `selectOption()` cannot drive it and the
open click is retried — a click landing while React is still settling toggles
nothing. `AnimatedCounter` eases stat tiles from 0 over ~1.2s, so aggregate
assertions read through `readSettledNumber`, which waits for the figure to stop
moving rather than sampling a meaningless intermediate value. Text inputs are
title-cased as you type, so `fillById` compares case-insensitively.

**Failures explain themselves.** A failed save used to report as
"timeout waiting for navigation", which says nothing — the app's error toast
auto-dismisses long before a 45s timeout fires. `expectNavigationOrError` races
the two and reports the app's own message, and `collectDiagnostics` attaches
failed HTTP responses and console errors.

## Test data is not cleaned up

Every run leaves behind: one trip, one announcement, one customer account, and
one booked, weighed, part-paid order. All of it carries the run id printed in
the final summary. Clear it manually, or point the suite at a disposable
project.
