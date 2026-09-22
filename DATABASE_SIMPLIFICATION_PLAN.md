# CargoExpress PH — Database Simplification Plan

Date: 2026-09-22
Status: **Plan only. No schema change has been executed.**

## Plain-language summary

The reported count of 27 is plausible as the current repository's **public application table** count: the checked-in catalog artifact has 22 public tables and the later migration chain adds five more. The chain also defines two private application tables, so the modeled application-owned total is 29. The corresponding modeled column counts are 373 public and 21 private (394 total), conditional on the checked-in migration sequence being applied to that 22-table catalog. Supabase-managed `auth` and `storage` objects are separate. The live count is unknown because the configured Supabase CLI request failed authorization and no remote schema/migration history could be read.

### Column-audit status (2026-09-22)

The earlier inventory did not satisfy the requested column-by-column dependency audit. The companion audit now contains individual static-trace rows for **129 of 394 modeled current columns** across `orders`, `profiles`, `trips`, `company_information`, and `contact_inquiries`. The remaining **265 current columns across 22 public and 2 private relations** are still inventoried only; they are not considered unused and are not ready for removal decisions. The old catalog also contains `company_information.messenger`, which the local migration `20260920205500_remove_messenger_link.sql` drops; it is counted as historical catalog material, not as a current modeled field.

The 129 rows distinguish identifiable application/backend use, fields fetched through `SELECT *` without a confirmed field-specific consumer, database/security dependencies, compatibility, and uncertainties. Because data-layer writes sometimes spread dynamic update objects and browser/backend callers can be deployed independently, even these five tables retain stated dynamic/deployment uncertainty. Do not interpret “individually traced” as live query-statistics validation.

Repository-based tracing is not blocked by the lack of Supabase live access and should continue for the remaining relations. Live reconciliation remains unverified: the existing CLI lookup for configured project `duigaivxgxlnjmfienhg` failed authorization. The required access is an already-authenticated Supabase CLI session authorized for that project, or an approved read-only Postgres connection/role able to inspect `information_schema`/`pg_catalog`, RLS policies, grants, triggers/functions, Realtime publication, and migration history. No credential should be pasted into chat.

Reducing the number of tables is not currently worthwhile. The apparent pairs store different things or protect retries, financial correctness, security, or history. No table or column has enough live evidence to recommend a drop. The best immediate improvement is a trustworthy schema inventory and clear documentation of row grain, authority, and retention—not consolidation for a smaller number.

## Recommendation by category

### A. Keep as-is

Keep all 27 modeled public tables and both private tables until a live, role-aware dependency audit proves otherwise. Especially do not merge:

- `payment_attempts`, `payment_transactions`, and `payment_refunds`;
- in-app `notifications`, push `notification_delivery_jobs`, and `user_device_tokens`;
- `activity_logs` and `order_status_events`;
- `legal_documents` and `legal_consents`;
- `photo_storage_settings`, `photo_storage_events`, and `photo_cleanup_queue`;
- `announcements`, `announcement_email_broadcasts`, and `announcement_email_recipients`;
- `cancellation_settlements` and `cancellation_settlement_history`.

Each pair/group has a different row grain, access model, lifecycle, concurrency or audit requirement. Moving structured data into JSONB simply to lower table count would make constraints, indexes, retries, and per-row authorization harder.

### B. Documentation/naming clarification

1. Keep `supabase/schema.sql` labeled historical/non-authoritative. Generate a new schema artifact only from a database that has run the intended migration chain, then compare catalog definitions before calling it current.
2. Document that `orders.amount_paid`, `remaining_balance`, and `payment_status` are guarded/reconciled order summaries; `payment_transactions` is the transaction history and `payment_refunds` records separate returned money.
3. Document short and distinct retention policies beside the owning tables: seven-day activity logs, seven-day completed push jobs, photo event/queue retention, and six-month terminal shipment photo cleanup. The short activity-log window may not match a defense or incident-audit expectation.
4. Clarify the dual-name compatibility period in migration comments and operational docs. `sender_name`/`receiver_name` are legacy full-name mirrors while the split fields are introduced.
5. Clarify field-level source-of-truth for email opt-in: `email_subscriptions` is the current address-level broadcast preference; inquiry/profile booleans have separate historical or feature-specific semantics.

### C. Potential low-risk cleanup

No low-risk schema deletion is supported by current evidence. `company_information.messenger` is already dropped in a forward migration; do not propose dropping it a second time. The old `notification_delivery_attempts`, chatbot-analytics/FAQ tables, and email-monitoring tables have already been dropped by migrations. First establish whether those migrations are applied remotely.

The only low-risk action is a read-only catalog reconciliation: compare live table/column/policy/index/trigger definitions and applied migration versions with the 210-file local chain. No application behavior changes are needed for that audit.

### D. Coordinated migration candidate — legacy full names

**Candidate:** eventually remove `orders.sender_name` and `orders.receiver_name`, retaining the four split-name columns.

**Why it might help:** one canonical representation would remove dual-write/sync logic and reduce ambiguity for new code.

**Why not now:** the migration explicitly preserves full names for existing security-definer functions and tracking/display consumers. Backfill splits on the first space; compound first names, multi-part family names, suffixes, and mononyms make automatic inversion unsafe. These fields may already exist in live deployed function versions unknown to this repository audit.

**Preconditions and owner confirmation:**

- Verify the migration is applied and compare counts of null/blank split fields and mismatches between composed and legacy names using aggregate-only SQL.
- Review name-matching quality with a privacy-preserving, sampled process approved by the owner; do not dump customer names into reports.
- Search current frontend, Edge Functions, triggers, policies, RLS, RPCs, dynamic SQL, external integrations and operational scripts; inspect deployed-only definitions.
- Confirm customer-facing display and public tracking can use split fields safely, including legacy mononyms.

**Forward migration and rollout plan if later approved:**

1. Add/verify compatibility views or RPC output aliases first, if clients need full-name return fields.
2. Change all writers/readers and SECURITY DEFINER functions in a backward-compatible release; keep the trigger dual-write.
3. Add reconciliation tests for both write directions, locks, contact edits, booking creation, tracking, exports, and existing single-word names.
4. Observe a full release and compare aggregate mismatch metrics; do not rely on migration history alone.
5. Only after deployed clients/functions no longer require the columns, add a new forward migration to stop writing them and later drop them. Never rewrite an applied migration or drop/recreate to “restore” data.

**Migration/backfill:** no new backfill is proposed now. If columns are retired, preserve a recoverable export/backup under the organization's approved process before the irreversible drop; rollback after dropping cannot restore lost values without that backup.

**Expected reduction:** two columns, zero tables. Not yet justified.

**Migration approval caveat:** the local split-name migration header says “DRAFT for review.” Treat both approval and deployment as unresolved until confirmed by the owner and the remote migration history.

### E. Do not consolidate — risk outweighs benefit

| Temptation | Keep because | If requirements change |
|---|---|---|
| Replace `orders` payment summary fields with live aggregates only | Order guards, reminders, list/report views, and reconciliation consume the summary; removing it changes transactional and performance characteristics. | Measure drift first; design a transactional replacement and reconciliation/backfill with financial tests before any migration. |
| Fold payment attempts/transactions/refunds together | Different event grain, provider state, idempotency, settlement and refund lifecycle. | No consolidation plan recommended. |
| Fold delivery jobs into notifications or device tokens | A message is not a per-device delivery/retry; device identity is separately managed. | No consolidation plan recommended. |
| Replace event/audit tables with generic activity JSON | Shipment timeline, generic actor audit, and financial decisions have different retention and query guarantees. | Keep domain history structured. Revisit only with explicit retention and reporting requirements. |
| Collapse legal consent into profile booleans | Consent must bind an exact document version and source; a mutable checkbox cannot represent that history. | No consolidation recommended. |
| Fold photo queue/events/settings into one table | Retryable work, immutable observations, and current configuration have separate permissions/lifecycles. | No consolidation recommended. |
| Merge email subscriptions with profile/inquiry flags | Different grain and provenance; a single normalized email can have multiple accounts/inquiries. | Keep sync rules explicit and tested. |
| Merge current cancellation settlement with history | Would destroy immutable old/new financial-decision evidence. | Never discard history during amendments. |
| Normalize package quantity into parcel rows now | Current packages are only an admin-maintained count used for labels, with no per-box status/weight/route. | Add parcel table only when each parcel gets its own state or evidence. |
| Remove `orders.reassignment_history` | `src/lib/database.js` still reads/writes it and the former trip-reassignment table was intentionally dropped. | Only migrate if queryable reassignment reporting/audit becomes a requirement and parity tests exist. |

## Counts if an approved change is later adopted

No approved change exists, so expected count remains **27 public + 2 private application tables** in the repository model (29 total). The possible full-name cleanup affects columns only. Do not claim production has these counts until the remote catalog is read.

## Required preconditions before implementation

1. Obtain authorized read-only access to the intended project without sharing tokens in chat. Capture project reference and compare it with the configured ref `duigaivxgxlnjmfienhg`.
2. Capture applied migration versions/checksums and a catalog-only dump of application schemas (`public`, `private`) including columns/types/defaults/nullability, PK/FK/unique/check constraints, indexes, triggers/functions, policies, grants, publications and views.
3. Inspect `pg_cron`/Vault/Edge Function versions through an approved read-only process. Do not expose secrets. Include deployed-only functions and external/manual callers.
4. Reconcile all 27 public and two private expected relations; explain each missing/extra object and compare remote definitions with migrations. Migration history alone is insufficient.
5. Only then run low-cost aggregate-only data checks for rows, nullability, duplicate/orphaned relations and candidate values. Avoid personal records and broad scans.
6. Require an explicit owner-approved migration plan, forward migration, backup/recovery plan, backward-compatible deployment sequence and regression tests before any schema change.

## Validation and regression plan for any future approved schema change

- Validate migration against a disposable database seeded with representative domain rows, including anonymous/multi-part names, multiple payment attempts and transactions, partial/failed/pending payments, provider and manual refunds, duplicate notifications across devices, broadcast retry states, amendments, legal-version consent and photos pending/retryable cleanup.
- Run authorization tests as anon, customer owner, unrelated customer, admin and service role. Assert restricted tables are not directly exposed and RPCs keep their intended rules.
- Test triggers, constraints, unique/idempotency keys, queue claiming under concurrency, retry/recovery, retention jobs, reports/exports, Realtime publication, and Edge Function integration contracts.
- Test old frontend/function versions during additive rollout; remove compatibility only after deployed callers are proven updated.
- Verify row counts/checksums and financial totals before and after data migration. Keep rollback limitations explicit; a dropped column's values are not restored by recreating the column.
- Do not test by applying cleanup jobs or changes to production. Use an isolated database and synthetic fixtures.

## Owner questions still open

- Does production currently have exactly the configured project reference and all 210 local migration versions applied?
- Is seven-day activity-log retention sufficient for operational investigation or the thesis demo evidence?
- Are deployed clients or external reports still reading the full-name compatibility columns or order-level payment summary fields?
- What approved retention applies to broadcast recipient email addresses, chat history, payment/refund audit, and settlement evidence?
- Should package quantity ever become true per-package tracking, or remain label-only metadata?

## Simple Taglish defense explanation

“Hindi paramihan o pababaan ng tables ang goal. Magkakaiba ang trabaho ng bawat table: halimbawa, hiwalay ang payment attempt, aktuwal na bayad, at refund para tama ang status at maiwasan ang duplicate; hiwalay din ang notification sa bawat device delivery para puwedeng mag-retry. May tables para sa audit, consent, at cleanup/security jobs. Sa repository, 27 ang public application tables at dalawa ang private support tables, pero kailangan pa itong itugma sa live database bago sabihing iyon ang aktuwal na production count. Sa ngayon, mas ligtas panatilihin ang mga ito kaysa pagsamahin at mawala ang history, retry, o access control.”
