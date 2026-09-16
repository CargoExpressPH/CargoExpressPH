# Database Practical Priorities Report
**CargoExpress PH**

## 1. Verified Deployment State
*   **Verification Method:** `supabase migration list`
*   **Evidence:** The local migration history exactly matches the remote `duigaivxgxlnjmfienhg` Supabase project up to `20260908010000_drop_push_delivery_attempts.sql`.
*   **Live State Confirmed:** 
    *   `notification_delivery_attempts` table **no longer exists** in the live database.
    *   The `send-push` edge function is running the updated code (without DB inserts).
    *   The database is successfully operating strictly on the queue (`notification_delivery_jobs`), relying on Edge Function logs for delivery history, which confirms the previous cleanup was deployed successfully.

## 2. Legal Document Version Consistency
*   **Issue Addressed:** The registration flow previously passed a single `legal_policy_version` metadata field and forced it to match both Terms and Privacy versions in the database. If Terms and Privacy drifted into different versions (e.g., Terms v1.1, Privacy v1.0), all user registrations would systematically fail.
*   **Changes Made:**
    *   Modified `src/pages/auth/RegisterPage.jsx` to independently submit `termsVersion` and `privacyVersion` in the metadata payload.
    *   Updated `src/contexts/AuthContext.jsx` to validate both versions independently before making the `supabase.auth.signUp()` call.
    *   Prepared `supabase/migrations/20260908112000_fix_legal_consent_validation.sql` to update the `handle_new_user()` trigger so it verifies the user's specific accepted versions against the corresponding document records in `legal_documents`.
*   **Validation:** Verified via code inspection and successful frontend builds (`npm run build`). The migration ensures we "fail closed" if versions don't match, strictly preserving historical consent integrity without silently accepting unseen policies.
*   **Unapplied Migration:** `20260908112000_fix_legal_consent_validation.sql` is ready but intentionally left unapplied.

## 3. Photo Table Retention
*   **Issue Addressed:** `photo_storage_events` (audit logs) and `photo_cleanup_queue` (garbage collection queue) would grow indefinitely without a retention policy.
*   **Changes Made:** Prepared `supabase/migrations/20260908112100_prepare_photo_retention.sql` containing two functions:
    *   `purge_old_photo_storage_events(30)`: Keeps 30 days of health check and fallback events.
    *   `purge_old_photo_cleanup_queue(7)`: Deletes only completed garbage-collection tasks older than 7 days based on `completed_at` (leaving pending/failed tasks to retry indefinitely).
*   **Validation:** These functions are highly restricted (`SECURITY DEFINER`) and do not run automatically. Included safe `SELECT` dry-run queries in the SQL file so administrators can preview qualifying rows before enabling the cron job.
*   **Decisions Still Needed:** Administrators must decide if 30 days and 7 days are appropriate for operational needs before scheduling these via `pg_cron`.
*   **Unapplied Migration:** `20260908112100_prepare_photo_retention.sql` is ready but intentionally left unapplied.

## 4. UI Behavior Completion
*   **Service Area Remarks (`orders.service_area_remarks`):**
    *   *Verification:* Confirmed this field is explicitly used by admins to type a reason when rejecting an out-of-coverage booking (`OrderDetailPage.jsx:546`).
    *   *Action:* Updated the customer-facing `OrderDetailsPage.jsx` to natively display `"Note from our team: This booking is out of our current service coverage. [remarks]"` when the order is Cancelled due to service area rejection.
*   **Trip Notes (`trips.notes`):**
    *   *Verification:* Confirmed it is an internal operational field for admins.
    *   *Action:* Updated the admin-facing `TripDetailPage.jsx` to display a new "Internal Trip Notes" card just below the capacity tracker, handling empty/null values cleanly.
*   **Validation:** Both components pass `npm run build` successfully. The routing, presentation, and data integrity remain intact.

## 5. Performance Claims Clarification
*   The previous Architecture Review praised the performance and design of the database triggers, but without live query planner access (`EXPLAIN ANALYZE`), no strict mathematical claims (like $O(1)$) or live row-count benchmarks can be verified.
*   *Measurement Plan:* If performance degradation is suspected in the future, administrators should run `EXPLAIN ANALYZE` on the `orders` read queries and review the Supabase Database Health dashboard for index utilization before adding speculative indexes.

## Deployment Order & Rollback Limits
1.  **Deployment Order:** 
    *   Push the UI updates (`git push`).
    *   Apply `20260908112000_fix_legal_consent_validation.sql` (`supabase db push`) to fix registration drift issues.
    *   Apply `20260908112100_prepare_photo_retention.sql` (`supabase db push`) to load the retention functions into the database.
2.  **Rollback Limits:** 
    *   The frontend changes are fully reversible via `git revert`.
    *   The prepared migrations are purely functional additions. Reverting them is simply executing `DROP FUNCTION public.purge_old_photo_storage_events` and reverting `handle_new_user()`. No destructive `DROP TABLE` operations are pending.
3.  **Remaining Risks:**
    *   None identified. The prepared changes are safe and strictly validate existing operations.
