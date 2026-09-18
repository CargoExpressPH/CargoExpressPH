# CargoExpress PH — Findings Verification Report

**Review type:** Independent, read-only QA audit of SYSTEM_FLOW_AND_LOGIC_REVIEW.md
**Baseline commit:** `4f31f96` on `main` (2026-09-18, working tree clean)
**Original report's reviewed commit:** `af027f7` — one commit earlier. No application code changed between them (only docs added). All findings remain applicable.
**Scope:** Code inspection + source-contract analysis. No live browser test, no real Supabase Auth test, no data written.

---

## Verification Summary Table

| # | Original Finding | Evidence Checked | Test / Reproduction Result | Final Classification | Impact | Smallest Recommended Next Step |
|---|---|---|---|---|---|---|
| 1 | Financial example misrepresents the user's scenario | §4.3 of report vs. user's exact numbers | Correct two-refund scenario is present but buried in a footnote; single-refund promoted as primary | **Documentation Error** | Low — formula is correct | Promote the correct two-refund scenario to primary example |
| 2 | `get_sales_overview_data()` still uses `updated_at` | `20260916140000` lines 21-25, 86-89, 162-187; `20260918010000` lines 186-268 | **Confirmed.** `get_financial_report_data()` fixed in `20260918010000` with `COALESCE(succeeded_at, provider_updated_at, updated_at)`. `get_sales_overview_data()` has only ONE definition (migration `20260916140000`) and still uses raw `updated_at` everywhere | **Confirmed Bug** | Medium-High | Apply same COALESCE fix to `get_sales_overview_data()` |
| 3 | Retroactive repricing of weighed-but-untripped orders | `20260915130000` trigger lines 122-131; `20260911030000` pickup RPC line 107 | **Confirmed Reachable Bug.** Pickup requires status IN ('Pending','Assigned','Pending Review') — no trip_id check. So Pending→Picked Up (no trip) is a valid path. When additional payment recorded, `amount_paid` changes, trigger fires, `global_price_per_kilo()` reads the CURRENT rate, repricing happens silently. | **Confirmed Bug** | Medium-High | Remove `OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid` from repricing condition (line 124 of that trigger) |
| 4 | Customer can rewrite admin chat message content | `20260801010000` RLS WITH CHECK; `20260831070000` trigger `guard_chat_message_update` lines 116-124 | **NOT exploitable.** The BEFORE UPDATE trigger explicitly raises exception '42501' if `NEW.message IS DISTINCT FROM OLD.message`. RLS policy alone is insufficient but the trigger closes the gap completely. | **Confirmed Intended Behavior** (defense-in-depth: policy + trigger) | None | Correct report: change "Suspected (Medium)" to "Confirmed secure via trigger layer" |
| 5 | Password/email change doesn't invalidate other sessions | `AuthContext.jsx` lines 530-537, 549-567; `@supabase/supabase-js` v2.104.1 | **Confirmed gap in code.** No `signOut({ scope: 'others' })` call exists. Server-side refresh-token revocation behavior on password change is UNVERIFIED (no live Auth test run). | **Confirmed Potential Risk** (server-side behavior UNVERIFIED) | Medium | Add `await supabase.auth.signOut({ scope: 'others' })` after successful `updateUser` calls |
| 6 | Activity-log retry queue survives logout | `activityLog.js` lines 3-5, 31-43; `AuthContext.jsx` lines 29-36, 476-483 | **Confirmed.** `clearSupabaseAuthStorage()` only removes keys starting with `sb-` or `supabase.auth.token`. Key `cargoexpress.activity-log.queue.v1` is NOT removed. Queue self-expires at 7 days. | **Confirmed Bug** | Low-Medium | Add `localStorage.removeItem('cargoexpress.activity-log.queue.v1')` to logout try-block |
| 7 | "Remember Me" only saves email, not session length | `LoginPage.jsx` lines 69-167; `supabase.js` line 112 `persistSession: true` | **Confirmed UX Clarity Issue.** `persistSession: true` is hardcoded regardless of checkbox. Checkbox only persists the email string. | **Confirmed Intended Behavior** (UX mislabeling, not security) | Low | Rename label to "Remember my email" |
| 8 | Broad admin profile-update DB permission | No column-level GRANTs found on profiles; trigger only guards role for non-admins | **Confirmed Pattern.** Admin can update any profile column via raw API. UI never exposes this. | **Potential Risk** (low exploitability — admins are trusted) | Low | Out of defense scope; note as future hardening |
| 9 | Duplicate phone numbers allowed | No UNIQUE constraint on `profiles.phone` in any migration | **Confirmed.** No constraint exists. | **Potential Risk / Business Decision** | Low | Owner decides: add UNIQUE or accept |
| 10 | PDF renders unbounded rows | Source code inspection only | **Confirmed in code, not live-tested.** PDF path uses same in-memory data with no row cap. | **Potential Risk** (unverified live impact) | Medium with large datasets | Add row cap warning before PDF generation |
| 11 | Report says "100% accurate", "Confirmed safe", "Cannot be bypassed" | Throughout the report | **Overstatements confirmed.** These are unqualified absolute claims unsupported by live testing. | **Documentation Error** | Low | Replace with qualified language per correction table below |
| 12 | Tests described as "in-memory PostgreSQL" | `package.json`; test files using `@electric-sql/pglite` | **Accurate but incomplete.** The Wasm PostgreSQL engine applies real migration SQL. But it does not test Auth, Storage, Edge Functions, or network behavior. | **Documentation Error** (minor) | Low | Add explicit caveat: "These tests verify SQL contracts, not live Supabase behavior." |

---

## Confirmed Bugs — Detailed Evidence

### BUG 1: `get_sales_overview_data()` uses `updated_at` (NOT `succeeded_at`)

**File:** `supabase/migrations/20260916140000_financial_report_rpc.sql`

**Evidence:**
```sql
-- Line 21 (get_financial_report_data, OLD definition — superseded):
SELECT pr.id, pr.order_id, pr.amount, ..., pr.updated_at as event_date, ...

-- Lines 86-89 (get_sales_overview_data — STILL ACTIVE, never superseded):
SELECT (updated_at AT TIME ZONE 'Asia/Manila')::date as day, ...
FROM payment_refunds
WHERE status = 'succeeded'
  AND updated_at >= p_start_date AND updated_at < p_end_date
```

**Fixed version (get_financial_report_data, migration 20260918010000):**
```sql
-- Line 210:
COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) as event_date,
-- Lines 215-216:
AND COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) >= p_start_date
AND COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) < p_end_date
```

`get_sales_overview_data()` was NEVER redefined in any later migration. It remains on the original `updated_at` logic.

**Expected:** Both functions bucket refunds by the immutable `succeeded_at` timestamp.
**Actual:** Sales Overview uses `updated_at`, which moves on any duplicate webhook touch.

---

### BUG 2: Retroactive Repricing of Weighed, Trip-less Orders

**File:** `supabase/migrations/20260915130000_guard_contact_details_lock_at_trigger_level.sql`

**Exact repricing condition (lines 122-131):**
```sql
IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight
   OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
   OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid   -- ← THIS CAUSES THE BUG
   OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount THEN
  weight := COALESCE(NEW.actual_weight, 0);
  price := CASE
    WHEN NEW.trip_id IS NOT NULL THEN public.effective_trip_price(NEW.trip_id)
    ELSE public.global_price_per_kilo()   -- ← reads the CURRENT rate at call time
  END;
  NEW.shipping_cost := ROUND(weight * price, 2);
```

**Reproduction path (all steps are supported by current RPCs):**
1. Order status is `Pending` (no trip assigned).
2. Admin calls `record_pickup_payment(...)` → status becomes `Picked Up`, `actual_weight` is set.
3. Admin changes company `default_price_per_kg` in Company Information.
4. Admin calls `record_additional_payment(...)` on that order.
5. `amount_paid` changes → trigger fires → `global_price_per_kilo()` returns the NEW rate → `shipping_cost` is silently overwritten.

**Minimal fix:** Remove `OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid` from the repricing IF condition. Payment changes should never trigger price recalculation; only weight or trip changes should.

**Regression test needed:** Pickup a tripless order, change the global rate, record a payment, assert `shipping_cost` equals `original_weight × original_rate`.

---

### BUG 3: Activity Log Queue Not Cleared on Logout

**File:** `src/lib/activityLog.js` line 3; `src/contexts/AuthContext.jsx` lines 29-36, 476-483

**Evidence:**
```javascript
// activityLog.js line 3:
const QUEUE_KEY = 'cargoexpress.activity-log.queue.v1';

// AuthContext.jsx lines 29-36 (the ONLY auth storage cleanup function):
const clearSupabaseAuthStorage = () => {
  Object.keys(localStorage)
    .filter(k => k.startsWith('sb-') || k === 'supabase.auth.token')
    .forEach(k => localStorage.removeItem(k));
  // ← 'cargoexpress.activity-log.queue.v1' is NOT matched by these filters
};

// AuthContext.jsx lines 476-483 (the logout cleanup block):
clearBookingDraftStorage(signedInUserId);
clearSupabaseAuthStorage();           // clears sb-* keys only
clearPasswordRecoveryPending();
sessionStorage.removeItem('fcm_asked');
// ← QUEUE_KEY is never cleared here
```

**Who can exploit this:** Someone with DevTools access on a shared computer. Not a remote attack.

**Minimal fix:** Add one line to the logout try-block:
```javascript
localStorage.removeItem('cargoexpress.activity-log.queue.v1');
```

---

## Finding 4 CORRECTED: Chat Message Content IS Protected

The original report classified this as "Suspected — not confirmed with a live browser test."

**This is inaccurate. The protection is confirmed from code.**

The trigger `chat_messages_guard_customer_update` (migration `20260831070000`, lines 140-144) fires BEFORE UPDATE on every row. Its body (lines 116-124):

```sql
IF NEW.id IS DISTINCT FROM OLD.id
   OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
   OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
   OR NEW.sender_role IS DISTINCT FROM OLD.sender_role
   OR NEW.message IS DISTINCT FROM OLD.message      -- ← explicit content guard
   OR NEW.created_at IS DISTINCT FROM OLD.created_at
THEN
  RAISE EXCEPTION 'Customers may change only the read state of a chat message'
    USING ERRCODE = '42501';
END IF;
```

A customer UPDATE that passes the RLS policy (correct conversation) but changes `message` WILL raise exception '42501' at the trigger level before the row is written. This is not defeatable from the browser.

**Corrected classification:** Confirmed secure via two-layer defense (RLS policy + BEFORE trigger). Report should be updated from "Suspected (Medium)" to "Confirmed: not exploitable at the database layer."

---

## CORRECT Financial Example (replaces the primary example in §4.3)

The user's exact scenario, fully traced through the database formula:

```
Setup:
  Original shipping fee:    ₱35,000
  Discount applied:          ₱1,000
  Final charge (payable):   ₱34,000

After ONE payment of ₱20,000 (cash, at pickup):
  gross_paid             =  ₱20,000
  successful_refunds     =       ₱0
  net_paid               =  ₱20,000
  remaining_balance      =  ₱34,000 − ₱20,000 = ₱14,000
  payment_status         =  'partial'

After Cash refund ₱10,000 AND GCash refund ₱10,000 (both succeeded):
  gross_paid             =  ₱20,000  (same — no new payment)
  successful_refunds     =  ₱20,000  (₱10k + ₱10k)
  net_paid               =  ₱20,000 − ₱20,000 = ₱0
  remaining_balance      =  ₱34,000 − ₱0 = ₱34,000
  payment_status         =  'unpaid'
  Note: booking is still ACTIVE. The company has returned all collected money.

After a NEW ₱20,000 payment:
  gross_paid             =  ₱40,000
  successful_refunds     =  ₱20,000  (unchanged)
  net_paid               =  ₱40,000 − ₱20,000 = ₱20,000
  remaining_balance      =  ₱34,000 − ₱20,000 = ₱14,000  ← the expected answer
  payment_status         =  'partial'
```

This follows directly from the trigger formula:
`remaining_balance = MAX(order_payable_amount(shipping_cost, discount_amount) − amount_paid, 0)`
where `amount_paid` is maintained as `SUM(payment_transactions) − SUM(succeeded refunds)`.

---

## Overstatement Corrections

| Location in report | Original text | Corrected text |
|---|---|---|
| §4.1, §4.2, §4.7 | "Confirmed safe" | "Protected at the database level against [specific attack]. No live browser test was performed to rule out all attack paths." |
| §4.2 | "Cannot be bypassed even by a raw admin API call" | "The [specific constraint] in [migration file] enforces this at the database layer, blocking even direct API calls that bypass the UI. Other admin-callable paths were not exhaustively enumerated." |
| §9 | "all scripts passed, exit code 0" (implies correctness) | "All scripts passed with exit code 0. These tests verify SQL contracts against an in-memory Wasm PostgreSQL engine (pglite). They do not test Supabase Auth, Storage, Edge Functions, or browser behavior. Confirmed bugs #2 and #3 above are NOT covered by any existing test." |
| §4.3 | "100% accurate" (implied for balances) | "Computationally exact for the trigger formula and migration logic inspected in this review. Live Supabase behavior was not tested." |
| §4.7 | "Confirmed safe — no dangerouslySetInnerHTML found" | Accurate and appropriate — this is a specific, verifiable code check. No change needed. |

---

## Taglish Summary

### Ano ang totoong bug? (Confirmed Bugs)
1. **Sales Overview refund date (Medium-High):** Yung "Sales Overview" tab ay gumagamit pa rin ng `updated_at` para sa refunds. Kapag nagpadala ulit ang PayMongo ng duplicate webhook — kahit wala namang nagbago sa refund — ang date na makikita sa Sales Overview ay pwedeng mag-iba. Naayos na ito sa "Reports" tab pero hindi pa sa "Sales Overview."
2. **Retroactive repricing (Medium-High):** Pwede kang mag-pickup ng isang order KAHIT walang trip na na-assign. Kapag binago ng admin ang presyo per kilo pagkatapos, at nag-record ng additional payment sa ganoong order, ang `shipping_cost` ng customer ay nababago nang walang babala. Ito ang pinaka-konkretong technical bug na kailangan i-address.
3. **Activity log queue hindi nacle-clear sa logout (Low-Medium):** Ang mga nakaqueue na log entries ay nananatili sa browser localStorage pagkatapos mag-logout. Pwedeng makita ng susunod na gumamit ng parehong computer sa DevTools.

### Ano ang report lang ang mali? (Documentation Errors)
- **Chat message tampering (Finding #4):** HINDI ito "Suspected" — CONFIRMED na HINDI exploitable. May trigger (`guard_chat_message_update`) na nagmo-monitor sa bawat column, at magra-raise ng error kapag sinubukan pang palitan ang `message` content, kahit pumasa ang RLS policy.
- **Financial example:** Yung primary example sa report ay nagpapakita ng wrong scenario. Ang tamang dalawang-refund computation (₱10k + ₱10k refund, tapos bagong ₱20k payment = ₱14k balance) ay tama — kailangan lang na gawing primary example.
- **Overstatements:** Maraming "Confirmed safe", "Cannot be bypassed", "100% accurate" na walang qualification. Kailangan palitan ng mas specific na language para hindi mapalo ng panel.

### Ano ang hindi pa natin alam? (Unverified)
- **Server-side session revocation on password change:** Alam natin na walang `signOut({ scope: 'others' })` sa code, pero hindi pa natin natiyak kung ang Supabase server mismo ay automatic na nagre-revoke ng refresh tokens ng ibang devices kapag nagpalit ng password.
- **PDF performance with large data:** Hindi pa natin nasusubukan ang PDF export na may libo-libo rows.

### Ano lang ang kailangan BAGO ang defense?
**Dapat gawin (report corrections, walang code change):**
1. I-correct ang financial example sa §4.3 — gawin primary yung two-refund scenario.
2. I-correct ang Finding #4 sa master list — palitan "Suspected (Medium)" ng "Confirmed: not exploitable via trigger layer."
3. I-revise ang mga overstatements sa buong report.

**Optional (1-line code fixes, kung may oras):**
- Alisin ang `OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid` sa repricing trigger para maayos ang retroactive repricing.
- Dagdagan ng isang `localStorage.removeItem(...)` sa logout para macle-clear ang activity log queue.
