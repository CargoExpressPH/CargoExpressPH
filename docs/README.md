# CargoExpress PH Documentation

This directory is the navigation point for the project’s technical documentation. The
compiled reviewer is the short current-state overview; the source documents remain
available in their purpose-based folders for evidence and detailed follow-up.

## Start here

- [Compiled reviewer](./guides/CARGOEXPRESSPH_COMPILED_REVIEWER.md) — current-state architecture, workflows, security, payments, operations, and defense Q&A.
- [Repository cleanup report](./REPOSITORY_CLEANUP_REPORT.md) — this reorganization’s scope, evidence, retained uncertainty, and verification results.
- [Technical overview](./architecture/TECHNICAL-OVERVIEW.md) — detailed system walkthrough.
- [Database design](./architecture/database_design.md) — schema-oriented reference; migrations remain authoritative.
- [Go-live guide](./operations/GOLIVE_GUIDE.md) — deployment and release checklist.

## Document map

| Section | Use it for | Primary entry points |
|---|---|---|
| [Guides](./guides/) | System orientation, reviewer material, module coverage, customer/service and refund guidance | [Complete system guide](./guides/CARGOEXPRESSPH_COMPLETE_SYSTEM_GUIDE.md), [defense reviewer](./guides/CARGOEXPRESSPH_DEFENSE_REVIEWER.md) |
| [Architecture](./architecture/) | Current architecture, datastore, ERD, and event-flow references | [Technical overview](./architecture/TECHNICAL-OVERVIEW.md), [database architecture review](./architecture/DATABASE_ARCHITECTURE_REVIEW.md) |
| [Operations](./operations/) | Retention, storage monitoring, implementation notes, and release readiness | [Backend automation and retention](./operations/BACKEND_AUTOMATION_AND_RETENTION_GUIDE.md), [go-live guide](./operations/GOLIVE_GUIDE.md) |
| [Audits](./audits/) | Findings, fixes, verification reports, UX reviews, payment/refund and security audits | [Security audit](./audits/SECURITY_AUDIT_2026-08-17.md), [system flow review](./audits/SYSTEM_FLOW_AND_LOGIC_REVIEW.md) |
| [Archive](./archive/) | Historical proposals, superseded designs, rollback notes, and rationale retained for traceability | [Payment redesign v2](./archive/payment-redesign-v2.md), [technical-debt rationale](./archive/WHY_FIX_TECHNICAL_DEBT.md) |

## Reading rules

- `supabase/migrations/` is the database source of truth. Narrative schema files and older reports are useful context, not proof of the live schema.
- A report or proposal is not evidence that a feature is deployed. Confirm implementation in source, migrations, tests, and the target environment.
- The public payment-return page verifies a short-lived hashed capability through the backend and does not make `orders` or `payment_attempts` public.
- Links to historical paths inside older audit narratives may describe the repository as it existed when that report was written; the cleanup report records those cases.
- `CLAUDE.md` remains the repository working brief and is intentionally kept at the root.

## Special documentation outside this map

The root [README](../README.md) is the project introduction. The repository also retains
focused readmes next to operational or fixture directories, including
[`tests/README.md`](../tests/README.md), [`public/icons/README.md`](../public/icons/README.md),
and [`supabase/migrations_archive/README.md`](../supabase/migrations_archive/README.md).
