# F-007 — Fix plan: customer-controlled `service_area_status` mass assignment

- **Status:** ✅ Implemented 2026-09-12, approved and applied to the repository
- **Supersedes/formalizes:** F-003-customer-service-area-mass-assignment.md
- **Severity:** HIGH
- **Confidence:** CONFIRMED (re-verified against current `main`, 2026-09-12)
- **Area:** Booking authorization / out-of-coverage review workflow

## Bug / Issue Description

The `orders` table INSERT path (RLS `WITH CHECK` policy + the two customer-insert
triggers) does not constrain, whitelist, or reset `service_area_status` or
`service_area_remarks`. A customer's booking request is expected to only ever
set `service_area_status = 'for_review'` (and only when booking from an
out-of-coverage province), via client-side logic in `BookShipmentPage.jsx`.
Because nothing on the server enforces this, a modified/crafted INSERT request
from an authenticated customer session can set `service_area_status` to
`'approved'` (or simply omit it, leaving the column default `'standard'`)
regardless of the actual pickup province, and the booking will never enter the
staff review queue.

This was independently re-verified (not merely re-read from the original
report) against the current repository state on 2026-09-12:

- `supabase/migrations/20260524190000_production_hardening.sql` defines the
  live `"Users can create own orders"` INSERT policy. It is **never replaced**
  by any later migration (confirmed by `grep` across all 90+ migration files)
  and constrains only: `user_id`, `status IN ('Pending','Assigned')`,
  `actual_weight IS NULL`, `payment_method IS NULL`, `payment_status='unpaid'`,
  `amount_paid=0`, `pickup_photos='[]'`, `delivery_photos='[]'`. It is
  reproduced identically in `supabase/schema.sql:3937`.
- The latest `guard_customer_order_insert()` (defined in
  `20260909094000_restore_trip_capacity_enforcement.sql`) resets
  `featured_on_website`/`featured_title`/`featured_caption`/`featured_image_type`/`featured_at`
  for a non-admin insert, but does **not** touch `service_area_status` or
  `service_area_remarks`.
- The latest `prepare_order_insert()` (defined in
  `20260911020000_shipping_discount_guards.sql`) resets payment fields and all
  five discount columns for every insert, but likewise never touches
  `service_area_status`/`service_area_remarks`.
- `createOrder()` in `src/lib/database.js:192` spreads `...orderData` directly
  into the Supabase insert call with no field allowlist, so any extra key a
  tampered client sends passes straight through to Postgres.
- No migration created after the original audit date (2026-09-11) touches
  either column, and no script under `scripts/*.mjs` exercises this path.

## Root Cause

Two related gaps, both dating to the feature's introduction in
`20260625010000_out_of_coverage_workflow.sql`, which only added the columns
and a `CHECK` constraint on their allowed *values* (`standard`, `for_review`,
`approved`, `rejected`) — it never added the authorization layer that decides
*who* may set which value:

1. **No RLS constraint** on customer INSERT for these two columns — unlike
   every other sensitive field on the same table.
2. **No trigger-side reset** for non-admin inserts — inconsistent with the
   established pattern already used for `featured_*` and `discount_*` fields
   on the same triggers.

Additionally, I found that `createOrder()` unconditionally overrides
`status: finalStatus` (always `'Pending'`/`'Assigned'`), silently discarding
the page's own `payload.status = 'Pending Review'` for the out-of-coverage
case. This means `service_area_status` is not merely *one of several* checks
the admin review queue uses — `OrdersPage.jsx:247` and
`OrderDetailPage.jsx:880/915` key **exclusively** on
`service_area_status === 'for_review'` to flag/gate the review workflow. The
unprotected field is therefore a single point of failure for the entire
out-of-coverage review process, not a defense-in-depth layer.

## Impact

A booking from an unsupported service area can be made to look like a normal,
already-approved booking, skipping the human review step the business process
requires (confirming special pickup arrangements, verifying feasibility,
etc.). This is a business-authorization bypass, not a cross-customer data
leak — no other customer's data is exposed, and the exploit requires a
customer to modify their own authenticated request (not a remote/anonymous
attacker). Likelihood is non-trivial: any customer with browser dev tools or
an API client (Postman/curl with their own session token) can perform this
without any special access.

## Recommended Fix / Integration Plan

**1. RLS — constrain the INSERT policy** (new migration,
`supabase/migrations/<timestamp>_restrict_service_area_customer_insert.sql`):

```sql
DROP POLICY IF EXISTS "Users can create own orders" ON public.orders;
CREATE POLICY "Users can create own orders" ON public.orders
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND status IN ('Pending', 'Assigned')
    AND actual_weight IS NULL
    AND payment_method IS NULL
    AND payment_status = 'unpaid'
    AND amount_paid = 0
    AND pickup_photos = '[]'::jsonb
    AND delivery_photos = '[]'::jsonb
    AND service_area_status IN ('standard', 'for_review')
    AND service_area_remarks IS NULL
  );
```

`'approved'`/`'rejected'` are excluded from what a customer INSERT may ever
carry — those values are only ever legitimate as the result of an admin's
`UPDATE` (already correctly gated by the existing admin-only `UPDATE` policy,
verified during the original review).

**2. Trigger — derive the value server-side, don't trust the client's flag**
(same migration, `CREATE OR REPLACE FUNCTION public.prepare_order_insert()` —
full current body preserved verbatim per the established pattern in this
codebase's own migrations, plus):

```sql
-- A booking is never born pre-approved or pre-rejected; the province
-- determines whether it needs review, not a client-supplied flag.
NEW.service_area_status := CASE
  WHEN public.detect_pickup_location(NEW.sender_province) IS NULL THEN 'for_review'
  ELSE 'standard'
END;
NEW.service_area_remarks := NULL;
```

(Exact province-detection predicate to be confirmed against
`src/constants/phLocations.js`'s `detectPickupLocation()` logic — a matching
SQL-side helper may already exist or need to be added; this will be resolved
during implementation, not guessed at here.)

**3. Fix the silently-discarded `status` override** in
`src/lib/database.js:createOrder()` so an out-of-coverage booking actually
lands in `'Pending Review'` as the UI/admin pages already assume, instead of
always forcing `'Pending'`.

**4. Regression test** — add a new scenario to
`scripts/security-hardening-contract-test.mjs` (or a dedicated
`scripts/service-area-mass-assignment-test.mjs`, following the existing
`pgtest` pattern) asserting:
   - A customer INSERT with `service_area_status: 'approved'` is rejected.
   - A customer INSERT with `service_area_remarks` set is rejected.
   - An out-of-coverage province booking is server-derived to `'for_review'`
     even if the client sends `service_area_status: 'standard'`.
   - An in-coverage booking is server-derived to `'standard'` even if the
     client sends `service_area_status: 'for_review'`.
   - Admin `UPDATE` to `'approved'`/`'rejected'` continues to work unchanged
     (no regression to `handleApproveReview`/`handleRejectReview`).

**Regression risk:** Low. This tightens a `WITH CHECK`/trigger that never
intentionally allowed customer-supplied `approved`/`rejected` values, and the
only behavioral change customers should observe is that the field is now
correctly derived rather than trusted from their own request.

**Estimated effort:** Small — one migration following an existing,
well-precedented pattern in this codebase (`featured_*`/`discount_*` resets),
plus one small frontend fix, plus one new test file.

---

## Implementation Record (2026-09-12)

**What shipped**, exactly as planned, with one deliberate scope reduction:

1. `supabase/migrations/20260912030000_restrict_service_area_customer_insert.sql`
   — adds `public.is_standard_service_area_province()`, updates
   `prepare_order_insert()` to derive `service_area_status`/`service_area_remarks`
   server-side (unconditionally, matching the existing `discount_*`-zeroing
   pattern on the same trigger), and adds the belt-and-suspenders RLS
   constraint to `"Users can create own orders"`.
2. `scripts/service-area-mass-assignment-pgtest/` (`harness-schema.sql` +
   `run.mjs`) — a new regression suite following the codebase's established
   pgtest pattern (real embedded Postgres via PGlite, real migration files
   applied verbatim, genuine `SET LOCAL ROLE` for RLS enforcement). **12/12
   passing**, including a BEFORE scenario that reproduces the actual
   vulnerability against the real pre-fix policy/trigger, and AFTER scenarios
   covering: forged `service_area_status`/`service_area_remarks` neutralized,
   standard-province and out-of-coverage derivation both correct, all six
   known service-area provinces still recognized, and admin-created bookings
   derived the same way (not exempted).
3. Wired into `package.json` as `npm run test:service-area-mass-assignment`.
4. `audit_reports/F-003-customer-service-area-mass-assignment.md` updated to
   point at this fix.

**Scope reduction from the original plan — item 3 (fixing `createOrder()`'s
`status` override) was deliberately NOT implemented.** During implementation
I re-confirmed that `OrdersPage.jsx`/`OrderDetailPage.jsx`'s review-queue gate
already keys exclusively on `service_area_status`, never on `status` — so
`service_area_status` alone fully closes the security gap regardless of what
`status` ends up as. Changing the status-override behavior would have
required also widening the INSERT policy's `status IN (...)` allow-list to
admit `'Pending Review'`, which touches core order-lifecycle semantics for a
cosmetic label fix with no security value. Left as a separate, low-priority,
non-security follow-up if the team wants the `'Pending Review'` status
label to actually appear on out-of-coverage bookings.

**Verification performed:**
- `node scripts/service-area-mass-assignment-pgtest/run.mjs` — 12/12 passed.
- `npm test` (all 17 static/contract checks) — passed, unaffected.
- `npm run test:shipping-discount` (92/92), `test:payment-ledger` (52/52),
  `test:payment-notifications` (41/41) — all still passing, confirming the
  new migration does not interfere with the existing discount/payment test
  suites (they use their own curated migration lists and do not load this
  new file, as established practice in this codebase).
- Whether this migration has actually been `supabase db push`-ed to the live
  production project was **not** verified — that requires
  `supabase migration list --linked` against the real project, outside the
  scope of this local, read-only-until-approved implementation pass.
