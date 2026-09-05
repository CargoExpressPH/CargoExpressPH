# CargoExpress PH Monitoring Page UX Audit

**Scope:** `/admin/storage-monitoring` — `StorageMonitoringPage.jsx` (tab shell), `PhotoStorageTab.jsx`, `EmailServiceTab.jsx`.
**Method:** Direct source-code inspection (frontend components, `src/lib/database.js` RPC wrappers, the underlying SQL functions in `supabase/migrations/`, and the `photo-storage-health` / `cleanup-orphaned-photos` Edge Functions). No files were modified while writing this audit.

---

## 1. Current Page Overview

The page lives behind one sidebar entry, "Storage Monitoring," and is a two-tab shell (`StorageMonitoringPage.jsx`) that switches between:

- **Photo Storage** (`PhotoStorageTab.jsx`, 639 lines) — the larger and more complex of the two, covering both live storage usage and an upload-routing control.
- **Email Service** (`EmailServiceTab.jsx`, 192 lines) — a smaller usage-counter view.

The active tab is stored in the URL (`?tab=photos` / `?tab=email`), so a shared link or a browser back-step lands on the correct tab. Both tabs already make a real effort at plain language in places ("Space used," "Space left," "What uses this space") — this is not a page written entirely in raw developer jargon. The problems are concentrated in specific spots: the page's architecture surfaces the **two backend storage providers (Supabase and Firebase) as two equally prominent, separately-explained systems**, when an ordinary admin only has one question ("is photo storage okay?"), and it exposes one **advanced operational control** (manually forcing which provider new photos use) at the same visual priority as everyday status information.

## 2. Current Data Sources

| Shown data | Where it comes from | Nature |
|---|---|---|
| Supabase space used, object count, per-bucket breakdown | `checkPhotoStorageHealth()` → Edge Function `photo-storage-health` → RPC `get_photo_storage_live_usage()` | **ACTUAL** — live-queried from Supabase Storage at the moment the page checks |
| Supabase "Plan allowance" (space limit) | Same Edge Function, from a **hardcoded table** of published Supabase plan quotas (`free: 1 GiB`, `pro/team: 100 GiB`, `enterprise/platform: no fixed quota`), matched to the plan name returned by Supabase's Management API | **ESTIMATED/REFERENCE** — Supabase's API does not expose the actual byte quota directly; this is the publicly published number for whatever plan the project is on, not a number pulled live from a metered quota endpoint |
| Firebase "Photos in use," "Estimated space used" | Same function → a Firestore aggregation query against the `photoFallbacks` collection | **ACTUAL** count of documents; the byte figure is **ESTIMATED** — converted from stored image bytes to an approximate base64 storage size, explicitly documented in code as an estimate, not an exact figure |
| Firebase "Free plan guide" (1 GB) | A constant in the Edge Function | **REFERENCE ONLY** — the publicly published Firestore free-tier number, not a value read from this project's actual Firebase billing plan (the code comment is explicit that Firestore exposes no per-collection quota API) |
| Photo counts by provider/type (Supabase/Firebase/legacy, pickup/delivery/receipt) | `getPhotoStorageSummary()` → RPC `get_photo_storage_summary()`, which classifies every `orders.pickup_photos`, `orders.delivery_photos`, and `payment_transactions.receipt_url` reference | **ACTUAL** — computed directly from the same records the rest of the app uses as proof of pickup/delivery/payment |
| Upload failures / Firebase fallbacks in the last 24h | Same summary RPC, counting `photo_storage_events` rows | **ACTUAL** |
| Recent Photo Activity table | `getPhotoStorageEvents()` → `photo_storage_events` table, realtime-subscribed | **ACTUAL** — one row per real upload, fallback, cleanup run, or mode change |
| "Where New Photos Are Saved" mode (Automatic / Force Firebase) | `getPhotoStorageMode()` / `setPhotoStorageMode()` → `photo_storage_settings` table | **ACTUAL** control, reflecting a real setting that changes upload routing behavior |
| "Check Unused Photos" preview + delete | `checkUnusedPhotos()` / `removeUnusedPhotos()` → Edge Function `cleanup-orphaned-photos`, backed by an admin-gated SQL function `list_orphaned_evidence_photos()` | **ACTUAL** — computed server-side; the exact file list is signed into a short-lived confirmation token so a client can never redirect the delete at an arbitrary path |
| Emails Sent Today / This Month | `getEmailUsageSummary()` → RPC `get_email_usage_summary()`, summing `email_usage_logs` | **ACTUAL count of what the app itself dispatched**, but see the important caveat below |
| Daily limit (100) / Monthly limit (3,000) | **Hardcoded literals inside the SQL function** (`get_email_usage_summary()`), commented as "Resend Free Plan" limits | **REFERENCE, not live-queried** — the app never calls Resend's API to ask for the account's real current limit or usage; it keeps its own local counter and compares it to the published Free Plan numbers. If the account's actual Resend plan or limits ever changed, this page would not know. |
| Recent Email Activity table | `getEmailActivityLog()` → RPC reading `email_activity_log` | **ACTUAL** — one row per individual recipient send attempt |

**Important honesty point for Step 8:** the "Refresh" button on Email Service does not contact Resend — it only re-reads the app's own local send log. This is accurate and reasonable (Resend's free tier has no admin-facing usage API this app could call), but the current page never says so, which could lead an admin to believe "Refresh" checks the real account state with the provider.

## 3. Photo Storage Monitoring

Currently shown, from top to bottom:
1. Two "health" mini-cards (`Supabase` / `Firebase Backup`), each just a Ready/Not Ready/Checking/Offline badge.
2. A status banner about whether "Automatic" or "Force Firebase Backup" routing is active.
3. Two large side-by-side cards — "Supabase Photos" and "Firebase Backup Photos" — each with its own Plan/Used/Allowance/Left grid, its own progress bar (Supabase only), its own bucket breakdown, its own footnote.
4. Four stat tiles: Supabase Photos, Firebase Photos in Use, Firebase Used (24h), Upload Failures (24h).
5. A card to change where **new** photos are saved (Automatic vs. Force Firebase Backup), including a duration picker and a reason field.
6. A static info banner explaining the automatic 6-month cleanup rule and the 85% warning threshold.
7. A paginated "Recent Photo Activity" table.

This is thorough and, in isolation, each piece is reasonably worded. The problem is **structural**: it treats "which provider" as the primary axis of the whole page, when the admin's real primary question is simpler ("is there room for new photos, and what's using it?"). Supabase is where virtually all normal photos live (Firebase is explicitly described as the automatic fallback "if Supabase cannot save one"), yet the page gives Firebase equal visual weight to Supabase throughout — two health cards, two big cards, two sets of stat tiles.

## 4. Email Service Monitoring

Currently shown:
1. A page subtitle that names the provider directly: "Track Resend usage against the Free Plan limits."
2. Two usage bars (Today / This Month) with Safe/Warning/Limit Reached badges — this part is already close to ideal: plain labels, a visible number, a colored bar.
3. Warning banners only when a limit is close.
4. A "Recent Email Activity" table (recipient, subject, status).

This tab is the more successful of the two already. Its main issues are smaller: the provider name ("Resend") and the phrase "Free Plan" appear in the primary subtitle rather than being pushed to a secondary/technical spot, and there is no acknowledgment that these are the app's own recorded counts rather than a live check against the provider.

## 5. Technical Terms That May Confuse Users

| Term as currently shown | Where | Why it's confusing |
|---|---|---|
| "Supabase" / "Firebase Backup" as section titles | Health cards, big cards, stat tiles | Names an implementation detail (which cloud backend) instead of describing the business thing (photo storage) |
| "Plan" / "Plan allowance" / "Plan unavailable" | Supabase Photos card | "Plan" implies a billing-tier concept the admin has no reason to track day-to-day |
| "object_count" surfaced as "stored files" | Supabase Photos card | Already translated reasonably, but "files" still reads as an IT term next to "photos" everywhere else on the page |
| "Live" / "Checking" / "Unavailable" badges (realtime connection status) | Health cards, storage section badges | Conflates two different ideas — "is the storage full" vs. "is my live connection to the page working" — under one badge/status vocabulary |
| "Where New Photos Are Saved" → "Automatic" / "Force Firebase Backup" | Routing control | A legitimate but advanced operational override, presented with the same visual weight as everyday status information |
| "Free plan guide" | Firebase card | Technically accurate but the distinction between "a published reference number" and "your actual limit" is easy to miss |
| "Resend", "Free Plan" | Email tab subtitle | Names the vendor and its billing tier in the primary heading text |
| "Refresh" (Email tab) | Button | Implies it re-checks with the provider; it only re-reads the app's own log |
| "bytes/GB/GiB" formatting, "included_storage_bytes," "quota_type" | Present in code, mostly already converted to GB/MB for display | Kept correctly out of the primary view already — worth confirming this stays true after changes |

## 6. Recommended Plain-Language Terms

| Technical | Plain-language replacement |
|---|---|
| "Supabase Photos" (as a section identity) | "Photo Storage" (the one, primary concept) |
| "Firebase Backup Photos" (as a co-equal section) | "Backup Photos" — kept, but demoted to a secondary/collapsed area |
| "Plan allowance" | "Total space available" |
| "Space used" / "Space left" | Kept — already plain |
| "Stored files" | "Photos saved" |
| "Supabase Photos" / "Firebase Photos in Use" (stat tiles) | Replaced entirely by **Pickup Photos / Delivery Photos / Receipt Photos** — a breakdown by *what the photo is for*, which the backend already computes (`pickup_photo_count`, `delivery_photo_count`, `receipt_photo_count`) but the page never displays |
| "Upload Failures (24h)" | "Photos That Didn't Save (Last 24 Hours)" |
| "Where New Photos Are Saved" | Kept as a heading, but moved under a "Technical Details" / advanced section, since it is a routing override, not routine information |
| "Track Resend usage against the Free Plan limits" | "See how many emails have been sent and whether we're close to a sending limit." — provider name and "Free Plan" moved to a small technical footnote |
| "Refresh" | Kept, with a footnote clarifying it reloads the app's own records, not a live check with the email provider |

## 7. Current UX Problems

1. **Two-provider symmetry.** The page gives Supabase and Firebase equal prominence (two health badges, two full-width cards, split stat tiles), even though Firebase is only ever a fallback. An admin has to read both cards fully to realize only one of them usually matters.
2. **No single "is everything okay?" answer at a glance.** There are four separate status badges (Supabase health, Firebase health, Supabase storage badge, Firebase storage badge) before the admin reaches any real numbers — none of them is a single, unambiguous "Good / Getting Full / Action Needed" answer for photo storage as a whole.
3. **Percentages shown without a plain-language read-out.** "68.42% of allowance used" is shown, but nothing next to it states in words whether that is fine or concerning (Step 6's requirement).
4. **An advanced control (routing override) sits at the same level as passive status information.** "Where New Photos Are Saved" is a real operational lever (useful if Supabase is down), but it is not something an admin should be considering during a routine check-in — it belongs in a secondary, clearly-labeled "Advanced" area.
5. **A safe, already-existing cleanup tool is easy to miss.** "Check Unused Photos" is a small outline button in the header, disconnected from the storage numbers it would affect.
6. **Available, business-meaningful data is not shown at all.** The backend already computes pickup/delivery/receipt photo counts (Step 7's exact ask: "what is using the most space?"), but the current stat tiles show provider-based counts instead.
7. **The email tab names the vendor and its commercial plan in the primary heading**, which is irrelevant to "is email sending working."
8. **Color is already paired with text almost everywhere** (badges say "Safe"/"Warning"/"Limit Reached", not just color) — this is one thing the page already does correctly and should be preserved, not reinvented.

## 8. Recommended Information Hierarchy

**Photo Storage**, answering the five questions from the brief in order:
1. How full is it? → one combined status card, one number, one bar.
2. Is it safe right now? → one plain-language status word (see §9).
3. How much space remains? → shown directly under the bar.
4. What's using the most space? → Pickup / Delivery / Receipt photo counts, in place of the provider counts.
5. Do I need to delete anything yet? → the existing "Check Unused Photos" action, promoted next to the status card, plus the auto-cleanup explanation.

Backup Photos (Firebase), Recent Photo Activity, and the routing override move to secondary position — visible, but clearly below the primary answer.

**Email Service**, answering the brief's five questions:
1. Is sending working? → one status word derived from today's failure count.
2. How many have been sent? → kept (already good).
3. Are any failing? → a failed-count callout, not just visible only inside the table.
4. Are we close to a limit? → kept (already good).
5. Do I need to do anything? → the existing warning banners, kept, worded plainly.

## 9. Recommended Status/Warning System

The codebase already has one real, backend-enforced threshold for photo storage: **85%** triggers an actual admin notification (`LOW_STORAGE_WARNING_PERCENT` in `photo-storage-health/index.ts`). The page's own progress-bar color currently escalates at 80% (warning) and 95% (error) — close to, but not identical to, that backend trigger. This audit does not change those numeric breakpoints (that would be a behavior change, not a UI wording change); it only adds a plain-language label on top of the colors that already exist:

- **Good** (< 80%) — "You have enough room for new photos."
- **Getting Full** (80–94%) — "Consider clearing unused photos soon."
- **Action Needed** (≥ 95%, or storage unavailable) — "New photos may fail to save. Please act soon."

These three labels are **new UX-only labels**, layered over the *existing* 80/95 color thresholds already in the code — no new backend rule is introduced. The existing 85% backend notification is called out in the page's technical footnote so the two numbers are not presented as contradictory.

Email Service already has an equivalent, existing three-tier scheme (Safe / Warning / Limit Reached at 75%/90%) — kept unchanged, just described in plainer surrounding text.

## 10. Safe Storage Cleanup Considerations

Traced before recommending anything: photos are referenced from `orders.pickup_photos`, `orders.delivery_photos` (JSONB arrays) and `payment_transactions.receipt_url`. The existing "Check Unused Photos" flow only targets storage objects under a tracking-number folder **that no longer matches any `orders` row at all** (i.e., truly orphaned — a cancelled booking whose record was removed, or leftover test data) — it is computed server-side by an admin-gated SQL function, and the actual delete call requires a short-lived, cryptographically signed confirmation token tied to that exact file list, so a client can never point it at a different path. **This already correctly avoids deleting anything still referenced as pickup proof, delivery proof, a payment receipt, a featured public photo, or any audit trail.**

Conclusion: **no new deletion feature should be added.** The existing cleanup action is already safe and already respects every reference this audit checked. The only change recommended here is presentation — surfacing it as a clear, plain-language action next to the storage numbers it relates to, not adding new destructive capability. Deleting a photo still referenced by an existing order (e.g., manually clearing an old delivery photo) is **not implemented anywhere in the app**, and this audit does not propose adding it — that would need a separate, deliberate decision about what happens to that order's proof-of-delivery record, which is out of scope here.

## 11. Email Monitoring Limitations

- Usage counts are the app's own dispatch log, not a live query against Resend's account — Resend does not expose a usage API this Edge Function calls. This should be stated plainly but briefly, not hidden.
- The 100/day and 3,000/month figures are hardcoded published Free Plan numbers, not detected live from the account. If the Resend plan changes, these numbers would need a code change to stay accurate — worth a one-line technical-details footnote, not a primary-view concern.
- No "last failure" / "last successful send" single data point currently exists separately from the activity table — the table itself serves this purpose already and does not need duplication.

## 12. Proposed Simplified Layout

```
PHOTO STORAGE
┌─────────────────────────────────────────────┐
│ Photo Storage            [● Good]            │
│ 68% used · 2.1 GB of 3.0 GB                  │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  (progress bar)        │
│ You have enough room for new photos.          │
│                                                │
│ What's using the space:                       │
│   Pickup photos      1,204                    │
│   Delivery photos    1,180                    │
│   Receipt photos       340                    │
│                                                │
│ [Check for Unused Photos]                     │
└─────────────────────────────────────────────┘

▸ Backup Photos (Firebase) — collapsed by default, same status pattern
▸ Advanced: Where New Photos Are Saved — collapsed, existing control unchanged
▸ Recent Photo Activity — existing table, unchanged, below the fold
▸ Technical Details — provider names, exact bytes, plan/quota source, bucket names

EMAIL SERVICE
┌─────────────────────────────────────────────┐
│ Email Service             [● Working]         │
│ Sent today: 42 / 100   Sent this month: 860/3,000 │
│ ▓▓▓▓░░░░░░  ▓▓▓░░░░░░░░                       │
│ Emails are sending normally.                  │
└─────────────────────────────────────────────┘

▸ Recent Email Activity — existing table, unchanged
▸ Technical Details — provider name, plan basis for the limits shown
```

## 13. Features to Keep

- All existing data sources, RPCs, and Edge Functions — no backend change.
- The existing "Check Unused Photos" preview → confirm → delete flow, unchanged in behavior.
- The existing "Where New Photos Are Saved" routing control, unchanged in behavior.
- The existing Recent Photo Activity and Recent Email Activity tables.
- The existing color + text badge pairing (never color alone).
- The existing 6-month auto-cleanup explanation and the existing 80/95 color thresholds.
- Realtime live updates and the offline/reconnecting handling.

## 14. Features to Simplify

- Collapse the two provider-specific "health" mini-cards into one combined photo-storage status card.
- Replace the provider-based stat tiles (Supabase Photos / Firebase Photos in Use) with the business-meaningful, already-available breakdown (Pickup / Delivery / Receipt photo counts).
- Add one plain-language status word (Good / Getting Full / Action Needed) next to the existing percentage and color.
- Rewrite the Email Service subtitle to remove the vendor name and "Free Plan" from the primary heading.
- Add one short line clarifying that email counts are the app's own record, not a live provider check.

## 15. Features to Hide Under Technical Details

- Provider names (Supabase / Firebase / Firestore / Resend) and their raw health badges.
- Exact byte figures, "Plan," "quota_type," bucket names, object counts.
- The Firebase "estimated payload" methodology note.
- The Resend Free Plan numeric limits' origin (hardcoded reference vs. live-queried).
- "Where New Photos Are Saved" routing control (kept fully functional, just moved to a secondary/expandable position, since it is an intentional operational override rather than routine status).

## 16. Features That Should NOT Be Added

- A new photo-deletion feature beyond the existing, already-safe "Check Unused Photos" flow.
- A fabricated live "quota used %" for Firebase or Resend where no such live figure is actually queryable — the page must keep clearly labeling those as estimates/references, not invent higher-confidence numbers.
- Any change to storage buckets, email provider configuration, Firebase/Supabase credentials, or numeric thresholds/quotas.
- A "developer console" style raw-JSON or log viewer — technical details stay in plain key/value rows, not raw payloads.

## 17. Final Recommendation

Implement the changes described in §12–15 as a **presentation-layer restructuring only**: reorder and regroup the same data that is already fetched, add plain-language status labels layered on the existing color thresholds, promote the pickup/delivery/receipt breakdown that the backend already computes but the UI never shows, and move the two-provider technical detail and the routing-override control into clearly labeled secondary/expandable sections. No RPC, Edge Function, table, bucket, credential, or numeric threshold changes are required or recommended.
