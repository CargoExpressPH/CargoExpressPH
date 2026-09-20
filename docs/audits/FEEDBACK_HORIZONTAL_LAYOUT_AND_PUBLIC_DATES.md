# Customer Feedback Horizontal Layout & Public Dates

Redesigns the Customer Feedback section on the About page into a horizontally-scrollable row with
a compact rating filter, and adds an authoritative, correctly-sourced date to both Customer
Feedback ("Reviewed …") and Featured Shipments ("Delivered …") — without touching the separation
between those two sections established in the prior task.

---

## 1. Files changed

| File | What changed |
|---|---|
| `src/pages/public/AboutPage.jsx` | New `ReviewStars`/`ReviewModal` components, review-excerpt helper, feedback-scroller state/effects/handlers, rewritten Customer Feedback JSX (horizontal scroll + dropdown/chip filter + dates + read-more), one line added to the Featured Shipments card for `delivered_at`. |
| `src/styles/about-page.css` | Feedback card redesigned (padding/radius, no quote mark, no italics, no `hero-testimonial` grid-span), new horizontal-scroller/nav-button/dropdown/review-modal styles. |
| `src/components/ui/CustomSelect.jsx` | **Unchanged** — reused as-is for the mobile rating dropdown. |
| `src/utils/datetime.js` | **Unchanged** — reused `formatPhDate()` for both new dates. |
| `supabase/migrations/20260915150000_add_delivered_at_to_featured_deliveries.sql` | **New** — adds `delivered_at` to `get_featured_deliveries()`'s return, sourced from `order_status_events`. |
| `supabase/schema.sql` | Mirrors the migration above. |
| `scripts/featured-shipments-pgtest/run.mjs` | Extended with a 5th test group (`delivered_at`) — 5 new assertions, 33/33 total now passing. |

No new columns, no new tables, no changes to `customer_feedback`, `get_public_feedback()`, or any
RLS policy.

## 2. Exact data source for each displayed date

**Customer Feedback — "Reviewed \<date\>"**
- Source: `customer_feedback.created_at`, returned by the existing `get_public_feedback()` RPC
  (`f.created_at`, untouched by this task) and already passed straight through by
  `getPublicFeedback()` in `database.js`.
- This is the row's insert timestamp — set once, by `submitFeedback()`'s `INSERT`, and never
  touched again by anything: there is no `UPDATE` path for `customer_feedback.created_at`, and the
  only other write to that row is `updateFeedbackVisibility()` (the `is_hidden` moderation toggle),
  which does not touch `created_at`. Moderating or hiding/showing a review cannot change its
  displayed date.
- Rendered via `formatPhDate(fb.created_at)` (`src/utils/datetime.js`, unmodified) — an
  `Intl.DateTimeFormat` call pinned to `timeZone: 'Asia/Manila'`, so the calendar day shown is
  always the PH day the instant falls on, not the viewer's local day.

**Featured Shipments — "Delivered \<date\>"**
- Source: `order_status_events.changed_at`, `MIN()`'d per order `WHERE status = 'Delivered'`, added
  to `get_featured_deliveries()` as a new `delivered_at` output column (migration above).
- `order_status_events` already exists specifically to record status transitions:
  `log_order_status_event()` (trigger `orders_log_status_event`, `AFTER INSERT OR UPDATE OF status
  ON orders`) inserts a row with the **server's own clock** every time `orders.status` changes,
  including the move into `'Delivered'`. This is the same table `get_public_order_events()` already
  reads for the public tracking timeline — this task reuses that exact convention rather than
  inventing a new one.
- **Why not `orders.updated_at`**: that column moves on *any* column change to the order — a
  payment edit, a contact-detail correction, a discount applied weeks later — so it answers "when
  was this row last touched," never "when was this delivered." Using it would have violated the
  request's explicit instruction not to use a generic `updated_at`.
- **Why not a new `orders.delivered_at` column**: `order_status_events` already captures this
  reliably and is already the authoritative source elsewhere in the codebase; adding a redundant
  column risks the two ever disagreeing. The one-line addition to an already-public,
  already-anon-executable RPC is narrower and safer than a schema change.
- **Redelivery/reopening**: there is no reopen/redeliver workflow in this app today (`Delivered` has
  no forward transition in `STATUS_FLOW`, and no admin action moves a Delivered order back a step —
  confirmed by inspecting `src/constants/status.js` and searching for any reopen/undo-delivery
  action). The query still defines consistent behavior regardless: `MIN(changed_at)` always reports
  the **first** time `'Delivered'` was reached for that order, matching
  `get_public_order_events()`'s own handling of a status appearing more than once. If a redelivery
  workflow is ever added, this keeps reporting the original delivery date unless that convention is
  deliberately changed at the same time.
- Rendered via `formatPhDate(highlight.delivered_at)`, same helper as above.

## 3. Missing-date handling

Both dates are rendered behind a truthiness guard (`fb.created_at && …`, `highlight.delivered_at &&
…`) — when the value is absent, **the date line is simply omitted**, never fabricated from another
field. `customer_feedback.created_at` is `NOT NULL DEFAULT now()`, so in practice it is never
missing. `delivered_at` **is** legitimately nullable: a booking can be featured without ever having
had a `'Delivered'` status event logged (e.g. very old data that predates this trigger, or a data
gap) — that row's `get_featured_deliveries()` output correctly returns `delivered_at: null`, and the
card shows no date rather than guessing one. Verified directly in the pgtest suite (`a booking with
no logged Delivered event reports delivered_at as NULL, not a fabricated date`).

## 4. Database/API changes and why

One migration, `20260915150000_add_delivered_at_to_featured_deliveries.sql`:
- `DROP FUNCTION`/`CREATE FUNCTION public.get_featured_deliveries()` — adds `delivered_at
  TIMESTAMPTZ` to the return table via a correlated subquery against `order_status_events`
  (`SELECT MIN(e.changed_at) FROM order_status_events e WHERE e.order_id = o.id AND e.status =
  'Delivered'`). Re-grants `EXECUTE` to `anon, authenticated` (required after `DROP FUNCTION`,
  matching the pattern already used by the migration this one follows).
- **No broadened public access**: `order_status_events` itself gains no new grant and no RLS policy
  change — it was never directly reachable by `anon` and still isn't. The function is already
  `SECURITY DEFINER` and already anon-executable; this only adds one more derived, non-sensitive
  timestamp to its existing output (no `note`, no `changed_by`, no other status's timestamp, no
  order internals).
- **No new column**: reuses an existing, already-authoritative table instead. If a future need ever
  requires a truly separate "delivery completed" concept (distinct from "the order first showed
  Delivered status" — e.g. a partial/split delivery model), that would be a genuinely new business
  concept warranting its own column and write path at that time; nothing here forecloses that.
- `getFeaturedDeliveries()` in `src/lib/database.js` needed **no change** — it already returns RPC
  rows unmodified, so `delivered_at` passes through automatically.
- `getPublicFeedback()` also needed **no change** for the feedback date — `created_at` was already
  in its return shape from the prior task's migration.

## 5. Horizontal feedback layout — implementation notes

- **Native scroll, no carousel library**: `.about-reviews-scroll` is a flex row with `overflow-x:
  auto`, `scroll-snap-type: x mandatory`, `scroll-snap-align: start` per card, and a 14px gap.
  Mobile card width is `flex: 0 0 82%` (a sliver of the next card stays visible at the row's own
  edge); desktop is a fixed `340px` per card so several fit per the available width. No new
  dependency was added.
- **Nav buttons**: rendered in JSX only when `filteredFeedback.length > 1` *and* the row is actually
  measured as overflowing (`scrollWidth > clientWidth`, tracked via a `scroll`/`resize`-driven
  `feedbackScrollState`), and additionally hidden by CSS below 641px so mobile always relies on
  native swipe alone, never buttons. A single review renders no buttons and no peek (there is no
  second card to peek at), satisfying "hide unnecessary navigation controls" for that case.
- **Filter reset**: a `useEffect` keyed on `selectedRating` calls `scrollTo({left: 0})` on the row
  and recomputes nav-button state, so switching filters always starts back at the first matching
  card.
- **Keyboard access**: the scroll row itself is `tabIndex={0}` (native arrow-key scrolling once
  focused, standard browser behavior for a focusable scrollable element) with a visible
  `:focus-visible` outline; the Prev/Next buttons are ordinary `<button>` elements, focusable and
  operable with Enter/Space by default — verified directly (focusing the Next button and pressing
  Enter moved the row).
- **"Access to all published reviews"**: there was no pre-existing pagination/incremental loading —
  `getPublicFeedback()` already loads every published review in one call. Horizontal scroll doesn't
  hide anything; every filtered card is reachable by scrolling (mouse, touch, keyboard, or the nav
  buttons), so this requirement is met by the native scroll itself, not a new loading mechanism.
- **Rating filter**: chips (unchanged markup/behavior) render inside `.about-filter-chips`; a
  `CustomSelect` dropdown (reused verbatim from `src/components/ui/CustomSelect.jsx` — no new
  component) renders inside `.about-filter-select-wrap`. Both are always in the DOM; a `max-width:
  640px` CSS rule swaps which one is visible, so there is exactly one `selectedRating` state and no
  duplicated filtering logic.
- **Card design**: padding 32px→20px, radius 24px→20px, removed the oversized decorative quote
  glyph and `font-style: italic` on the review text (the customer's original wording is now shown
  verbatim, unstyled), and removed the `hero-testimonial` grid-spanning special case for the first
  card — it doesn't have a meaning in a uniform horizontal row.
- **Long reviews**: `getReviewExcerpt()` truncates past 220 characters at the nearest earlier word
  boundary and appends "…"; a "Read more" text-button opens `ReviewModal` (a focus-trapped,
  Escape-closable dialog reusing the existing `FocusTrap`/`useScrollLock` primitives already used by
  the page's `Lightbox`) showing the full, unmodified message, rating, reviewer, and its submission
  date. No internal card scroll area was introduced.
- **Feedback photos**: unchanged from the prior task — `get_public_feedback()` carries no photo
  field, and this task did not add one. No admin delivery-proof photo is attached to a feedback
  card.

## 6. Verification results

All of the following were run in this session against the **real, unmodified**
`src/pages/public/AboutPage.jsx` component, served by `npm run dev` and driven by Playwright
(`chromium`, real Chrome) with the Supabase REST/RPC/Storage endpoints intercepted via
`page.route()` and served **fixture data only** — no live database was read or written, and the
app's own service-worker registration was disabled for the test session so nothing could bypass the
mocks. 40 + 6 = 46 assertions, all passing:

- Desktop (1280px): chip filter visible, dropdown hidden, no page-wide horizontal overflow, Next
  button visible and keyboard-operable (focus + Enter scrolls the row), filtering to 5★ shows
  exactly the matching cards and resets scroll to 0, "Read more" opens the modal with the correct
  date, Escape closes it.
- Mobile 320px / 375px / 390px: dropdown visible, chips hidden, nav buttons hidden, no page-wide
  horizontal overflow, the first card visibly peeks the next one, and programmatic scroll actually
  moves the row (swipe-equivalent).
- Tablet (820px): no page-wide horizontal overflow.
- Zero reviews: the existing "No customer feedback has been submitted yet." empty state, no cards
  rendered; zero highlights also correctly renders no `#highlights` section at all (unchanged
  behavior from the prior task).
- One review: exactly one card, both nav buttons hidden.
- Empty filter result: "No 1-star reviews found." shown.
- **Dates**: a feedback row's `created_at` renders as "Reviewed Sep 15, 2026"; a featured
  shipment's `delivered_at` renders as "Delivered Sep 14, 2026"; a highlight with `delivered_at:
  null` shows no date at all (not a fabricated one).
- **Midnight boundary**: a feedback submission at `2026-09-14T23:58:00+08:00` renders as "Reviewed
  Sep 14, 2026" (not the 15th); one two minutes later, at `2026-09-15T00:02:00+08:00`, renders as
  "Reviewed Sep 15, 2026" — proving the PH-timezone conversion, not the UTC day, decides the
  displayed date. A `delivered_at` of `2026-09-14T23:50:00+08:00` likewise renders as "Delivered
  Sep 14, 2026".
- Long customer name and long featured-shipment title/caption: render without breaking the layout
  or introducing page-wide horizontal overflow, at both desktop and 375px.

Server-side (`npm run test:featured-shipments`, PGlite/real-migration pgtest, 33/33 passing,
5 new): `delivered_at` matches the logged `'Delivered'` event and not any other status; a later,
unrelated admin edit to the featured card does not change it; a hypothetical re-entered
`'Delivered'` status reports the **first** occurrence, not the latest; a booking with no logged
delivery event reports `NULL`; a near-midnight timestamp round-trips through the RPC as the exact
same instant (the PH-calendar-day conversion itself is `formatPhDate()`'s job, covered above in the
browser tests).

Full project chain (`npm run check` — smoke check, axe-lint, token-lint, every existing contract
test/pgtest, edge-function build test, photo-fallback browser test, production build, PWA-offline
test) — all still pass, no regressions.

**Not performed / limitations**: no test against a real Supabase dev/staging project with genuine
disposable booking/feedback records — this sandbox has no live project credentials scoped for
writing test data, and the task explicitly prohibits creating fake public reviews or touching real
customer timestamps, so the mocked-network approach above (real component, real CSS, fake data,
zero live writes) was the closest available substitute. Recommend one manual pass against a
dev/staging project before shipping: create a disposable Delivered booking, advance it through
statuses on different calendar days, submit feedback on a third date, feature it on a fourth, and
confirm the two dates shown match the delivery-status-change date and the feedback-submission date
respectively — exactly the pgtest's own scenario, just against real Postgres end-to-end. Dark-theme
rendering of the new elements was not separately screenshotted (existing `var(--*)` tokens were
reused throughout, so it should follow the page's existing light/dark handling, but this wasn't
visually confirmed in dark mode specifically).

## 7. Local vs. deployed

Everything in this task is **local, uncommitted changes**. Nothing has been committed, pushed, or
deployed; `supabase db push` has not been run. The new migration is additive and read-only (no data
touched) and safe to deploy independently of the frontend: shipping it first only adds a column the
old frontend doesn't read yet (harmless); shipping the frontend first just means the date briefly
renders as absent until the migration lands (the `highlight.delivered_at &&` guard fails safe).
Deploying both together remains the cleanest order.
