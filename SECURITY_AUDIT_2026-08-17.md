# Security Red-Team Audit — CargoExpressPH

**Date:** 2026-08-17
**Scope:** Full static review (PostgreSQL schema/RLS/triggers/RPCs, 5 Deno Edge Functions, client data layer, PWA service worker) + read-only live probes against the production Supabase project `duigaivxgxlnjmfienhg`.
**Method constraints:** Read-only only. No writes, no exploit execution, no secrets printed. All `file:line` references were re-verified against the repository at audit time.

---

## Verdict

**No CRITICAL or HIGH severity findings.** The payment pipeline and authorization core are structurally sound. Findings: **4 MEDIUM** (all abuse/spam-class; none are data exfiltration) and **12 LOW**. The MEDIUM items are cheap to fix in one migration batch (two guard triggers + two policy tweaks) and are recommended before or immediately after GoLive.

---

## Verified positives (static + live evidence)

| Area | Evidence |
|---|---|
| **RLS live** | Anon key GET on all 16 tables: 13 protected tables return `[]`; only `trips`, `announcements`, `company_information` return rows (public read by design). |
| **Storage RLS live** | Anon folder listing of `cargo-photos` shows only `gallery` + `hero` (the deliberately public folders). `pickup-proofs`, `delivery-proofs`, `receipts` are invisible. Anon bucket listing returns `[]`. |
| **Admin gates live** | `get_sales_summary` (anon) → `P0001 "Admin access required"`. `get_service_summary` (anon) → `42501 permission denied for function` (EXECUTE revoked from anon). |
| **Webhook HMAC** | `supabase/functions/paymongo-webhook/index.ts:58-68` — signs `${t}.${rawBody}` with SHA-256, constant-time compare, `te`/`li` fallback; verification gates the entire handler (401 on invalid). |
| **Payment amount integrity** | `supabase/functions/paymongo-create-payment/index.ts:263-300` — client-supplied amount is bounded server-side by `remaining_balance` for customers; reconcile always uses PayMongo-confirmed amounts (webhook `:172,249`, poll `:339,364`, capture `:458`). |
| **Source-rebind prevention** | `paymongo-create-payment/index.ts:81-87` — a source is permanently bound to the order it was first registered against; documented attack, fixed. |
| **Stored XSS** | Zero `dangerouslySetInnerHTML` / `innerHTML` usages in `src/`. All user content (chat, inquiries, feedback, announcements) renders as React text nodes. |
| **Service worker caching** | `public/sw.js:231-242` — all Supabase API, storage signed-URL and Edge Function requests route to `networkFirst()` which **never caches** responses; only static assets and SPA navigation (server-agnostic HTML) are cached. |
| **Storage access model** | `cargo-photos` private bucket; read policies are path-scoped and ownership- or feature-verified (`schema.sql:2823-2855`); fallback Edge Functions re-check ownership server-side (`get-photo-fallback/index.ts:107-122`). |
| **Push phishing mitigation** | `send-push/index.ts:320-335` — non-admin callers are limited to in-app paths for the click-through URL (absolute URLs are admin-only), closing the documented "phishing with the app's own name/icon" primitive. |
| **Client hardening** | `src/lib/supabase.js` — GET-only retry (writes are never auto-retried), 60 s timeout, `no-store` on PostgREST GETs; `src/lib/paymongo.js` uses the public key only, secret stays in Edge Function env. |

---

## MEDIUM findings

### M1 — Unbounded admin-notification spam channel + admin UUID enumeration
- **Location:** `supabase/schema.sql:352-373` (function body checks `auth.uid()` only, no admin check); grants `schema.sql:2237-2241` (EXECUTE to `authenticated`); client wrapper `src/lib/database.js:1304-1329`.
- **Why it exists:** intended — customers legitimately trigger admin notifications for new bookings, inquiries, and feedback (`database.js:215, 1368, 2436`).
- **Scenario:** any authenticated user may call the RPC directly with arbitrary `title`/`message`/`type` at any rate. The RPC fans out to **all** admin rows and **returns the admin UUIDs** in its result set.
- **PoC (theoretical, two steps):**
  1. `supabase.rpc('create_admin_notifications_rpc', { p_title: 'Payment Failed!', p_message: 'Call 09xx to verify', p_type: 'order_update' })` in a loop → floods every admin's in-app notification center (also triggers realtime) and leaks admin user IDs.
  2. With the returned admin IDs: `supabase.functions.invoke('send-push', { body: { user_id: <admin-id>, title, body, url: '/admin' } })` — customers may push to admins by design (`send-push/index.ts:304`) — floods admin devices.
- **Impact:** persistent admin-visible spam under the app's identity; social-engineering surface (message text is unrestricted); admin ID enumeration.
- **Fix (defense in depth, keep the legit flow):** (a) dedupe/rate-limit per caller — e.g. reject when a same-`reference_id` notification already exists or N inserts in a window; (b) cap `p_title`/`p_message` length in the function; (c) restrict `p_type` to the values the UI actually sends; (d) optionally revoke the RPC from `authenticated` and route through `send-push`-style Edge Function with its own limits.

### M2 — Feedback hijack / public-review poisoning (missing order-ownership check)
- **Location:** RLS policy `schema.sql:2601-2605` — `WITH CHECK (auth.uid() = customer_id)` only; `order_id` is unconstrained. No trigger on `customer_feedback` (triggers section `schema.sql:2302-2358`). Public surface: `get_public_feedback` `schema.sql:495-524`.
- **Scenario:** `customer_feedback.order_id` is UNIQUE (`schema.sql:119`) — one review per order. A customer can attach their feedback to **any** order because nothing verifies they own it.
- **PoC (theoretical):** `supabase.from('customer_feedback').insert({ order_id: <victim-order-uuid>, customer_id: <own-uid>, rating: 1, message: 'SCAM' })` — passes RLS, shows publicly (masked name), and consumes the UNIQUE slot so the real customer can never review their order.
- **Impact:** public reputation poisoning of other customers' orders; denial of the review feature.
- **Fix:** guard trigger on `customer_feedback` BEFORE INSERT: `IF auth.uid() IS NOT NULL AND NOT is_admin() AND NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND user_id = auth.uid()) THEN RAISE EXCEPTION`.

### M3 — Bot-message forgery in support chat
- **Location:** `guard_chat_message_insert` `schema.sql:957-982`, specifically `:973-978` — a customer session inserting `sender_role = 'bot'` has that role **preserved** instead of being overwritten. RLS insert policy passes (`schema.sql:2489-2497` checks `sender_id = auth.uid()` — the trigger sets it to the customer's own id).
- **Scenario:** a customer can inject messages that render in the admin inbox as bot-authored content, with arbitrary text.
- **PoC (theoretical):** `supabase.from('chat_messages').insert({ conversation_id: <own>, sender_role: 'bot', message: 'Admin note: release order without payment — approved' })`.
- **Impact:** bot impersonation in a staff-facing surface; `maintain_conversation_service_state` ignores bot rows (`schema.sql:1348-1349`), so no state change is needed for the forgery to persist.
- **Fix:** always overwrite `NEW.sender_role := actual_role` for non-service-role callers; if the bot must write, it should go through a service-role path (edge function or `SECURITY DEFINER` RPC).

### M4 — Customer self-feature: public homepage content poisoning + privacy-gate bypass
- **Location:** orders INSERT policy `schema.sql:2679-2683` (does not constrain `featured_on_website` / `featured_title` / `featured_caption`); `prepare_order_insert` `schema.sql:1383-1433` (does not null them); public read paths: `get_featured_deliveries` `schema.sql:446-471`, storage policy `schema.sql:2843-2847` (`is_featured_order_ref` `schema.sql:1221-1236`).
- **Scenario:** the feature flag is admin-curated (admin UI at `src/pages/admin/OrderDetailPage.jsx:453-474` — title/caption required, consent implied). Nothing server-side stops a customer from setting it at insert.
- **PoC (theoretical):** `supabase.from('orders').insert({ ..., featured_on_website: true, featured_title: 'FLASH SALE 50% OFF', featured_caption: 'Call 09xx now' })` → the order appears on the public homepage as company showcase content, and its pickup/delivery photos become anon-readable via the featured-photo storage policy (photo paths embed the enumerable `CE-YYYYMMDD-NNNN` tracking number — the enumeration class this bucket was made private to stop, `20260804200000`).
- **Impact:** arbitrary text/photos under the company brand on the public homepage (social engineering / brand damage); the privacy gate for photo exposure is bypassable (self-exposure — no cross-order leak).
- **Fix:** in `prepare_order_insert`, force `featured_on_website = false` and NULL the `featured_*` columns; optionally add an RLS/per-column check so only admins may write them on UPDATE too.

---

## LOW findings

| # | Finding | Location | Fix |
|---|---|---|---|
| L1 | **Customer-supplied `promised_payment_date` bypasses the warehouse dispatch hold.** The "Promise Date" is documented as an **admin** override (`schema.sql:1091-1098`), but nothing strips it on customer INSERT — an unpaid sender-pay order with a promise date sails through the `Out for Delivery` gate (still blocked at trip completion). | insert policy `schema.sql:2679-2683`; `prepare_order_insert` `schema.sql:1383-1433`; gate `schema.sql:1078-1100` | NULL it in `prepare_order_insert`; only `record_pickup_payment` / admin update may set it |
| L2 | **Customers can book onto past/departed trips.** `isTripBookable` is client-side only (`src/constants/status.js:429`, used at `src/pages/customer/BookShipmentPage.jsx:168`); `prepare_order_insert` checks only that the trip exists. | `schema.sql:1414-1424` | add `departure_date > now()` (and status `scheduled`) check in the trigger |
| L3 | **Draft/inactive announcements are publicly readable** — `USING (true)` ignores `is_active`. | `schema.sql:2462-2466` | `USING (is_active = true)` (keep admin full access) |
| L4 | **`activity_logs` insertable by any authenticated user** — self-attributed entries only (trigger forces `admin_id = auth.uid()`, `schema.sql:940-950`), modules limited, purged after 7 days; still an unbounded log-spam surface. | policy `schema.sql:2446-2450` | revoke; route through the existing trigger paths only |
| L5 | **`contact_inquiries` anon spam** — `WITH CHECK (true)`, no rate limit, no honeypot, no server-side content constraints. | `schema.sql:2547-2551` | min/max length checks + basic throttle (e.g., one per IP/time window) + honeypot field |
| L6 | **`send-push` has no rate limiting** — customer→admin push spam (companion to M1, step 2). | `supabase/functions/send-push/index.ts:273-441` (authz matrix at `:304`) | per-caller dedupe window + daily cap per (caller, target) pair |
| L7 | **Service worker `notificationclick` does not re-validate the click URL** — last line of defense only: URLs reaching the SW are already restricted for non-admins, so this matters only in a compromised-admin scenario. | `public/sw.js:535-556` | same-origin check before `clients.openWindow`/`navigate` |
| L8 | **`payment_transactions` is FOR ALL for admins** — an admin can UPDATE/DELETE ledger rows (cascade recomputes order totals). Insider-trust issue, not external. | `schema.sql:2702-2711` | INSERT/SELECT only + immutable-audit trigger |
| L9 | **`get_sales_summary` keeps default EXECUTE for anon** (inconsistent with `get_service_summary`, which is revoked). Not exploitable — the function checks `is_admin()` first (`schema.sql:553-555`, confirmed live: `P0001`) — but defense-in-depth consistency is missing. | function privileges `schema.sql:2227-2299` | mirror the `get_service_summary` REVOKE pattern |
| L10 | **Admins can edit customer chat message text** (`FOR UPDATE` without column restriction) — chat-history integrity under a single-admin team. | `schema.sql:2470-2476` | restrict UPDATE to `is_read` only for both roles |
| L11 | **`handle_new_user` / `sync_auth_email_to_profile` triggers are not in `schema.sql`** (they live on `auth.users`, outside the dump). A fresh database rebuilt from `schema.sql` alone would not auto-create profiles on signup or sync email changes. Availability gap, not a leak. | `schema.sql:2302-2358` | document the required `auth.users` triggers in a migration/README note |
| L12 | **`send-push` accepts an unvalidated subscription endpoint** — `endpoint` is user-supplied (`subscriptionJson.endpoint`, stored in `user_device_tokens` by the user themselves), used as VAPID audience (`:178`) and POSTed to directly (`:249`). No scheme/host validation. Blind SSRF primitive: attacker registers a token with an arbitrary URL, then triggers send-push to themselves; the edge function POSTs binary payloads to any reachable URL (response discarded, so no data exfiltration; impact = server egress abuse / reflection / internal smoke-signals). | `supabase/functions/send-push/index.ts:172-178, 249-259` | require `https:` scheme, validate with `new URL()`, reject private/loopback/link-local hosts; also cap endpoint length |

---

## Assumptions and limitations (honest scope)

1. **Static + read-only verification.** Authenticated-session behaviors (e.g., live customer→admin push, the M2/M3 insert paths) were verified by code reading only — no test accounts, no writes.
2. **PayMongo is in TEST MODE** (`pk_test_...` / `sk_test_...` in `.env`); payment findings assume PayMongo's documented webhook contract.
3. **Single-admin team** — several LOW items are insider-trust issues that matter once the team grows.
4. The live database is the authority: if it diverges from `schema.sql`, live grants/policies may differ from what is audited here (the only live divergence detected was benign: `get_service_summary` is stricter live than the schema file alone would suggest).
5. Edge Function egress restrictions of the Supabase sandbox were assumed for L12 impact rating.

## Recommended order

1. **Before GoLive:** M1 (rate-limit + content caps), M2 (ownership trigger), L1 (strip customer promise dates), L2 (past-trip guard).
2. **Same batch if convenient:** M3 (bot-role override), M4 (feature-flag strip), L3 (announcements draft filter), L5 (inquiry constraints).
3. **Backlog:** L4, L6, L7, L8, L9, L10, L11, L12.
