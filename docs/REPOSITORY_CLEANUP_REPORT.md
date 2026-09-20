# CargoExpress PH Repository Cleanup Report

**Review date:** 20 September 2026  
**Scope:** documentation organization, safe file inventory, link maintenance, and reviewer compilation  
**Database/deployment scope:** none; no migration, Edge Function, frontend deployment, or production-data operation was performed

## Executive result

The repository now has a purpose-based documentation layout:

```text
docs/
├── README.md
├── guides/
├── architecture/
├── operations/
├── audits/
└── archive/
```

The compiled reviewer is [CARGOEXPRESSPH_COMPILED_REVIEWER.md](./guides/CARGOEXPRESSPH_COMPILED_REVIEWER.md). The root [README](../README.md) now points to the documentation index rather than duplicating a second document table.

No tracked files were deleted. The root one-off scripts and `schema_output.txt` were explicitly retained because their historical or dependency relationship could not be disproven safely. The existing payment-return, payment-reconciliation, discount-guard, and Realtime implementation changes were preserved.

## Baseline and preservation

- The working branch is `main`; the current repository revision already contains the payment implementation commits `75e3790`, `6f7976a`, and `0ba3106`.
- The working tree was inspected before cleanup. The payment implementation is in `src/`, `supabase/functions/`, and `supabase/migrations/`; it was not reset, rewritten, or deployed.
- `CLAUDE.md` remains at the repository root and continues to state that migrations are authoritative, applied migrations are append-only, private data is not made public for convenience, and `/payment/return` is outside auth guards.
- No Supabase personal access token, provider secret, service-role key, customer data, or payment credential was printed or added to documentation.

## Before and after structure

| Before | After | Decision |
|---|---|---|
| Flat architecture, guide, and report Markdown under `docs/` | `docs/architecture/`, `docs/guides/`, `docs/operations/`, `docs/audits/` | Grouped by purpose and review use |
| `audit_reports/` | `docs/audits/` | Preserved audit filenames and moved them beside related audits |
| Historical proposals mixed with current references | `docs/archive/` | Retained for traceability, clearly separated from current-state guidance |
| No documentation index | `docs/README.md` | Added navigation and reading rules |
| Root README repeated selected deep links | Root README links to `docs/README.md` | Single navigation entry point |
| No compiled reviewer | `docs/guides/CARGOEXPRESSPH_COMPILED_REVIEWER.md` | Added a concise 12-section current-state reviewer |

## Moved paths

The reorganization preserved file contents except for path/link corrections needed after moving them. In the lists below, each source file moved to the same filename under the shown destination directory.

### Architecture

| Old path | New path |
|---|---|
| `docs/CARGOEXPRESS_EVENT_DIAGRAM_DATABASE_DATASTORE_GUIDE.md` | `docs/architecture/CARGOEXPRESS_EVENT_DIAGRAM_DATABASE_DATASTORE_GUIDE.md` |
| `docs/DATABASE_ARCHITECTURE_REVIEW.md` | `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` |
| `docs/TECHNICAL-OVERVIEW.md` | `docs/architecture/TECHNICAL-OVERVIEW.md` |
| `docs/database_design.md` | `docs/architecture/database_design.md` |

### Guides

| Old path | New path |
|---|---|
| `docs/ACTIVITY_LOGS_ANALYSIS_AND_DEFENSE_GUIDE.md` | `docs/guides/ACTIVITY_LOGS_ANALYSIS_AND_DEFENSE_GUIDE.md` |
| `docs/ACTIVITY_LOGS_ANALYSIS_AND_DEFENSE_GUIDE_2.md` | `docs/guides/ACTIVITY_LOGS_ANALYSIS_AND_DEFENSE_GUIDE_2.md` |
| `docs/ADMIN_REFUND_GUIDE.md` | `docs/guides/ADMIN_REFUND_GUIDE.md` |
| `CARGOEXPRESSPH_COMPLETE_SYSTEM_GUIDE.md` | `docs/guides/CARGOEXPRESSPH_COMPLETE_SYSTEM_GUIDE.md` |
| `CARGOEXPRESSPH_DEFENSE_REVIEWER.md` | `docs/guides/CARGOEXPRESSPH_DEFENSE_REVIEWER.md` |
| `CARGOEXPRESSPH_MODULE_COVERAGE.md` | `docs/guides/CARGOEXPRESSPH_MODULE_COVERAGE.md` |
| `CargoExpressPH_Final_Reviewer.md` | `docs/guides/CargoExpressPH_Final_Reviewer.md` |
| `docs/customer-service-workflow-study.md` | `docs/guides/customer-service-workflow-study.md` |
| `docs/legal-document-publication.md` | `docs/guides/legal-document-publication.md` |

### Operations

| Old path | New path |
|---|---|
| `BACKEND_AUTOMATION_AND_RETENTION_GUIDE.md` | `docs/operations/BACKEND_AUTOMATION_AND_RETENTION_GUIDE.md` |
| `docs/GOLIVE_GUIDE.md` | `docs/operations/GOLIVE_GUIDE.md` |
| `docs/STORAGE_FOLDER_BROWSER_IMPLEMENTATION.md` | `docs/operations/STORAGE_FOLDER_BROWSER_IMPLEMENTATION.md` |
| `docs/STORAGE_MONITORING_SIMPLIFICATION_IMPLEMENTATION.md` | `docs/operations/STORAGE_MONITORING_SIMPLIFICATION_IMPLEMENTATION.md` |

### Archive

| Old path | New path |
|---|---|
| `docs/CARGOEXPRESS_PROPOSED_SYSTEM_WORKFLOW_AUDIT.md` | `docs/archive/CARGOEXPRESS_PROPOSED_SYSTEM_WORKFLOW_AUDIT.md` |
| `docs/CHAPTER_2_DATABASE_CORRECTED_ENTRIES.md` | `docs/archive/CHAPTER_2_DATABASE_CORRECTED_ENTRIES.md` |
| `docs/EMAIL_SUBSCRIPTION_TOGGLE_ROLLBACK.md` | `docs/archive/EMAIL_SUBSCRIPTION_TOGGLE_ROLLBACK.md` |
| `docs/WHY_FIX_TECHNICAL_DEBT.md` | `docs/archive/WHY_FIX_TECHNICAL_DEBT.md` |
| `docs/database-architecture-review.md` | `docs/archive/database-architecture-review.md` |
| `docs/payment-architecture-redesign.md` | `docs/archive/payment-architecture-redesign.md` |
| `docs/payment-flow-study.md` | `docs/archive/payment-flow-study.md` |
| `docs/payment-redesign-v2.md` | `docs/archive/payment-redesign-v2.md` |

### Audits

| Old path | New path |
|---|---|
| `docs/AUDIT_REPORT_2026-09-12.md` | `docs/audits/AUDIT_REPORT_2026-09-12.md` |
| `docs/BOOKING_UI_AND_WEBSITE_FEATURE_UPDATES.md` | `docs/audits/BOOKING_UI_AND_WEBSITE_FEATURE_UPDATES.md` |
| `docs/CARGOEXPRESS_CHAPTER2_PROCESS_SPECIFICATION_AUDIT.md` | `docs/audits/CARGOEXPRESS_CHAPTER2_PROCESS_SPECIFICATION_AUDIT.md` |
| `docs/CARGOEXPRESS_CHAPTER2_PROGRAM_HIERARCHY_UI_AUDIT.md` | `docs/audits/CARGOEXPRESS_CHAPTER2_PROGRAM_HIERARCHY_UI_AUDIT.md` |
| `docs/CARGOEXPRESS_DATABASE_CLEANUP_AUDIT.md` | `docs/audits/CARGOEXPRESS_DATABASE_CLEANUP_AUDIT.md` |
| `docs/CARGOEXPRESS_MONITORING_PAGE_UX_AUDIT.md` | `docs/audits/CARGOEXPRESS_MONITORING_PAGE_UX_AUDIT.md` |
| `docs/CARGOEXPRESS_PAGE_ROUTE_FOLDER_ORGANIZATION_AUDIT.md` | `docs/audits/CARGOEXPRESS_PAGE_ROUTE_FOLDER_ORGANIZATION_AUDIT.md` |
| `docs/CHAPTER_2_DATABASE_COMPARISON_REPORT.md` | `docs/audits/CHAPTER_2_DATABASE_COMPARISON_REPORT.md` |
| `docs/CONTACT_INQUIRIES_EMAIL_FLOW_AUDIT.md` | `docs/audits/CONTACT_INQUIRIES_EMAIL_FLOW_AUDIT.md` |
| `docs/DATABASE_PRACTICAL_PRIORITIES_REPORT.md` | `docs/audits/DATABASE_PRACTICAL_PRIORITIES_REPORT.md` |
| `docs/DELIVERY_PARTIAL_CASH_PAYMENT_FIX.md` | `docs/audits/DELIVERY_PARTIAL_CASH_PAYMENT_FIX.md` |
| `audit_reports/DISCOUNT_OVERPAYMENT_REFUND_AUDIT.md` | `docs/audits/DISCOUNT_OVERPAYMENT_REFUND_AUDIT.md` |
| `EMAIL_UPDATES_SUBSCRIPTION_FEATURE.md` | `docs/audits/EMAIL_UPDATES_SUBSCRIPTION_FEATURE.md` |
| `audit_reports/F-002-discounted-delivery-payment-math.md` | `docs/audits/F-002-discounted-delivery-payment-math.md` |
| `audit_reports/F-003-customer-service-area-mass-assignment.md` | `docs/audits/F-003-customer-service-area-mass-assignment.md` |
| `audit_reports/F-004-additional-payment-amount-integrity.md` | `docs/audits/F-004-additional-payment-amount-integrity.md` |
| `audit_reports/F-005-legacy-payment-rpc-overloads.md` | `docs/audits/F-005-legacy-payment-rpc-overloads.md` |
| `audit_reports/F-006-refund-reconciliation-gap.md` | `docs/audits/F-006-refund-reconciliation-gap.md` |
| `audit_reports/F-007-service-area-mass-assignment-fix-plan.md` | `docs/audits/F-007-service-area-mass-assignment-fix-plan.md` |
| `audit_reports/F-008-legacy-payment-rpc-overload-cleanup-plan.md` | `docs/audits/F-008-legacy-payment-rpc-overload-cleanup-plan.md` |
| `docs/FEATURED_SHIPMENTS_AND_FEEDBACK_SEPARATION.md` | `docs/audits/FEATURED_SHIPMENTS_AND_FEEDBACK_SEPARATION.md` |
| `docs/FEEDBACK_HORIZONTAL_LAYOUT_AND_PUBLIC_DATES.md` | `docs/audits/FEEDBACK_HORIZONTAL_LAYOUT_AND_PUBLIC_DATES.md` |
| `FINANCE_REFUND_RECONCILIATION_AUDIT.md` | `docs/audits/FINANCE_REFUND_RECONCILIATION_AUDIT.md` |
| `FINDINGS_VERIFICATION_REPORT.md` | `docs/audits/FINDINGS_VERIFICATION_REPORT.md` |
| `MANUAL_CASH_REFUND_FEATURE_REPORT.md` | `docs/audits/MANUAL_CASH_REFUND_FEATURE_REPORT.md` |
| `MANUAL_REFUND_REFERENCE_VALIDATION_FIX_REPORT.md` | `docs/audits/MANUAL_REFUND_REFERENCE_VALIDATION_FIX_REPORT.md` |
| `docs/NOTIFICATION_SYSTEM_AUDIT_AND_FIX.md` | `docs/audits/NOTIFICATION_SYSTEM_AUDIT_AND_FIX.md` |
| `docs/PASSWORD_RESET_FLOW_FIX.md` | `docs/audits/PASSWORD_RESET_FLOW_FIX.md` |
| `docs/PAYMENT_DUPLICATE_PREVENTION_FIX.md` | `docs/audits/PAYMENT_DUPLICATE_PREVENTION_FIX.md` |
| `docs/PAYMENT_NOTIFICATION_FIX_REPORT.md` | `docs/audits/PAYMENT_NOTIFICATION_FIX_REPORT.md` |
| `POST_DEPLOYMENT_REGRESSION_AUDIT.local.md` | `docs/audits/POST_DEPLOYMENT_REGRESSION_AUDIT.local.md` |
| `POST_DEPLOYMENT_REGRESSION_AUDIT.md` | `docs/audits/POST_DEPLOYMENT_REGRESSION_AUDIT.md` |
| `POST_DEPLOYMENT_TARGETED_FIX_REPORT.md` | `docs/audits/POST_DEPLOYMENT_TARGETED_FIX_REPORT.md` |
| `docs/PUSH_NOTIFICATION_ENABLEMENT_FIX.md` | `docs/audits/PUSH_NOTIFICATION_ENABLEMENT_FIX.md` |
| `audit_reports/REFUND_PRICING_CORRECTION_AUDIT.md` | `docs/audits/REFUND_PRICING_CORRECTION_AUDIT.md` |
| `REFUND_UI_REPORTS_ALIGNMENT_REPORT.md` | `docs/audits/REFUND_UI_REPORTS_ALIGNMENT_REPORT.md` |
| `REPORT_PRINT_BLANK_PAGES_FIX.md` | `docs/audits/REPORT_PRINT_BLANK_PAGES_FIX.md` |
| `SALES_AND_CANCELLED_BOOKING_SETTLEMENT_PLAN.md` | `docs/audits/SALES_AND_CANCELLED_BOOKING_SETTLEMENT_PLAN.md` |
| `audit_reports/SALES_REPORTS_COMPUTATION_AUDIT.md` | `docs/audits/SALES_REPORTS_COMPUTATION_AUDIT.md` |
| `docs/SECURITY_AUDIT_2026-08-17.md` | `docs/audits/SECURITY_AUDIT_2026-08-17.md` |
| `docs/SHIPPING_DISCOUNT_IMPLEMENTATION_REPORT.md` | `docs/audits/SHIPPING_DISCOUNT_IMPLEMENTATION_REPORT.md` |
| `docs/STORAGE_MONITORING_POST_CHANGE_AUDIT.md` | `docs/audits/STORAGE_MONITORING_POST_CHANGE_AUDIT.md` |
| `docs/STORAGE_MONITORING_SIMPLIFICATION_REVIEW.md` | `docs/audits/STORAGE_MONITORING_SIMPLIFICATION_REVIEW.md` |
| `docs/STORAGE_UNUSED_COLUMNS_AND_EDGE_FUNCTIONS_AUDIT.md` | `docs/audits/STORAGE_UNUSED_COLUMNS_AND_EDGE_FUNCTIONS_AUDIT.md` |
| `SYSTEM_BUG_SECURITY_AUDIT.md` | `docs/audits/SYSTEM_BUG_SECURITY_AUDIT.md` |
| `SYSTEM_BUG_SECURITY_FIX_REPORT.md` | `docs/audits/SYSTEM_BUG_SECURITY_FIX_REPORT.md` |
| `docs/SYSTEM_E2E_TEST_REPORT.md` | `docs/audits/SYSTEM_E2E_TEST_REPORT.md` |
| `SYSTEM_FLOW_AND_LOGIC_REVIEW.md` | `docs/audits/SYSTEM_FLOW_AND_LOGIC_REVIEW.md` |
| `docs/SYSTEM_MODULE_BUG_AUDIT.md` | `docs/audits/SYSTEM_MODULE_BUG_AUDIT.md` |
| `audit_reports/admin_mobile_audit.md` | `docs/audits/admin_mobile_audit.md` |
| `docs/ui-ux-audit-2026-08-09.md` | `docs/audits/ui-ux-audit-2026-08-09.md` |
| `docs/ui-ux-audit.md` | `docs/audits/ui-ux-audit.md` |

## Deleted files and retained uncertain files

### Deleted files

None. No tracked source, migration, Edge Function, test, script, lockfile, asset,
instruction file, report, or root utility was deleted by this cleanup.

Generated directories such as `dist/`, `playwright-report/`, and `test-results/`
were not treated as evidence of unused source and were not removed during this
pass. They are reproducible outputs but may contain useful local test evidence.

### Retained because uncertainty remained

- Root schema/report utilities: `compare.cjs`, `generate_reports.cjs`,
  `get_4_tables.cjs`, `get_missing_tables.cjs`, and `schema_output.txt` have
  direct relationships and were retained.
- Root repair/scratch utilities: `fix-admin.mjs`, `fix-db-announcement.mjs`,
  `fix-encoding.js`, `fix-encoding.mjs`, `scratch-customers.js`,
  `scratch-tables.js`, `test-admin-login.mjs`, and `test.sh` were retained as
  potentially useful operational history.
- `.history/`, `.claude/`, and other ignored local directories were not
  recursively deleted because their ownership and recoverability were not clear.
- `CLAUDE.md`, `README.md`, nested readmes, migrations, functions, tests, public
  assets, and lockfiles were retained by design.

## Compiled reviewer mappings

The new [compiled reviewer](./guides/CARGOEXPRESSPH_COMPILED_REVIEWER.md) maps the
review questions to the source set as follows:

| Reviewer section | Main source evidence |
|---|---|
| Overview/stack | `README.md`, `docs/architecture/TECHNICAL-OVERVIEW.md`, `src/` |
| Architecture/security | `CLAUDE.md`, database architecture review, security audit, current router and migrations |
| Guest/customer/admin pages | `src/App.jsx`, module coverage |
| Workflows | complete system guide, system flow review, current page/RPC code |
| Payments/discounts/refunds/settlement | PayMongo functions, payment/refund/discount/cancellation audits and migrations |
| Sales/reports | sales computation, refund/report alignment, finance reconciliation audits |
| Functions/RPCs/triggers/jobs | `supabase/functions/`, `supabase/migrations/`, backend automation guide |
| Deletion/retention/recovery | storage implementation/audit and retention guide |
| Operations/troubleshooting | package scripts, go-live guide, regression audits |
| Defense Q&A | security audit, return capability implementation, Realtime hook and protected pages |
| Known limitations | cleanup evidence, historical docs, environment-dependent deployment settings |
| Source index | current implementation and categorized documentation links |

## Contradictions and stale documentation found

1. Older documents report different Edge Function totals. The current repository
   has 20 deployable function directories plus `_shared`; the count must be
   regenerated at release time.
2. Historical reports mention the former root `audit_reports/` directory or flat
   `docs/` layout. Those statements are retained where they are part of the
   report’s historical evidence and are not claims about the current tree.
3. `schema.sql`-style narrative/schema snapshots are not treated as authoritative;
   current migrations and the live database are authoritative per `CLAUDE.md`.
4. `docs/audits/PAYMENT_DUPLICATE_PREVENTION_FIX.md` mentions diagnostic SQL files
   that are not present in the current tree. The audit was retained, but those
   references are marked as historical/unverified rather than presented as
   runnable scripts.
5. `docs/archive/payment-redesign-v2.md` and related payment architecture files
   are proposals/superseded designs. They are intentionally separated from the
   current payment implementation.
6. Retention documents describe operational intent, but exact live schedules and
   job deployment still require verification against current migrations and the
   target Supabase project.

## Verification performed

The following checks were run during this cleanup handoff:

- File inventory confirms category folders contain the moved documents and
  `audit_reports/` no longer contains a duplicate copy.
- Root README and `docs/README.md` point to the new paths.
- The compiled reviewer and cleanup report use relative links to current files.
- A repository-wide Markdown relative-link check scanned 117 Markdown files and
  found no missing targets.
- Current payment route, return verifier, migration, provider client, and
  Realtime hook were inspected without changing their implementation.
- `npm run test:edge-functions` passed: 20 Edge Functions built successfully.
- `npm run test:pwa-offline` passed: 73 JavaScript/CSS/font assets were
  precached.
- `npm run build` passed: Vite produced the production bundle and injected the
  service-worker precache list. Vite emitted its existing large-chunk warning.
- `npm test` passed all suites through the cancellation-settlement harness, then
  stopped at the existing `sales-cancellation-ui-contract-test` assertion. The
  failing expectation is that `SalesPage.jsx` explains the “Net Collected Today”
  metric as successful collections minus successful refunds using Manila dates;
  the current JSX contains the metric label but not that explanation. This is an
  application contract gap unrelated to the documentation moves and was not
  changed in this docs-only task.
- No deployment, database push, provider call, or production booking mutation was
  performed.

## Risks and next actions

- Run the repository’s relevant test/build gate before merging this documentation
  work. This validates that moved-path references in contract tests still resolve.
- Before any release, verify the public `verify-payment-return` gateway setting,
  Edge Function deployment, secrets, webhook endpoint, migration application,
  Realtime publication, and RLS behavior in a non-production project.
- Run the six Device B/browser scenarios and the separate-device authorized
  Realtime scenario with isolated provider test-mode data. Do not use the
  referenced production booking.
- Keep proposals and audits separate from current implementation so future
  reviewers do not mistake a design note for deployed behavior.
