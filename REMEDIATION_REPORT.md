# CargoExpress PH — Remediation of the Validation and Trappings Audit

**Date:** 2026-09-22 (Asia/Manila) · **Branch:** `main` · **Scope:** local working tree only

> **Nothing was committed, pushed, deployed, or applied to any database.**
> No production write, real payment, refund, email, push notification or
> cleanup job was triggered. The four new migration files exist on disk and
> have been executed only against throwaway in-memory PostgreSQL instances.

---

## 1. Evidence classes used in this report

Every claim below is labelled with one of these. They are not interchangeable.

| Label | Means |
|---|---|
| **Source** | Read in the code. Not executed. |
| **Structural** | A test asserting the shape of source/SQL text (e.g. "this guard exists"). Not executed behaviour. |
| **Executable DB** | Run against real compiled PostgreSQL (PGlite, in-memory, **single connection**) with the real migration files applied. Real behaviour; no concurrency, no live RLS/Auth. |
| **Pure-function** | Real JS behaviour of an imported module, executed in Node. |
| **Real concurrent** | Two or more genuine PostgreSQL connections. **Not available in this environment — nothing in this report carries this label.** |
| **Browser** | A real rendered page. **Not performed.** |
| **Live** | The deployed site/project. **Not performed, not claimed.** |

---

## 2. Findings fixed, with evidence

### F-01 — Anonymous tracking leaked the exact fee and the full cargo description · **FIXED LOCALLY**

**What was wrong.** `20260922120000_trip_start_dates_and_actual_arrival.sql` dropped and recreated `track_order_public()` to add four trip-timing columns, and while doing so copied a wider projection than the one `20260806000000_harden_public_rpcs.sql` had deliberately established. The recreated function returned `o.shipping_cost` and the **complete** `o.package_description` to the `anon` role. Tracking numbers are `CE-YYYYMMDD-XXXX` — roughly 10,000 guesses per shipping day — so anything this function returns is effectively enumerable without a session. The `/track` page's 45-second refresh cooldown is browser behaviour and is not a rate limit; a direct PostgREST RPC call ignores it.

**Verified by inspecting the RPC response, not the UI.** The audit's screenshot showed masked names and no fee, but the fields were present in the backend payload regardless of what the page chose to render.

**Fix** — `supabase/migrations/20260922140000_restore_public_tracking_privacy.sql`:
- `shipping_cost` **removed from the return type entirely** — not masked, not rounded, not bucketed: absent.
- `package_description` re-truncated to 40 characters + `…`, restoring the previously hardened projection.
- **Preserved**: masked sender/receiver names, status, origin/destination, `actual_weight`, `estimated_delivery`, and all four trip-timing columns (`trip_departure_date`, `trip_departure_at`, `trip_estimated_arrival_at`, `trip_arrived_at`) that the timeline needs. The tracking layout is unchanged.
- Still `SECURITY DEFINER`, still `REVOKE ALL ... FROM PUBLIC`, still granted only to `anon, authenticated`. **No anonymous `SELECT` on `orders` was granted.**

**Documented limitation — truncation is not anonymisation.** Stated in the migration header and asserted in the test: a description of 40 characters or fewer survives truncation *intact*. `mask_name()` reduces but does not eliminate identifiability. `actual_weight` and the route remain visible by design because the page shows them. The only real control over bulk enumeration is a rate limit at the API/edge boundary, which this repository does not contain.

**Full detail is unchanged for authorised callers.** Customers and admins never use this RPC; they read `orders` through the owner-or-admin RLS `SELECT` policy (`getOrders` / `getOrderById`), which still returns the exact fee and the untruncated description.

**Consumers checked before changing the signature** (Source): `src/lib/database.js :: getPublicTrackingResult` (untyped `.rpc()` wrapper); `src/pages/public/TrackingPage.jsx` (reads the description, weight and four trip fields — **never** `shipping_cost`, confirmed by grep); `scripts/trip-start-dates-pgtest/run.mjs` (selects only the trip columns); `scripts/smoke-check.mjs` (name reference only). Nothing broke.

**Other anonymous endpoints inspected** (Source): `get_public_order_events` → `(status, changed_at)` only; `get_trips_load` → aggregate kg per trip, no per-order data; `get_featured_deliveries`, `get_public_feedback` → admin-curated/moderated, masked names; `get_public_business_profile` → the company's own public details. **None returns a money value or free-text cargo description; no change needed.**

**Evidence:** Executable DB — `npm run test:public-tracking-privacy`, **32/32**. Fixture carries a long description *and* an exact ₱9,876.54 fee; assertions read the RPC result set as `anon` and check for column *absence*, plus one assertion that no returned value equals the fee, plus a negative check that `anon` cannot `SELECT` from `public.orders`.

**Deployed state: unverified.** I cannot and do not claim the live site is or is not affected.

---

### F-02 — Pickup RPC silently accepted a negative amount · **FIXED LOCALLY**

**What was wrong.** `record_pickup_payment()` only wrote a ledger row under `IF COALESCE(p_amount, 0) > 0`. A negative amount fell through that branch: the order moved to `Picked Up` with **no payment row**, as if the admin had deliberately collected nothing. `record_delivery_payment()` had rejected negatives since `20260915100000`; pickup was the odd one out, so a direct authenticated RPC call bypassed the only check that existed (the browser's).

**Fix** — `20260922150000_pickup_payment_amount_guards.sql`: an explicit rejection placed **before the row is even locked**, so invalid input cannot touch the booking, the discount or the ledger. The whole RPC is one transaction, so the `RAISE` leaves everything unchanged.

**Preserved zero/NULL cases** (each asserted): `NULL` amount (Pay Later), explicit `0`, Freight Collect (`payer_type = 'receiver'`), fully discounted bookings, and payments already reconciled through PayMongo (the client sends no amount at all in that case).

**Evidence:** Executable DB — `npm run test:pickup-payment-amount`, **60/60**. `-0.01` and `-25` both rejected; each asserted to leave status, `actual_weight`, `shipping_cost` and the ledger untouched.

---

### P-01 → **Overpayment: decided and implemented**

#### There is no existing tip/excess model — verified, not assumed
I searched the migrations, `supabase/schema.sql` and all of `src/` for `tip`, `tips`, `tip_amount`, `gratuity` and `excess`. The only hits were CSS class names (`fp-tips-box`, `trk-empty-tip`). **No tip column, table, RPC or reporting concept exists.** Per the brief I did **not** invent one and did **not** disguise a tip as a shipping payment. A proposal is in §7.

#### The exact implemented behaviour

**Backend is the enforcement point.** `record_pickup_payment()` refuses a collection above the amount still payable:

```
payable     = GREATEST(shipping_cost − discount_amount, 0)      -- after the weight is written
paid_before = SUM(payment_transactions where paid|partial) − SUM(payment_refunds where succeeded)
outstanding = GREATEST(payable − paid_before, 0)
reject if   p_amount > outstanding + 0.005
```

- **It is computed from authoritative pricing, not a stale balance or a frontend figure.** A new booking has no price; `shipping_cost` is derived by `guard_order_update()` from `actual_weight × the trip's effective rate` the moment the weight lands, and the discount is written by the same statement. So the check deliberately runs **after** the `UPDATE` and re-reads the order — that is the first instant an authoritative payable exists. It is post-weighing, post-discount and refund-aware.
- **The rejection rolls everything back.** Weight, status, discount and ledger are left exactly as they were; nothing is half-applied.
- **`0.005` tolerance** — the same one `record_additional_payment()` and `record_delivery_payment()` already use. It absorbs half-centavo rounding in the weight × rate product, not a real overpayment. Asserted both ways: `700.004` accepted, `700.01` rejected.
- **A rejected attempt does not consume its idempotency key**, so the admin can correct the amount and resubmit. Asserted.

**The message (server and browser use the same wording):**

> The entered amount exceeds the amount still payable by ₱100.00. Please check the amount. Extra money is not automatically recorded as a tip.

The server error adds a `DETAIL` breaking the figure down (fee less discount less payments already received) and a `HINT` telling the admin to correct the amount.

**Browser behaviour — and one deliberate asymmetry:**

| Flow | `expectedAmount` is… | Panel behaviour | Server |
|---|---|---|---|
| **Delivery** (`capAtExpected: true`) | `remaining_balance`, read from the DB after weighing/discount — **authoritative** | Warns **and blocks** submission | `record_delivery_payment()` rejects (pre-existing) |
| **Pickup** (`capAtExpected: false`) | `weight × price-per-kilo` **preview** | **Warns only**, does not block | `record_pickup_payment()` rejects — the real stop |
| **Additional payment** | `remaining_balance` from the DB — authoritative | Warns and blocks | `record_additional_payment()` rejects (pre-existing) |

Pickup is not capped in the browser on purpose. The brief said not to place an estimated-fee cap on a checkout flow without checking how final pricing is established — and it is established server-side, after weighing. Capping on the estimate would reject legitimate collections, which is exactly why `capAtExpected: false` was set originally. That flag is unchanged. The pickup warning says so explicitly: *"This booking has not been weighed yet, so this figure is an estimate — the final amount is computed when the weight is saved, and a collection above it will be refused then."*

**A silent clamp was removed.** `PaymentCollectionPanel`'s amount field used to rewrite itself to `expectedAmount` whenever a larger number was typed. That hid the very mistake this work has to surface, and at pickup it silently *shrank* a legitimately larger collection down to a pre-weighing estimate. The typed value is now kept and the excess is reported.

**Bypassing the warning cannot create a silent shipping overpayment** — the database refuses it. **A tip is never counted toward the shipping balance and never included in a shipping refund**, because no tip can be recorded at all. Total-money records stay truthful: nothing is written that is not the shipping money it claims to be.

**PayMongo money already received is never erased or falsely failed.** A payment confirmed by the provider was inserted by the webhook's reconcile RPC in a separate, already-committed transaction. This function does not touch, reverse or relabel those rows — it only *counts* them when working out what is still owed, and only ever refuses the new amount being entered now. A pickup finished after a PayMongo settlement sends no amount and never reaches the check. Asserted: after a ₱700 webhook settlement the pickup completes, the row is still `paid`, and a further ₱100 cash attempt is rejected **without touching the settled row**.

**Evidence:** Executable DB — `npm run test:pickup-payment-amount` (60/60, includes the ₱1,000/₱1,100/₱100 example, the post-discount case, refund-awareness, the PayMongo cases and retry idempotency). Pure-function + Structural — `npm run test:overpayment-warning` (27/27).

---

### P-02 → **Name validation: policy chosen and implemented**

**What was wrong.** `validateName()`'s comment claimed it allowed letters "including diacritics", but its regex was ASCII plus a hand-picked Spanish subset — `Å`, `ł` and most of Unicode were rejected. Registration used a completely different, laxer check (non-blank, 2+ characters). **No check existed server-side at all**, so a direct API call could write any string into a name column.

**The chosen policy** (this application's rule, explicitly **not** a definition of a valid human name — real names contain characters this refuses):

| | |
|---|---|
| **Allow** | Unicode letters of **any** script + combining marks; spaces; periods (initials/suffixes); hyphens and apostrophes, incl. the typographic `U+2019` |
| **Reject** | digits, emoji, every other symbol/punctuation (commas and backticks, which the old regex allowed, are now refused); anything with no letter at all |
| **Require** | at least one letter; 2–100 characters (existing bounds kept) |
| **Trim** | surrounding whitespace ignored for every check |

Hyphens and apostrophes are included on your instruction. Read strictly, "reject other punctuation/symbols" would have excluded `Maria Santos-Reyes` and `O'Brien` — both ordinary here, and the first is already a fixture in this repo's test suite.

**Unicode normalisation is handled.** Both halves normalise to **NFC** before testing, so a decomposed `José` (macOS dead-key: `J-o-s-e` + `U+0301`) validates identically to the precomposed form. Verified empirically that PostgreSQL's POSIX `[[:alpha:]]` is fully Unicode-aware on a UTF-8 database (`ñ`, `Ł`, `日` match; an emoji does not). **NFC is used only for the test — no stored value is rewritten.**

**Applied consistently** via one shared validator (`src/utils/validation.js :: validateName`) and one shared SQL function (`public.is_valid_person_name(TEXT)`):

| Surface | Enforcement |
|---|---|
| Registration | `RegisterPage` now calls the shared `validateName()` instead of its own laxer check |
| Customer profile / personal info | already used `validateName()` — now the corrected one |
| Customer booking (sender/receiver) | already used `validateName()` |
| Admin-created booking | already used `validateName()` |
| Contact-detail editing | `update_order_contact_details()`'s `UPDATE` fires `guard_order_update()`, which enforces the policy |
| **Backend write paths** | `prepare_order_insert()` (new bookings), `guard_order_update()` (every order UPDATE, incl. a raw `.update()` bypassing the RPC), `guard_profile_write()` (profile renames) |

**Not applied to** company names, emails, addresses, package descriptions or Facebook handles — those keep their own looser rules, untouched.

**Legacy data is neither rewritten nor frozen.** There is **no `UPDATE` statement in either migration**. Every backend check is gated on the value *actually changing*, so a booking or profile carrying a pre-policy name can still be paid, assigned, picked up, delivered, cancelled, and have its phone/address/status edited. Only a write that *changes a name to* a non-conforming value is refused. Blank last names stay legal (the `20260922100000` backfill produced them for genuine mononyms). Asserted in both directions.

**One deliberate exception:** `profiles` **INSERT** is left unvalidated. That row is created by the auth-signup trigger, and raising there would leave an `auth.users` record with no profile — a half-finished account is worse than a badly formatted name. Registration is validated in the browser; any later edit hits the UPDATE check.

**Evidence:** Pure-function + Executable DB — `npm run test:person-name-policy`, **76/76**. Accepts `María Santos`, `Juan Dela Cruz`, `J. Santos`, `José Peña`, `Maria Santos-Reyes`, `O'Brien`, `Åse Løken`, `Zofia Wróbel-Łuk`, a mononym, a decomposed NFD name. Rejects `Juan123`, `...`, whitespace-only, emoji-only, emoji-mixed, `Cruz, Juan`, `` Juan`s ``, `a@b`, `Juan_Cruz`, `--`, and the length bounds.

---

## 3. Finding left UNVERIFIED — R-01, the capacity race

**Nothing was changed. No locking rewrite was introduced.**

**Why it is unverified.** A genuine concurrent PostgreSQL environment is not available here, and I confirmed this rather than assuming it:
- `psql`, `pg_ctl`, `postgres` and `docker` are all absent from `PATH`.
- `pg` (node-postgres) is not a dependency.
- PGlite is a **single** Postgres backend compiled to WASM. A probe of two overlapping transactions produced the interleaving `A begin → A commit → B begin → B commit` — the second cannot start until the first commits. A single-connection engine can neither exhibit nor rule out a lost-update race.

**Sequential tests do not prove concurrency safety**, so I did not treat the passing capacity suites as evidence either way, and did not write a speculative fix.

**The suspicion (Source only).** `guard_order_update()` reads `SUM(actual_weight)` over the *other* orders on the trip, while `SELECT * INTO trip_row FROM public.trips` is a plain read with no `FOR UPDATE`/`FOR SHARE`. The `UPDATE` locks only the order being changed. Under `READ COMMITTED` (Supabase's default) two transactions updating **different** orders on the **same** trip each aggregate the other's pre-update weight, so both can pass a check their combined effect violates.

**Reproduction script provided:** `scripts/trip-capacity-race/two-session-race.mjs` (`npm run test:trip-capacity-race`). It exits 2 with a clear SKIP until `DATABASE_URL` points at a throwaway instance and `pg` is installed. It opens **two real connections**, reproduces the capacity block verbatim (same aggregate, same self/`Cancelled` exclusions, same 200 kg allowance, authorization and constraints left enabled) and runs:
- **Scenario 1 (must both succeed):** two concurrent updates that together fit. A fix must not break this.
- **Scenario 2 (the race):** remaining permitted load 100 kg; two different orders each add 80 kg concurrently. Correct behaviour is exactly one commit.

```bash
docker run --rm -e POSTGRES_PASSWORD=pw -p 5433:5432 postgres:15
npm i --no-save pg
DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres npm run test:trip-capacity-race
```

**If it reproduces**, the fix (designed, not implemented) is per-trip coordination taken **before** the `SUM` — `SELECT ... FROM public.trips WHERE id = NEW.trip_id FOR UPDATE`, or `pg_advisory_xact_lock` on the trip id. **Lock ordering matters for reassignment:** moving between two trips must lock both in a deterministic order (e.g. ascending uuid), or two simultaneous swaps in opposite directions deadlock. The coordination would have to cover every writer of the load — `guard_order_update()` (pickup weight, assignment, reassignment), `prepare_order_insert()` and `reassign_trip()`. None of that is justified until the script reproduces the failure.

---

## 4. Files changed and added

**New migrations (forward-only; no applied migration was edited):**

| File | Purpose |
|---|---|
| `20260922140000_restore_public_tracking_privacy.sql` | F-01 — drop `shipping_cost`, re-truncate the description |
| `20260922150000_pickup_payment_amount_guards.sql` | F-02 + P-01 — reject negatives; cap at the authoritative payable |
| `20260922160000_person_name_policy.sql` | P-02 — `is_valid_person_name()`, `prepare_order_insert()`, `guard_profile_write()` |
| `20260922170000_person_name_policy_order_updates.sql` | P-02 — `guard_order_update()` (kept separate; it reproduces a long function) |

**Source changed:**

| File | Change |
|---|---|
| `src/utils/validation.js` | `validateName()` rewritten to the chosen policy, NFC-normalised, fully documented |
| `src/pages/auth/RegisterPage.jsx` | Registration now uses the shared `validateName()` |
| `src/utils/paymentCollection.js` *(new)* | The panel's pure rules extracted from the `.jsx` so Node tests can execute them; adds `overpaymentMessage()`, `excessAmount`, `blocksOnExcess` |
| `src/components/ui/PaymentCollectionPanel.jsx` | Re-exports the above (existing imports unchanged); renders the live overpayment warning; **silent clamp removed** |
| `src/components/ui/AdditionalPaymentModal.jsx` | Uses the shared overpayment wording |
| `package.json` | Four new test scripts wired into `npm test`; one manual script |
| `VALIDATION_AND_TRAPPINGS_AUDIT.md` | Classifications updated per finding |

**Tests added:** `scripts/public-tracking-privacy-pgtest/run.mjs`, `scripts/pickup-payment-amount-pgtest/run.mjs`, `scripts/person-name-policy-test.mjs`, `scripts/overpayment-warning-contract-test.mjs`, `scripts/trip-capacity-race/two-session-race.mjs` (manual).

**Unrelated work preserved.** `DATABASE_SIMPLIFICATION_PLAN.md` and `DATABASE_TABLE_AND_COLUMN_AUDIT.md` are untouched and identical to `HEAD` (they are tracked and committed in `e17fece`; the session's opening snapshot listing them as untracked was stale). The two pre-existing audit probe scripts are left in place. No service-worker stamp was hand-edited.

---

## 5. Tests run

| Command | Result | Class |
|---|---|---|
| `npm test` (43 scripts, incl. 4 new) | **PASS**, exit 0 | mixed |
| `npm run check` (test + 20 Edge builds + photo-fallback + production build + PWA offline) | **PASS**, exit 0 | mixed |
| `npm run test:public-tracking-privacy` | **32/32** | Executable DB |
| `npm run test:pickup-payment-amount` | **60/60** | Executable DB |
| `npm run test:person-name-policy` | **76/76** | Pure-function + Executable DB |
| `npm run test:overpayment-warning` | **27/27** | Pure-function + Structural |
| `npm run test:payment-ledger` | 52/52 | Executable DB |
| `npm run test:shipping-discount` | 95/95 | Executable DB |
| `npm run test:delivery-cash-payment` | 47/47 | Executable DB |
| `npm run test:contact-details-lock` | PASS | Executable DB |
| `npm run test:service-area-mass-assignment` | 12/12 | Executable DB |
| `npm run test:trip-start-dates` | 26/26 | Executable DB |
| `npm run test:trip-capacity-selection` | PASS | Structural |
| `npm run test:financial-reports` | PASS | Executable DB |
| `npm run test:cancellation-settlement` | 23/23 | Executable DB |
| `npm run test:legacy-rpc-overload-cleanup` | 8/8 | Executable DB |
| `npm run build` | **PASS** | build |
| `npm run test:trip-capacity-race` | **SKIPPED (exit 2)** — no concurrent environment | — |
| Playwright E2E (`npm run test:e2e`) | **NOT RUN** — needs a live Supabase project | — |
| Browser / device / PayMongo / email / push | **NOT PERFORMED** | — |
| Applying migrations to any database | **NOT PERFORMED** | — |

### Limitations, stated plainly
1. PGlite is **single-connection**. Nothing here says anything about concurrency.
2. PGlite tests scaffold fixture tables; they are not the live schema, and they do not exercise Supabase Auth, PostgREST or real RLS.
3. The overpayment UI test is pure-function + source assertions. **The warning was never rendered in a browser.**
4. `npm test` exercises `record_pickup_payment` with the new migration in the new suite; the older `shipping-discount` suite still pins its own pre-existing migration list and was left unchanged (it passes 95/95 as before).
5. **No claim is made about the deployed site** for any finding.

---

## 6. Impact on other modules

| Module | Impact |
|---|---|
| Public tracking + timeline | Response is narrower. Layout and timeline unchanged; `TrackingPage` never read `shipping_cost`. **Any other consumer of the RPC's shape must be re-checked before deploying** — the return type changed. |
| Customer/admin private booking detail | **None.** Those read `orders` under RLS; full fee and full description unchanged. |
| Pickup + partial payments | A collection above the final payable is now refused (new). Partial payments, promise dates and Pay Later unchanged. |
| Discounts / zero collections | Unchanged. Fully discounted and zero-collection pickups still work; the cap is measured post-discount. |
| PayMongo reconciliation + retries | Unchanged. Confirmed payments are never touched, reversed or relabelled. Idempotent retries still no-op; a *rejected* attempt does not burn its key. |
| Sales / refund calculations | Unchanged — and protected: refusing excess money keeps shipping revenue and refundable amounts truthful. |
| Capacity, assignment, reassignment, trip readiness | **Unchanged.** No locking change was made. |
| Registration / profile / contact editing | Names now share one policy. Legacy names are not rewritten and do not block unrelated edits. Commas and backticks in *new* names are now refused — a real, intended narrowing. |
| `PaymentCollectionPanel` consumers | `PickupModal` / `DeliveryModal` / `AdditionalPaymentModal` unchanged in their imports; pure rules moved to `src/utils/paymentCollection.js` and re-exported. |

---

## 7. Proposal — optional tip / excess-collection recording (NOT built)

There is no tip model today, and I did not invent one. If you want to accept tips, here is what it would actually cost. **Do not adopt this by half** — a tip recorded as a shipping payment is worse than no tip feature.

**Storage.** A separate `excess_collections` table (`id`, `order_id`, `amount`, `collected_by`, `collected_at`, `method`, `reference`, `notes`, `idempotency_key`). **Not** a column on `orders` and **not** a row in `payment_transactions` — the ledger's entire meaning is "shipping money owed and paid", and the balance trigger, the settlement gate and the refund caps all derive from it. A tip must not move `amount_paid`, `remaining_balance` or `payment_status` by a single centavo.

**Capture.** Recording an excess would need an explicit second confirmation, separate from the amount field — the admin states *"₱100 of this is a tip"*, rather than the system inferring it from an overpayment. The RPC would accept `p_excess_amount` alongside `p_amount`, validate `p_amount` against the payable exactly as it does now, and write the excess to the separate table.

**Reporting.** Tips are real money received, so they belong in a daily cash-reconciliation total — but **not** in shipping revenue. `get_sales_summary` and the period reports would need a distinct "other collections" line. Mixing them would silently overstate freight income.

**Refunds.** A tip must never be included in a shipping refund. The refund caps (per-payment and per-order) derive from `payment_transactions`; keeping tips out of that table keeps them out of those caps automatically. Refunding a tip would be a separate, explicit action.

**Honest recommendation.** Unless tips are common enough to justify a reporting line, a separate accounting concept and a refund rule, the simpler answer is the one now implemented: refuse the excess, tell the admin why, let them correct it, and handle any genuine gratuity outside the system.

---

## 8. Paliwanag sa simpleng Taglish

**Ano ang inayos:**

1. **Public tracking** — dati, kahit walang login, kung alam (o nahulaan) mo ang tracking number, makikita ang **eksaktong shipping fee** at ang **buong laman ng package description** sa sagot ng server. Hindi ito halata kasi hindi naman ipinapakita sa page — pero nandoon sa data. Tinanggal ko na ang bayad, at binalik ko ang dating **40 characters lang** na description. Nanatili ang masked na pangalan, status, ruta at ang mga oras ng biyahe — hindi nagbago ang hitsura ng tracking page. Pero **hindi garantiya ang pagputol ng text**: kung maikli lang talaga ang description, buo pa rin itong lalabas. Ang totoong solusyon sa mass-guessing ay rate limit sa server — wala pa niyan.

2. **Negative na bayad** — dati, kung may magpapadala ng negative amount diretso sa RPC (hindi sa normal na screen), tuloy pa rin ang pickup pero **walang naitatalang bayad**. Tinanggihan na ngayon. Okay pa rin ang **Pay Later, Freight Collect, zero, at fully discounted** — hindi sila naapektuhan.

3. **Sobrang bayad** — kung ang inilagay ay mas mataas sa dapat bayaran, may **babala** na:
   > "The entered amount exceeds the amount still payable by ₱100. Please check the amount. Extra money is not automatically recorded as a tip."

   Puwedeng itama ng admin ang amount. Ang mahalaga: **wala pong tip system ang sistema na ito** — sinuri ko, wala talaga. Kaya kung tatanggapin ang sobra, maitatala 'yun bilang ordinaryong bayad sa shipping — sasama sa sales report at puwedeng ma-refund bilang shipping. Mali 'yun sa libro. Kaya **tinatanggihan** ito ng database mismo, hindi lang ng screen.

   Sa **pickup**, babala muna ang lalabas (hindi haharang agad) kasi **estimate pa lang** ang presyo bago matimbang — ang totoong bayarin ay kinukuwenta ng database pagkatapos ma-save ang timbang. Doon ang tunay na harang. Sa **delivery** at **additional payment**, harang na agad kasi galing na sa database ang balanse.

   **Ang bayad na kumpirmado na ng PayMongo ay hindi nawawala at hindi minamarkahang failed.** Binibilang lang ito kung magkano pa ang utang.

4. **Pangalan** — dati magkaiba ang panuntunan: sa register, kahit ano basta 2 letra; sa booking, ASCII at kaunting Spanish letters lang, kaya tinatanggihan ang ibang totoong pangalan. Ngayon **iisa na** ang panuntunan sa register, booking, admin booking, profile at sa **database** mismo:
   - **Pwede:** letra ng kahit anong wika (`ñ`, `á`, `é`), espasyo, tuldok (`J. Santos`), gitling (`Santos-Reyes`), apostrophe (`O'Brien`)
   - **Bawal:** numero (`Juan123`), emoji, kuwit, at ibang simbolo; at kailangang may kahit isang letra — bawal ang puro tuldok o puro espasyo
   - **Hindi ko binago o binura ang mga lumang pangalan.** At kung may lumang pangalan na hindi pasok sa bagong rule, **puwede pa ring i-update ang ibang detalye** (phone, address, status) — ang bawal lang ay palitan ang pangalan ng bago na hindi pasok.

**Ano ang HINDI ko inayos:** ang **capacity race** (kapag sabay-sabay ang dalawang update sa iisang biyahe). Hindi ko po ito napatunayan kasi **walang totoong dalawahang koneksyon sa PostgreSQL** dito — single-connection lang ang test tool. Ayokong mag-ayos ng bagay na hindi ko pa napapatunayan, kaya **script** ang binigay ko para ma-test kapag may tunay na database na.

**Mahalagang paalala:** **walang na-deploy, walang na-commit, walang tunay na bayad o notification.** Lahat ng test ay lokal. **Hindi ko po masasabi kung apektado ang live na website** — hindi ko sinuri ang deployed na server.

---

## 9. Reviewing this locally

```bash
cd /Users/beasarong/Downloads/CargoExpressPH-main

# 1. The four new tests, individually
npm run test:public-tracking-privacy    # 32 checks — anon RPC response fields
npm run test:pickup-payment-amount      # 60 checks — negative + overpayment guards
npm run test:person-name-policy         # 76 checks — validator + DB enforcement
npm run test:overpayment-warning        # 27 checks — panel rules + wording

# 2. Everything, plus the production build
npm run check

# 3. The capacity race (needs a THROWAWAY Postgres — never production)
docker run --rm -e POSTGRES_PASSWORD=pw -p 5433:5432 postgres:15
npm i --no-save pg
DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres npm run test:trip-capacity-race

# 4. The app
npm run dev      # http://localhost:5173
```

**What to look at in the running app** (this was **not** browser-verified — please check it yourself):
- `/track` with a real tracking number → the timeline, dates, masked names and truncated description should look exactly as before. *The fee removal is a backend change and is invisible here — that is the point; confirm it with the test in step 1, or with DevTools → Network on the `track_order_public` call.*
- Admin → an order → **Confirm Pickup** → type an amount above the estimated total → an amber warning appears under the field naming the excess and saying it is not a tip; the field is **not** silently rewritten.
- Admin → **Mark as Delivered** and **Record Payment** → typing above the balance blocks submission with the same wording.
- Register / Book a Shipment / Personal Information → try `José Peña`, `Maria Santos-Reyes`, `J. Santos` (accepted) and `Juan123`, `...`, an emoji (rejected).

**The four migrations are files only.** Applying them (`supabase db push`) is a separate, deliberate step against a linked project — not done here, and not something to do against production without reviewing the changed `track_order_public` return type with every consumer first.
