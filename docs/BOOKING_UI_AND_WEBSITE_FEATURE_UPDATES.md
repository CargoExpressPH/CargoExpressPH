# Booking UI and Website Feature Updates

Scope: collapsible Activity History, a server-enforced lock on sender/receiver contact details at
Out for Delivery/Delivered, and moving website featuring into a modal with correct per-booking
feedback detection — on the admin `OrderDetailPage`.

**A note on how this work started.** Substantial work toward this exact task was already present,
uncommitted, in the working tree before this session began (Activity History collapse,
`WebsiteFeatureModal.jsx`, and a migration locking `update_order_contact_details()`) — evidently
from a peer Remote Control session (`ListAgents` shows one named "Edit Sender & Receiver Details
feature"). Per the instruction to inspect the existing implementation first, that work was read in
full, verified, and used as the base rather than redone from scratch. Section 7 lists exactly what
was already correct, what was a real bug, and what this session added.

---

## 1. Changes made

### 1a. Collapsible Activity History
One toggle button (chevron icon, rotates on state change) in the Activity History card header.
Expanded shows the existing timeline unchanged; collapsed shows only the header. `aria-expanded`
+ an accessible label (`"Expand/Collapse activity history"`) on the single control — there is no
second minimize button. State (`activityCollapsed`) is a plain component `useState`, touched only
by this one handler, so it survives every other re-render on the page (payment actions, status
changes, refreshes) without resetting. The underlying data fetch/render (`activityHistory.map(...)`)
is byte-identical to before — only wrapped in the collapse/animation.

### 1b. Contact-details lock at Out for Delivery / Delivered
- **Frontend (admin):** the "Sender & Receiver" card header shows a "Locked" badge with a tooltip
  instead of the "Edit Details" button once the order reaches `Out for Delivery` or `Delivered`; a
  short explanatory line appears below: *"Customer details are locked once the booking is out for
  delivery."* Every other status keeps the existing "Edit Details" button and modal unchanged.
- **Backend:** `update_order_contact_details()` re-checks `orders.status` itself (inside a
  `SELECT ... FOR UPDATE` on the row) on every call — an edit form opened before the status changed
  gets rejected with the same message, not silently applied.
- **Defense in depth (added this session — see §2):** the identical rule is now also enforced at
  the trigger level (`guard_order_update()`), closing a real gap where a direct table `UPDATE`
  (bypassing the RPC entirely) would otherwise have succeeded under the existing broad admin/
  customer RLS policies.

### 1c. Website featuring moved into a modal
The large inline "Website Feature" section is gone. In its place: a single compact button —
**"Feature This on Website"** (or **"Manage Website Feature"** once already featured) — that opens
`WebsiteFeatureModal`. The modal reuses the exact same fields, validation, and save path the old
inline section used (title, caption, image-type select, publish/remove), plus:
- A **"Customer feedback received"** indicator, with the actual star rating and comment, fetched by
  `order_id` (a `UNIQUE` FK on `customer_feedback` — the real booking relationship, never a name
  match). States clearly when no feedback exists for this booking.
- A **photo preview** showing the literal image that would be published (mirrors the exact
  provider-side selection logic — delivery photo only when that type is chosen and one exists,
  pickup otherwise), so the admin can check it for a shipping label or visible address before
  publishing, not just pick a category blind.
- Explicit **Publish/Update Feature/Remove from Website** and **Cancel** actions. Opening or
  cancelling the modal never calls `onSave` — nothing is written until the admin explicitly clicks
  the primary action.

---

## 2. Files and database objects affected

| File | What changed |
|---|---|
| `src/pages/admin/OrderDetailPage.jsx` | Activity History collapse; contact-lock UI gate (fixed to use the correct admin-specific status list, see §7); Website Feature button + modal wiring; `getOrderFeedback()` used instead of an ad-hoc inline query; removed dead imports (`CustomSelect`, `Save`, `ChevronsUpDown` — all orphaned once the inline feature section moved into the modal) |
| `src/components/ui/WebsiteFeatureModal.jsx` (new) | The feature modal itself; fixed to use the real `.modal`/`.modal-body` design-system classes and the real `.btn-icon` close button (both were using invented, undefined class names — see §7); added the photo preview |
| `src/constants/status.js` | Added `ADMIN_CONTACT_EDIT_LOCKED_STATUSES` (`Out for Delivery`, `Delivered`) and `canAdminEditContactDetails()`; corrected `CONTACT_EDIT_LOCKED_STATUSES`'s doc comment, which had become false (see §7) |
| `src/lib/database.js` | Added `getOrderFeedback(orderId)`, following this codebase's "all reads/writes go through database.js" convention |
| `supabase/migrations/20260915120000_lock_contact_details_at_out_for_delivery.sql` | `update_order_contact_details()`: admin blocked at Out for Delivery/Delivered; customer additionally at Cancelled (unchanged); everything else (validation, ownership, no-op detection, activity log) untouched |
| `supabase/migrations/20260915130000_guard_contact_details_lock_at_trigger_level.sql` (new, this session) | `guard_order_update()`: adds the identical rule as a trigger-level backstop against a direct table `UPDATE` bypassing the RPC. Reproduces the rest of the function verbatim from `20260911020000` — trip capacity, pricing recompute, the discount guard, and the dispatch gate are unchanged |
| `scripts/contact-details-lock-pgtest/` (new, this session) | Local pgtest coverage for both migrations (§6) |
| `package.json` | Added `test:contact-details-lock` |

No changes were made to `customer_feedback`, `orders`' existing columns, or any other RPC. The
`activity_logs` write inside `update_order_contact_details()` is unchanged.

---

## 3. Exact fields and statuses covered by the editing restriction

**Locked fields** (both the RPC and the trigger check the same 16 columns as one unit):
`sender_name`, `sender_phone`, `sender_province`, `sender_city`, `sender_barangay`,
`sender_street`, `sender_landmark`, `sender_address`, and the matching 8 `receiver_*` columns.

**Statuses:**
| Role | Locked at |
|---|---|
| Admin | `Out for Delivery`, `Delivered` |
| Customer (unchanged, pre-existing) | `Out for Delivery`, `Delivered`, `Cancelled` |

Admin keeps the ability to correct a **Cancelled** booking's address (archival/dispute
correction) — a deliberate, narrower rule than the customer's, not a new override (see §7 for why
this had to become its own status list rather than reusing the customer one).

**Never locked by this change:** payments (`record_pickup_payment`, `record_delivery_payment`,
`record_additional_payment`), delivery confirmation, discount changes, trip assignment, photo
uploads, feedback submission — all separate RPCs/columns the trigger's `IS DISTINCT FROM` check
never touches, and confirmed unaffected by the new pgtest suite (§6, "an unrelated field can still
be updated on a locked order").

**Profile edits do not rewrite a locked booking** — inspected as asked. `orders.sender_name` /
`receiver_name` / address columns are a point-in-time snapshot; there is no trigger, RPC, or
frontend code path anywhere in the codebase that copies a `profiles` row's changes onto any
`orders` row (confirmed by grep for any `UPDATE ... orders ... SET sender_name`/`receiver_name`
sourced from `profiles`, and by reading every customer profile-editing page). This was already true
before this task; no fix was needed.

---

## 4. How feedback detection and website featuring work

1. Admin clicks "Feature This on Website" → `openFeatureModal()` calls the new
   `getOrderFeedback(orderId)`, which reads `customer_feedback` filtered on `order_id` (`UNIQUE`,
   `NOT NULL`, `REFERENCES orders(id)` — one row per booking, never a name match). Admin RLS
   ("Admins can manage all feedback") permits reading any row, confirmed against the live schema.
2. The modal seeds its form from the *current* `orders.featured_*` columns whenever it opens, so a
   previously-featured booking shows its real current configuration, not a blank form.
3. Publishing calls the same `updateOrder()` → `orders` row update, and the same `logOrder()` audit
   entry, the pre-existing inline section already used — no new publishing mechanism.
4. **Consent/privacy architecture, inspected and left untouched.** A separate, pre-existing public
   RPC, `get_public_feedback()`, already returns every non-hidden `customer_feedback` row (rating,
   message, masked name, city) to the public About page **independent of the `featured_on_website`
   flag** — the feedback-visibility control is `customer_feedback.is_hidden`, moderated on the
   existing `FeedbackPage.jsx`, a completely separate admin page/table this task does not touch.
   `featured_on_website` only ever controls whether a **photo** is attached to an already-visible-
   or-not testimonial (`AboutPage.jsx` explicitly nulls `resolved_image` for a non-featured row).
   A second, genuinely photo-only path already exists too (`get_featured_deliveries()`), confirming
   the codebase already keeps "photo highlight" and "customer testimonial" as separate concepts —
   this task's modal does not conflate them: `featured_caption` is free admin text, never
   auto-filled from `feedback.message`.
5. **No duplicate featured entries are possible** — `featured_on_website`/`featured_title`/etc. are
   columns directly on the one `orders` row per booking; there is no separate table to duplicate
   into.

---

## 5. Bugs found and fixed this session (against the pre-existing/peer-session work)

1. **Frontend/backend status-list mismatch for admins.** The admin page's gate reused
   `CONTACT_EDIT_LOCKED_STATUSES` — the *customer* list, which includes `Cancelled` — while the RPC
   deliberately leaves `Cancelled` editable for admins. An admin would have seen "Locked" on a
   Cancelled booking with no way to correct it, even though the backend would have accepted the
   edit. Fixed with a dedicated `ADMIN_CONTACT_EDIT_LOCKED_STATUSES`.
2. **A real server-side bypass of the whole lock.** `update_order_contact_details()` alone is not
   enough — `orders` has a blanket, column-unrestricted admin `UPDATE` RLS policy, so a direct
   `.from('orders').update({ sender_name })` (a stray future code path or a raw authenticated API
   call) would have silently succeeded regardless of status, skipping the RPC and its lock
   entirely. Closed with the new trigger-level guard (§2), verified to actually block this exact
   scenario (§6).
3. **Two undefined CSS classes** (`icon-btn`, `modal-container`) used only in the new files — not
   defined anywhere in the stylesheet, so the Activity History toggle and the modal's close button
   had no real touch-target sizing, and the modal itself had no background/shadow/radius/mobile
   safe-area handling from CSS at all. Replaced with the actual, already-established classes
   (`.btn-icon`, `.btn-icon.btn-ghost`, `.modal`) used by every other icon button and modal in this
   codebase — confirmed via `grep` that `icon-btn`/`modal-container` (bare) appeared nowhere else.
4. **Stale comments** describing the old "admin is exempt from the status lock" behavior, left
   in `status.js` and `OrderDetailPage.jsx` after the lock was added — corrected.
5. **No photo preview in the feature modal**, despite the task asking to show "the actual rating
   and comment, plus eligible booking photos" and "a preview of what will appear on the website" —
   only a text line existed. Added a real thumbnail of the exact photo that would publish.
6. **Convention violation:** feedback was fetched via a raw dynamic `import('../../lib/supabase')`
   inline in the page component instead of going through `database.js`. Moved to
   `getOrderFeedback()`.

None of these were security-critical except #2, which is now closed and verified.

---

## 6. Tests performed and actual results

All testing used disposable, synthetic records against a real embedded Postgres
(`@electric-sql/pglite`) with the actual, unmodified migration files applied verbatim — no real
booking or customer record was touched, and no live database was modified.

**`npm run test:contact-details-lock`** — two suites, **32/32 assertions passed**:

- `scripts/contact-details-lock-pgtest/run.mjs` (24 assertions) — the RPC itself: admin allowed at
  every pre-delivery status; admin rejected at Out for Delivery/Delivered; admin still allowed at
  Cancelled; **a stale form (status changed to Out for Delivery after the form was "opened") is
  still rejected on save** — the exact scenario the task called out; customer's broader lock
  (including Cancelled) confirmed unchanged; ownership enforced (a customer cannot edit another
  customer's booking); unauthenticated caller rejected; validation (blank required field) rejected;
  no-op resend writes no activity log; activity log correctly attributes "Admin" vs "Customer".
- `scripts/contact-details-lock-pgtest/trigger-bypass-run.mjs` (8 assertions, new this session) —
  the trigger-level backstop, built on `shipping-discount-pgtest`'s existing full `orders`/trigger
  harness (needed because `guard_order_update()` references several other columns unconditionally):
  a **raw `UPDATE orders SET sender_name = ...`** (never touching the RPC) is rejected at Out for
  Delivery and at Delivered, with the row provably unchanged; the same raw update still succeeds on
  a Cancelled order (documented exception preserved); resending the identical value is not
  rejected; an unrelated column (`payment_method`) update on a locked order is not blocked; a
  direct update still works normally before the lock.

**Existing suites re-run, unaffected:**
- `npm test` (full default chain) — all pass, including `photo-storage-monitoring-contract-test.mjs`
  (unrelated to this task, confirms no cross-contamination from earlier work this session).
- `npm run test:shipping-discount` (92 assertions, the suite that already covered
  `guard_order_update()`'s other behavior) — re-run **unmodified** against its own original
  migration chain to confirm this task changed nothing there; all pass.
- `npm run build`, `node scripts/token-lint.mjs`, `node scripts/axe-lint.mjs` — all pass (the two
  undefined-CSS-class bugs in §5 were caught by `token-lint`/manual review, not left in).
- `supabase db push --dry-run` against the live linked project confirms both new migrations are
  recognized as the two pending, unapplied changes — nothing else is outstanding.

---

## 7. What was already correct in the pre-existing work (verified, not re-implemented)

- The RPC's own status re-check, ownership check, validation, no-op detection, and activity-log
  attribution were all already correct and are unchanged.
- The single-toggle Activity History collapse (no duplicate minimize control) was already correctly
  built — only its icon-button styling needed fixing.
- Feedback's `order_id`-based (not name-based) matching, the modal's Cancel-never-saves behavior,
  duplicate-prevention (structural, via one row per order), and the preserved
  unfeature/"Remove from Website" action were all already correct.
- The deliberate choice to keep admins editable on Cancelled bookings (documented in the migration
  the peer session wrote) is sound reasoning and was kept as-is, not treated as a bug — only the
  *frontend* mismatch against it (§5.1) needed fixing.

---

## 8. Local vs. deployed status

**Local only — not applied to the live database or deployed:**
- `supabase/migrations/20260915120000_lock_contact_details_at_out_for_delivery.sql` (pre-existing
  from before this session, verified correct, still unapplied).
- `supabase/migrations/20260915130000_guard_contact_details_lock_at_trigger_level.sql` (new this
  session).
- All frontend changes (`OrderDetailPage.jsx`, `WebsiteFeatureModal.jsx`, `status.js`,
  `database.js`) — committed to the working tree only, not built-and-deployed as a live SPA update.

Both migrations were confirmed, via `supabase db push --dry-run` against the live linked project,
to be the only two migrations currently pending. No Edge Function changes are needed or were made
for this task.

## 9. Verification gaps — stated explicitly

- **No browser/live rendering was verified.** The Activity History collapse animation, the "Locked"
  badge placement, and the modal's desktop/mobile layout (including the new photo preview) were
  checked by code review and the design-system class fixes in §5.3, not by opening the page in an
  actual browser. This needs a staging environment.
- **No live end-to-end save** was performed against the real Supabase project for either the
  contact-details lock or the feature-publish flow — disallowed by the task without a separate
  approval, and consistent with using disposable pgtest records only.
- **Keyboard/focus-restoration behavior** (Escape closing the modal, focus returning to the trigger
  button) relies on the existing, already-reused `FocusTrap` component's established behavior in
  every other modal in this codebase; it was not independently re-verified with a live screen
  reader or keyboard-only pass in this session.
