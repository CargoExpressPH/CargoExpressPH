# F-005 — Legacy payment RPC overloads remain executable

- **Status:** Confirmed
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Verified:** 2026-09-11
- **Area:** PostgreSQL payment API surface

## Finding

Older overloaded versions of the payment RPCs remain deployed and executable by the `authenticated` role. They are protected by the admin check, but they do not contain all of the newer idempotency, GCash verification, and discount protections.

## Evidence

The live database contains these relevant overloads:

- `record_delivery_payment` with 10 arguments — older logic
- `record_delivery_payment` with 12 arguments — current logic
- `record_pickup_payment` with 12 arguments — older logic
- `record_pickup_payment` with 14 arguments — intermediate logic
- `record_pickup_payment` with 17 arguments — current logic

The live metadata confirms that each remains `SECURITY DEFINER` and executable by `authenticated`. The older overloads lack combinations of:

- idempotency-key handling
- manual-GCash verification
- discount handling
- newer payment-method restrictions

The current repository calls the newer signatures from [`src/lib/database.js`](../src/lib/database.js#L2625), while the overloads are defined and granted in [`20260909030000_manual_payment_hardening.sql`](../supabase/migrations/20260909030000_manual_payment_hardening.sql#L241).

## Safe reproduction

The overloads and their grants were enumerated from live `pg_proc` and function-privilege metadata. No payment RPC was invoked.

## Impact

This is not an anonymous customer bypass because the functions still require an admin. It is a stale privileged surface that can cause inconsistent payment behavior if an old client, script, admin tool, or future code path calls an older signature.

## Recommended fix

1. Search all repository and deployment callers.
2. Confirm only the newest signatures are required.
3. Revoke `PUBLIC` and `authenticated` execution on obsolete overloads.
4. Keep only the current signatures in the canonical schema snapshot.
5. Add a migration test that fails if deprecated payment overloads reappear.
