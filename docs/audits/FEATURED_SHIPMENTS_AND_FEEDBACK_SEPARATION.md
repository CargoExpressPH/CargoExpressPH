# Featured Shipments / Customer Feedback Separation

Restores the public "Featured Shipments" gallery that a prior change removed, moves the
shipment-publishing action into Shipment Evidence, and fixes the actual root cause of the original
complaint — a shared `orders.featured_photo` value was rendered on both the gallery **and** a
booking's feedback card, so featuring a shipment silently duplicated its photo onto that booking's
review. The prior removal deleted the whole gallery instead of breaking that coupling; this task
restores the gallery and breaks the coupling instead.

---

## 1. What the old button actually did

Before this task, "Manage Feedback Photo" (previously "Feature This on Website", relabeled in the
removal commit) sat below Activity History on the admin Order Detail page and opened a modal
that toggled `orders.featured_on_website` plus `featured_title` / `featured_caption` /
`featured_image_type` / `featured_at`. This was never a "feedback photo" feature — there is no
photo column on `customer_feedback`, and there never has been. What it actually did was publish an
admin-selected pickup/delivery proof photo, which two different public RPCs then both read:

- `get_featured_deliveries()` — the standalone shipment gallery (removed from the UI, but the RPC
  itself was left in place the whole time).
- `get_public_feedback()` — joined the same `orders.featured_photo` / `featured_on_website` /
  `featured_image_type` onto that booking's feedback row, so a customer review displayed the
  admin's shipment photo, not anything the customer submitted.

The prior removal commit (`6f3c810`) deleted the gallery section, the `getFeaturedDeliveries()` JS
wrapper, and the highlight/lightbox UI, then relabeled the still-present modal as a "feedback
photo" control — leaving the actual duplication mechanism (`get_public_feedback()` reading
`orders.featured_photo`) untouched and now mislabeled as something it wasn't.

## 2. How shipment featuring and feedback differ now

| | Featured Shipments | Customer Feedback |
|---|---|---|
| Trigger | Admin action only (`FeatureShipmentModal`, from Shipment Evidence) | Customer submits a rating + comment after delivery |
| Requires | `status = 'Delivered'` + at least one pickup/delivery photo | Nothing shipment-related; independent of `featured_on_website` |
| Data source | `orders.featured_on_website/featured_title/featured_caption/featured_image_type/featured_at`, read via `get_featured_deliveries()` | `customer_feedback` (rating, message, `is_hidden`), read via `get_public_feedback()` |
| Photo | Admin-selected pickup or delivery proof (`featured_photo`, first photo of the chosen type) | **None.** `customer_feedback` has no photo column; `get_public_feedback()` no longer returns any photo/feature field at all |
| Moderation | Publish / Update Feature / Remove from Website (`FeatureShipmentModal`) | Show/Hide (`updateFeedbackVisibility`, unchanged, admin Feedback page) |
| A booking can have | A shipment card, a feedback card, both, or neither — independently | — |

A booking with both is valid and expected (§5 of the request). Nothing links them anymore: the two
RPCs are joined to `orders` for different, non-overlapping columns.

## 3. Files and database objects changed

**Admin**
- `src/components/ui/FeatureShipmentModal.jsx` — **new**, replaces `WebsiteFeatureModal.jsx`
  (deleted). Same idempotent-UPDATE publish flow, title/caption/photo-type fields restored, the
  "Customer feedback received" panel removed (feedback is no longer read or displayed here at
  all — the modal has zero dependency on `customer_feedback`), labels changed to "Feature Delivery
  on Website" / "Manage Featured Shipment" per the request, preview relabeled "Public shipment card
  preview".
- `src/pages/admin/OrderDetailPage.jsx` — the standalone button below Activity History is gone; a
  `btn-sm` button now sits inside the Shipment Evidence card, beneath Delivery Proofs, gated on
  `status === 'Delivered'` (the card itself already only renders when photos exist, so "suitable
  delivery photos" is enforced for free). Dropped the on-demand `getOrderFeedback` fetch and its
  two state variables — nothing in the new flow needs a booking's feedback. Activity-log wording
  updated to describe a "Featured Shipment", including the title again.

**`src/lib/database.js`**
- `getFeaturedDeliveries()` — restored (calls the never-removed `get_featured_deliveries` RPC).
- `getPublicFeedback()` — its `orders: {...}` shape now carries only `receiver_city` /
  `receiver_province`; no photo/feature fields.
- `getOrderFeedback()` — removed (its only caller was the modal above).

**Public site (`src/pages/public/AboutPage.jsx`, `src/styles/about-page.css`)**
- The Featured Shipments section, its `Lightbox` component, and the associated CSS
  (`.about-highlight-*`, `.about-lightbox-*`, `aboutSlideUp` keyframe) are restored essentially
  verbatim from before the removal (`git show 6f3c810^`).
- One deliberate behavior change from the pre-removal version: the section now renders **nothing**
  (not even an empty-state placeholder) when there are no published entries, per this task's
  explicit "hide the section cleanly" requirement — the original always rendered a placeholder
  card. It is still not linked from the top nav, matching the pre-removal state (the nav's own
  comment already said as much).
- The feedback card's `.about-review-photo` block and its photo-resolution code are removed — there
  is nothing left to render a photo from.
- Nav anchors / `SECTIONS` / active-section tracking: **unchanged**. `#highlights` was never in the
  linked nav before removal either, so nothing needed updating there. `#feedback` ("Reviews") is
  untouched and still scrolls correctly.

**Database** — `supabase/migrations/20260915140000_separate_featured_shipments_from_feedback.sql`
(mirrored into `supabase/schema.sql`):
1. `get_public_feedback()` — `DROP FUNCTION` + recreate without `featured_on_website` /
   `featured_image_type` / `featured_photo` in its return columns. This is the actual fix: even if
   a future client accidentally re-reads `fb.orders.featured_photo`, the RPC no longer has it to
   give.
2. `get_featured_deliveries()` — added `AND o.featured_title IS NOT NULL AND btrim(o.featured_title)
   <> ''` to its `WHERE` clause. See §4 for why.

Neither `orders.featured_*` columns, `get_expired_evidence_orders()`, nor
`is_featured_photo_path()` (the storage-cleanup protection function) were touched — they already
correctly key off `featured_on_website`/`featured_image_type` alone and needed no change.

## 4. How existing data was handled

No data was migrated, deleted, or reassigned. `orders.featured_on_website` has meant "publish this
shipment's photo" since it was introduced, and that meaning is unchanged — restoring the gallery
does not require reinterpreting it. The one real ambiguity: between the original removal and this
fix, the admin UI briefly required a toggle with **no title field at all** ("Add Photo to Customer
Feedback"). A booking re-toggled during that window could have `featured_on_website = true` with
`featured_title IS NULL`, and that state genuinely doesn't tell us whether an admin intended a
public shipment showcase entry. Per the request's "preserve the underlying data and require
explicit admin review" instruction, `get_featured_deliveries()` now also requires a non-blank title
— so:
- Any booking already fully featured before the intermediate window (has a title) publishes exactly
  as before, no admin action needed.
- Any booking toggled during the intermediate window (no title) stays **out** of the public gallery
  — but its `featured_on_website` flag, photos, and any other admin data are untouched — until an
  admin opens the restored modal and saves a title, which the modal's existing required-title
  validation already forces.

No `customer_feedback` row was touched, reinterpreted, or had a photo added/removed — it never had
a photo field, so there was nothing to disentangle on that side.

## 5. Tests performed and actual results

**Automated, this session:**
- `npm test` (full chain: smoke check, axe-lint, token-lint, all contract tests + pgtests already
  in the suite) — **passed**, no regressions.
- `npm run test:photo-gallery` (storage folder-browser pgtest, exercises `featured_on_website` as a
  deletion-protection flag) — **passed**, unaffected.
- `npm run build` — **succeeds**.
- New: `npm run test:featured-shipments` (`scripts/featured-shipments-pgtest/run.mjs`) — a real
  embedded-Postgres (PGlite) suite, same convention as the other `*-pgtest` scripts: a hand-built
  harness schema, `mask_name()`/`is_featured_photo_path()` copied verbatim from `schema.sql`
  (unmodified by this task, needed only so the tested functions compile), then
  **the actual new migration file applied verbatim** — **28/28 assertions passed**:
  - A Delivered booking with no feedback publishes to Featured Shipments with its own title/photo.
  - Feedback with no featured shipment appears normally, with the real rating/message/masked
    name/location — and the RPC result literally has no `featured_photo`/`featured_on_website`/
    `featured_image_type` keys.
  - A booking with both: the shipment card and feedback card each show their own data; the feedback
    row has no photo field to duplicate into.
  - A featured row with a null or blank title is excluded from the public gallery; setting the
    title (simulating admin review) publishes it.
  - Three repeated "publishes" of the same booking produce exactly one gallery entry (idempotent
    UPDATE, not an insert).
  - Unpublishing removes the gallery entry but leaves `status`/`delivery_photos` untouched.
  - `is_featured_photo_path()` recognizes the currently-featured path, not an unrelated one, and
    stops recognizing it once unpublished.
  - Anonymous and the booking's own customer cannot set `featured_on_website` (real RLS, `SET LOCAL
    ROLE`, not simulated); an admin can.

**Not performed (needs a live/staging Supabase project + browser, per this project's own
`playwright.config.js` convention of never running E2E against production):**
- The admin `FeatureShipmentModal` UI itself (open/cancel/save/remove, photo-type switching, the
  live preview) was not clicked through in a browser.
- The public About page was not opened in a browser (desktop or mobile) to visually confirm the
  restored gallery, its lightbox, and the now-photo-less feedback cards.
- No real customer content was published or altered — this task created no live data of its own;
  all "disposable test records" above ran inside an in-memory PGlite instance, not the real
  database.

## 6. Local vs. deployed

Everything in this task is **local, uncommitted changes** — nothing has been committed, pushed, or
deployed. `supabase db push` has not been run.

## 7. Remaining steps / verification gaps

- **Deploy the migration**: `supabase link --project-ref <ref>` (if not already linked) then
  `supabase db push` to apply `20260915140000_separate_featured_shipments_from_feedback.sql`.
  Both functions it replaces are read-only `SECURITY DEFINER` RPCs with no other DB objects
  depending on their exact column list (confirmed via `DROP FUNCTION IF EXISTS` pattern already
  used by the migration it supersedes, `20260806000000`), so this is safe to deploy independently
  of the frontend: shipping the migration first simply makes `get_public_feedback()` stop returning
  photo fields immediately (the old frontend code already treats a falsy `featured_on_website` as
  "no photo," so this fails safe); shipping the frontend first just means the restored gallery
  briefly runs against the old, unfiltered `get_featured_deliveries()` until the migration lands.
  Deploying both together is still the cleanest order.
- **Browser verification** (listed above) is the main gap — recommend clicking through
  Feature/Cancel/Remove-from-Website on a disposable Delivered test booking, and loading `/about`
  on desktop and mobile, against a dev/staging Supabase project before this ships.
- Historical/dated docs (`SECURITY_AUDIT_2026-08-17.md`,
  `../archive/database-architecture-review.md`) still describe the pre-fix `get_public_feedback()` shape
  or older audit findings — left untouched deliberately, as point-in-time records rather than
  living references (`../architecture/TECHNICAL-OVERVIEW.md` and `../architecture/database_design.md` were checked and
  remain accurate as-is).
