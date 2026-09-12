# F-008 — Fix plan: drop stale legacy payment RPC overloads

- **Status:** ✅ Implemented 2026-09-12, approved and applied to the repository
- **Supersedes/formalizes:** F-005-legacy-payment-rpc-overloads.md
- **Severity:** HIGH (elevated from the original report's MEDIUM — see Impact)
- **Confidence:** CONFIRMED (re-verified against current `main`, 2026-09-12)
- **Area:** PostgreSQL payment API surface

## Bug / Issue Description

Three admin-only payment RPCs have accumulated multiple live, executable,
`SECURITY DEFINER` overloads because each hardening migration used
`CREATE OR REPLACE FUNCTION` while **adding trailing parameters** — which
Postgres treats as a distinct function (a new entry in `pg_proc`) rather than
a true replacement, since the argument signature changed. No migration has
ever issued a matching `DROP FUNCTION` for the superseded signatures, so all
of the following remain deployed, granted to `authenticated`, and callable by
any admin session today:

| Function | Live overloads (arg count) | Introduced in |
|---|---|---|
| `record_pickup_payment` | 12 (old) | `20260803100000_atomic_order_payment.sql` |
| | 14 (old) | `20260909030000_manual_payment_hardening.sql` |
| | 17 (**current**) | `20260911030000_record_pickup_payment_discount.sql` |
| `record_delivery_payment` | 10 (old) | `20260828120000_delivery_promise_date_guard.sql` |
| | 12 (**current**) | `20260912010000_discount_aware_manual_settlement.sql` |

Re-verified directly against the migration files (not merely re-read from the
prior report):

- No `DROP FUNCTION` targeting any of these old signatures exists anywhere in
  `supabase/migrations/*.sql` (confirmed by grep across the full migration
  history).
- `20260828120000_delivery_promise_date_guard.sql:126-127` explicitly issues
  `GRANT EXECUTE ON FUNCTION public.record_delivery_payment(UUID, JSONB, TEXT,
  NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE) TO authenticated;` — this grant
  is never revoked; later migrations only revoke/grant the *new* signature,
  which Postgres treats as unrelated.
- `20260911030000_record_pickup_payment_discount.sql:22-36` contains an
  explicit author comment acknowledging both older overloads as "harmless
  orphans" and deferring cleanup as "a separate, unrelated piece of debt" —
  confirming this is known, intentionally-deferred technical debt, not an
  oversight discovered only by this audit.
- `record_additional_payment` was checked separately and does **not** have
  this problem — both of its historical definitions
  (`20260909030000`, `20260912010000`) share the exact same 9-parameter
  signature, so `CREATE OR REPLACE` genuinely replaced it each time. No action
  needed for that function.

## Root Cause

Postgres function overloading resolves by full signature (name + argument
types/count). `CREATE OR REPLACE FUNCTION` only replaces a function whose
signature matches exactly; adding a trailing parameter (even with a
`DEFAULT`) creates a co-existing sibling function rather than replacing the
original. Every hardening pass to date has added new trailing parameters
(idempotency key, admin-verified-receipt flag, discount fields) without a
paired `DROP FUNCTION` for the exact old signature, so the API surface has
grown monotonically instead of being replaced in place.

## Impact

This is **not** an anonymous/unauthenticated bypass — every overload,
old and new, independently enforces `IF NOT public.is_admin() THEN RAISE
EXCEPTION` internally. The risk is scoped to an authenticated admin session
(or a compromised/shared admin credential) calling an old signature directly
via `POST /rest/v1/rpc/<function_name>` with only the old parameter set,
bypassing the current React frontend entirely.

Cross-referencing against the fixes verified for F-002/F-004 in this same
review cycle, the practical consequence is more serious than the original
report's MEDIUM label suggests: calling the **old 10-argument**
`record_delivery_payment` skips the discount-aware balance calculation added
in `20260912010000` (reintroducing the exact bug fixed in F-002), has no
idempotency protection (a double-submit can double-credit a cash/manual
payment), does not enforce the "no cash after pickup" rule, and does not
enforce the delivery-photo/lifecycle checks added later. Similarly, the old
12-/14-argument `record_pickup_payment` overloads lack discount handling,
manual-GCash verification, and idempotency. In effect, F-005/F-008 is the one
finding that can silently re-open F-002 and F-004 for any caller who reaches
for the wrong signature — which is why this plan raises its severity to HIGH.

The current frontend (`src/lib/database.js:2621,2651`) only ever calls the
current signatures — confirmed by grep — so there is no risk to normal
application usage today. The exposure is to direct API/script/tooling access
using an admin token.

## Recommended Fix / Integration Plan

**1. Drop the exact stale signatures** (new migration,
`supabase/migrations/<timestamp>_drop_legacy_payment_rpc_overloads.sql`):

```sql
-- record_delivery_payment — 10-arg legacy signature (20260828120000)
DROP FUNCTION IF EXISTS public.record_delivery_payment(
  UUID, JSONB, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, DATE
);

-- record_pickup_payment — 12-arg legacy signature (20260803100000)
DROP FUNCTION IF EXISTS public.record_pickup_payment(
  UUID, NUMERIC, TEXT, TEXT, JSONB, DATE, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT
);

-- record_pickup_payment — 14-arg intermediate signature (20260909030000)
DROP FUNCTION IF EXISTS public.record_pickup_payment(
  uuid, numeric, text, text, jsonb, date, numeric, text, date, text, text, text, uuid, boolean
);
```

Each `DROP` will be preceded, during implementation, by a direct
`\df+ public.record_pickup_payment` / `pg_proc` signature check against the
target environment (exactly as this review's verification did) to guarantee
an exact match before executing — the same caution the original migration
author cited as their reason for deferring this cleanup.

**2. Confirm no other caller exists** before dropping — already partially
done in this review (grep of `src/lib/database.js`, `scripts/*.mjs`,
`supabase/functions/**`); will be repeated as a final check immediately
before applying the migration, since this is a destructive, hard-to-reverse
schema change.

**3. Add a schema-hygiene regression test** — extend
`scripts/security-hardening-contract-test.mjs` (or a new
`scripts/payment-rpc-signature-test.mjs`) with a query against
`information_schema.routines`/`pg_proc` asserting exactly one signature
exists for `record_pickup_payment`, `record_delivery_payment`, and
`record_additional_payment`. This makes any future trailing-parameter change
fail loudly unless the old signature is explicitly dropped in the same
migration.

**Regression risk:** Low-to-moderate. Low because the current frontend never
calls the old signatures (verified). Moderate because this is a destructive
`DROP FUNCTION` against a live production schema — if any external tool,
script, or cached client build *does* still call an old signature, it will
begin failing immediately after this migration is applied. Recommend running
`supabase db push` against a staging/dev project first and confirming via the
existing pgtest harnesses (`scripts/payment-ledger-pgtest`,
`scripts/shipping-discount-pgtest`) before applying to production.

**Estimated effort:** Small — three `DROP FUNCTION IF EXISTS` statements with
exact signatures, plus one new hygiene test.

---

## Implementation Record (2026-09-12)

**What shipped**, exactly as planned:

1. `supabase/migrations/20260912040000_drop_legacy_payment_rpc_overloads.sql`
   — three `DROP FUNCTION IF EXISTS` statements with exact signatures copied
   verbatim from each retiring migration's own historical `REVOKE`/`GRANT`
   statement (not reconstructed from memory), removing the 10-arg
   `record_delivery_payment` and the 12-arg and 14-arg `record_pickup_payment`
   overloads. `record_additional_payment` was re-confirmed to have only ever
   had one signature and was correctly left untouched.
2. `scripts/legacy-rpc-overload-cleanup-pgtest/` (`run.mjs`, reusing
   `scripts/shipping-discount-pgtest/harness-schema.sql` as its base) — a new
   regression suite. **8/8 passing.**
3. Wired into `package.json` as `npm run test:legacy-rpc-overload-cleanup`.
4. `audit_reports/F-005-legacy-payment-rpc-overloads.md` updated to point at
   this fix.

**A finding made during test-writing, worth recording:** my original plan
assumed a caller still using the old (fewer) named parameters would get a
hard `function does not exist` error after the drop. That is wrong — and the
actual behavior is better than what was planned. Postgres's named-argument
overload resolution picks whichever candidate needs the fewest defaulted
parameters among those whose parameter *names* the call supplies. Since the
current signatures are supersets of the old ones (same parameter names, plus
new ones with defaults), a call naming only the old subset now resolves
**transparently to the current, safer function** (using its defaults for
`p_idempotency_key`/`p_admin_verified_receipt`/`discount_*`) once the old
signature is gone — it neither errors nor silently uses degraded logic.
Verified directly: `scripts/legacy-rpc-overload-cleanup-pgtest/run.mjs`'s
final scenario calls both functions using only the retired parameter names
and confirms the payment is correctly recorded through the current function.
This is exactly consistent with how `supabase.rpc()` calls (always by
parameter name, never positionally) actually behave in production.

**Verification performed:**
- `node scripts/legacy-rpc-overload-cleanup-pgtest/run.mjs` — 8/8 passed,
  including: both retired signatures genuinely coexisting before the fix
  (3 pickup overloads, 2 delivery overloads — confirmed via `pg_proc`),
  exactly one signature per function after the fix, the current signatures
  continuing to work end-to-end (pickup → delivery, discount-aware), and the
  old-named-parameter-call behavior described above.
- `npm test` (17 static/contract checks) — passed, unaffected.
- `npm run test:shipping-discount` (92/92), `test:payment-ledger` (52/52),
  `test:payment-notifications` (41/41) — all still passing; these suites use
  their own curated migration lists and do not load this new migration, so
  this confirms no regression to the existing suites rather than directly
  exercising the new one (that is what the new dedicated pgtest is for).
- Whether this migration has actually been `supabase db push`-ed to the live
  production project was **not** verified — requires
  `supabase migration list --linked` against the real project, outside the
  scope of this local implementation pass. Given this is a destructive
  `DROP FUNCTION`, running it against staging/dev first and confirming via
  this same pgtest before applying to production is strongly recommended.
