-- ============================================================
-- 20260803130000_constraints_and_indexes.sql
--
-- P2 — Constraints that make invalid states unrepresentable, and indexes
-- backing queries the app already runs on every page load.
--
-- NOTE ON CONCURRENCY: these use plain CREATE INDEX, not CONCURRENTLY,
-- because the Supabase CLI wraps each migration in a transaction and
-- CONCURRENTLY cannot run inside one. At this data size the brief write lock
-- is negligible. If these tables ever grow past ~1M rows, run the index
-- statements separately with CONCURRENTLY instead.
--
-- NOTE ON CHECKS: each constraint is added NOT VALID first (instantly
-- enforced for all new writes, existing rows unchecked), then VALIDATEd.
-- If a VALIDATE fails, pre-existing rows violate the rule — that is the
-- constraint doing its job. The constraint stays in place as NOT VALID, so
-- new writes are still guarded; run the matching diagnostic below, fix the
-- rows, then re-run the VALIDATE.
-- ============================================================


-- ============================================================
-- PRE-FLIGHT DIAGNOSTICS (read-only — run these first if you want to
-- know in advance whether the VALIDATE steps will succeed)
--
--   SELECT status, count(*) FROM conversations GROUP BY status;
--   SELECT status, count(*) FROM contact_inquiries GROUP BY status;
--   SELECT count(*) FROM orders WHERE amount_paid < 0 OR remaining_balance < 0;
--   SELECT count(*) FROM trips WHERE arrival_date IS NOT NULL
--                                AND arrival_date <= departure_date;
--   SELECT id FROM company_information;
-- ============================================================


-- ─── CHECK constraints ──────────────────────────────────────

-- conversations.status: 'open' | 'closed' | 'waiting_admin'.
-- These three are the only values the app writes (database.js
-- closeConversation/reopenConversation/setConversationWaitingAdmin,
-- getOrCreateConversation) or reads (InboxPage). The column was bare TEXT.
ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('open', 'closed', 'waiting_admin')) NOT VALID;

-- contact_inquiries.status: 'new' | 'read' | 'resolved'.
-- Matches STATUS_CONFIG in ContactInquiriesPage.jsx. ('read' is currently
-- never written by any code path, but the UI renders it, so it stays legal.)
ALTER TABLE public.contact_inquiries
  DROP CONSTRAINT IF EXISTS contact_inquiries_status_check;
ALTER TABLE public.contact_inquiries
  ADD CONSTRAINT contact_inquiries_status_check
  CHECK (status IN ('new', 'read', 'resolved')) NOT VALID;

-- Money can never go negative. update_order_payment_totals already clamps
-- with GREATEST(0, ...); this makes the invariant explicit and catches any
-- future writer that forgets.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_amount_paid_non_negative;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_amount_paid_non_negative
  CHECK (amount_paid >= 0) NOT VALID;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_remaining_balance_non_negative;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_remaining_balance_non_negative
  CHECK (remaining_balance >= 0) NOT VALID;

-- NOTE: the trips arrival_date > departure_date constraint is NOT added here.
-- Applying it revealed pre-existing violating rows. It has moved to
-- 20260803131000_trips_date_constraint.sql, to be applied after that data is
-- reconciled — see the header of that file for why it must not be added early.

-- company_information is a singleton enforced only by convention (every
-- reader hardcodes this UUID, and getCompanyInformation() uses .single(),
-- which throws if a second row ever appears). Make it structural.
ALTER TABLE public.company_information
  DROP CONSTRAINT IF EXISTS company_information_singleton;
ALTER TABLE public.company_information
  ADD CONSTRAINT company_information_singleton
  CHECK (id = '00000000-0000-0000-0000-000000000001') NOT VALID;


-- ─── Validate against existing rows ─────────────────────────
-- Verified clean on the live database 2026-08-04. If any of these fails on
-- another environment, the constraint above remains in place as NOT VALID
-- (new writes still guarded); fix the offending rows, then re-run that one
-- VALIDATE on its own.
ALTER TABLE public.conversations       VALIDATE CONSTRAINT conversations_status_check;
ALTER TABLE public.contact_inquiries   VALIDATE CONSTRAINT contact_inquiries_status_check;
ALTER TABLE public.orders              VALIDATE CONSTRAINT orders_amount_paid_non_negative;
ALTER TABLE public.orders              VALIDATE CONSTRAINT orders_remaining_balance_non_negative;
ALTER TABLE public.company_information VALIDATE CONSTRAINT company_information_singleton;


-- ─── Missing indexes ────────────────────────────────────────
-- Every one of these backs a query that already exists in the codebase.

-- create_admin_notifications_rpc() scans WHERE role='admin' on EVERY admin
-- notification (i.e. every booking, inquiry and feedback submission), and
-- createAnnouncement() scans WHERE role='customer' to fan out.
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);

-- Every report, every list page, and the get_sales_summary() monthly CTE
-- order or filter by created_at.
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);

-- get_featured_deliveries() — partial, because the true rows are a tiny
-- fraction of the table.
CREATE INDEX IF NOT EXISTS idx_orders_featured
  ON public.orders(featured_at DESC)
  WHERE featured_on_website = true;

-- getUnreadNotificationCount() runs exactly this predicate on every page load
-- for every signed-in user.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON public.notifications(user_id, is_read);

-- Both unread-count queries: getAdminConversations() (sender_role='customer',
-- is_read=false) and getCustomerUnreadChatCount() (sender_role='admin').
CREATE INDEX IF NOT EXISTS idx_chat_messages_unread
  ON public.chat_messages(conversation_id, sender_role, is_read);

-- "Customers can read own feedback" RLS predicate, and checkIfFeedbackExists.
CREATE INDEX IF NOT EXISTS idx_customer_feedback_customer_id
  ON public.customer_feedback(customer_id);

-- ContactInquiriesPage filters and counts by status.
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_status
  ON public.contact_inquiries(status);

-- Trip pickers and the customer Trips page order by departure_date.
CREATE INDEX IF NOT EXISTS idx_trips_departure_date
  ON public.trips(departure_date);


-- ─── Redundant indexes ──────────────────────────────────────
-- Both duplicate an index PostgreSQL already created for a UNIQUE constraint.
-- Duplicates cost write throughput and buffer cache for zero read benefit.
DROP INDEX IF EXISTS idx_orders_tracking;          -- orders.tracking_number is UNIQUE
DROP INDEX IF EXISTS idx_conversations_customer_id; -- conversations.customer_id is UNIQUE
