# Storage Monitoring Unused Columns & Edge Functions Audit

## A. Short Nontechnical Summary
This audit investigated the CargoExpressPH Storage Monitoring module to find genuinely unused database columns, Edge Functions, and SQL functions following the recent UI simplification and backend updates. 

The audit confirms that **all database columns** across the storage-related tables are still actively required by backend security policies, logging, or background queues, even if their corresponding buttons were removed from the Admin UI. However, **one Edge Function** and **one SQL Function** are completely unused relics of the old orphaned-photo cleanup system and can be safely deleted.

## B. Table-by-Column Inventory

**1. `photo_storage_settings`**
*Classification: **KEEP***
Although the manual toggle UI was removed, the backend fallback mechanism remains fully intact as an emergency SQL-level operator override. 
- `id`, `upload_mode`: Powers the `get_effective_photo_storage_mode()` check.
- `force_firebase_expires_at`: Enforced by `CHECK` constraints to ensure emergency overrides expire.
- `reason`, `updated_by`, `updated_at`: Required for auditability if an admin activates this via SQL.

**2. `photo_storage_events`**
*Classification: **KEEP***
The granular activity log table is no longer displayed to the admin in a list, but its data is still critical.
- `event_type`, `provider`, `outcome`, `created_at`: Read continuously by `get_photo_storage_health()` to aggregate recent upload failures and successes, which directly feeds the new "Storage Usage" UI card.
- `message`, `metadata`, `size_bytes`, `photo_type`, `order_id`: Written by Edge Functions (`delete-storage-photos`, `record-photo-storage-event`, `archive-expired-evidence-photos`) to maintain an auditable paper trail of destructive actions and fallback events.
- Maintenance: A scheduled cron job (`purge_old_photo_storage_events`) keeps this table from growing infinitely.

**3. `photo_cleanup_queue`**
*Classification: **KEEP***
- All columns (`provider`, `storage_path`, `queued_at`, `completed_at`, `attempts`, `last_error`) are actively required. This table forms the core retry-queue mechanism for the newly deployed `delete-storage-photos` and `archive-expired-evidence-photos` edge functions.

## C. Edge Function Inventory

| Function Name | Local Source | Deployed? | Callers / Dependencies | Classification |
|---|---|---|---|---|
| `photo-storage-health` | Yes | Yes | UI (`checkPhotoStorageHealth`), Cron | KEEP |
| `record-photo-storage-event` | Yes | Yes | Client (`storage.js`) | KEEP |
| `delete-storage-photos` | Yes | Yes | HTTP webhook (Admin deletion) | KEEP |
| `archive-expired-evidence-photos`| Yes | Yes | Cron (`pg_net` trigger) | KEEP |
| `get/store/delete-photo-fallback`| Yes | Yes | Client fallback operations | KEEP |
| `cleanup-orphaned-photos` | **No** | **Yes** | None (Superseded) | **REMOVE CANDIDATE** |

## D. Confirmed Removal Candidates

**1. Edge Function: `cleanup-orphaned-photos`**
- **Purpose**: Previously detected orphaned photos in Supabase storage and deleted them.
- **Evidence of Removal**: The local `supabase/functions/cleanup-orphaned-photos` directory was already deleted during the recent UI simplification. Its responsibilities were entirely replaced by the unified `delete_evidence_photos()` SQL flow and the `delete-storage-photos` Edge Function.
- **Why it remains**: The deployment command (`supabase functions delete`) was never executed, leaving the function ACTIVE on the live server.
- **Dependencies**: None. It is no longer triggered by any UI component or cron schedule.

**2. SQL Function: `list_orphaned_evidence_photos()`**
- **Purpose**: Previously backed the old orphaned-photo UI by searching `storage.objects` for photos without bookings.
- **Evidence of Removal**: The new photo gallery UI uses `list_evidence_photos()`. While a migration comment stated that the old function would be reused, the actual implementation of `list_evidence_photos()` inlined the orphan-detection logic directly (via the `orphaned_rows` CTE), rendering `list_orphaned_evidence_photos()` unused.
- **Dependencies**: None. Searching the codebase reveals no callers.

## E. Items That Must Remain
- **All tables and columns** audited above. Removing them would break Row-Level Security (`is_featured_photo_path`), automatic archiving, health checks, or the background deletion retry queue.
- **`get_photo_storage_live_usage()`, `get_photo_storage_summary()`**: Feeds the UI health card.
- **`queue_expired_evidence_cleanup()`, `get_expired_evidence_orders()`**: Powers the cron-based archiving function.
- **`purge_old_photo_storage_events()`, `purge_old_photo_cleanup_queue()`**: Scheduled by `pg_cron` to prevent database bloat.

## F. Uncertainties & Limitations
- **External Webhooks**: The audit assumes that no external, undocumented third-party services are manually invoking the `cleanup-orphaned-photos` Edge Function URL. Given the architecture, this is highly improbable, but absolute verification would require inspecting live Supabase HTTP logs (which are outside the scope of this repository access).

## G. Proposed Cleanup Execution

No code changes are required in the application, as these references are already gone. The cleanup is purely administrative.

**Step 1: Undeploy the Edge Function**
Run the following Supabase CLI command to remove the orphaned function from production:
```bash
npx supabase functions delete cleanup-orphaned-photos
```

**Step 2: Drop the unused SQL Function**
Execute the following SQL on the database to remove the stale listing function:
```sql
DROP FUNCTION IF EXISTS public.list_orphaned_evidence_photos();
```

---

### Direct Answers:
- **Which exact columns can be removed?** Zero. All columns in the audited tables are actively used by background processes, security policies, or health-check aggregations.
- **Which exact Edge Functions can be removed?** `cleanup-orphaned-photos` (it is deployed but locally deleted and completely unused).
- **Which related SQL functions become unnecessary afterward?** `list_orphaned_evidence_photos()`.
- **What must remain?** All `photo_storage_settings`, `photo_storage_events`, and `photo_cleanup_queue` tables, alongside the new gallery and deletion functions.
- **What still needs verification?** Nothing locally. The cleanup can proceed safely using the commands in Section G.
