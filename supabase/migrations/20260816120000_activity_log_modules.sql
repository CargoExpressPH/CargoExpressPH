-- ============================================================
-- Activity logging: stop silently dropping whole modules.
--
-- `activity_logs.module` is a CHECK-constrained enum, and two call sites have
-- been writing a value that is not in it:
--
--     SalesPage.jsx    → module: 'Sales & Reports'
--     ReportsPage.jsx  → module: 'Sales & Reports'
--
-- Every one of those inserts raised 23514. `logActivity()` swallows its errors
-- into a console.warn on purpose — an audit write must never break the action
-- it is describing — so the failures were invisible, and printing or exporting
-- a report has never appeared in the Activity Logs page since those calls were
-- added. Admitting the value is the fix; the alternative (rewriting the call
-- sites to 'System') would file report exports next to company-settings edits
-- and lose the distinction the author was reaching for.
--
-- 'Customers' and 'Feedback' are admitted at the same time so the modules the
-- admin surfaces actually act on all have somewhere to land.
-- ============================================================

ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_module_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_module_check CHECK (
  module = ANY (ARRAY[
    'Orders',
    'Trips',
    'Payments',
    'Chat',
    'Authentication',
    'System',
    'Sales & Reports',
    'Customers',
    'Feedback'
  ])
);

-- The non-admin allowlist is unchanged and deliberately narrow: a customer may
-- only ever author 'Orders' (their own booking), 'Authentication' (their own
-- login) and 'Chat' (written on their behalf by log_customer_chat_message).
-- The new modules are admin-only surfaces, so they are not added to it.
CREATE OR REPLACE FUNCTION public.guard_activity_log_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_name     TEXT;
BEGIN
  -- Service role / trigger-internal writes: nothing to attribute, leave as-is.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.is_admin();

  IF NOT v_is_admin AND NEW.module NOT IN ('Orders', 'Authentication', 'Chat') THEN
    RAISE EXCEPTION 'Not allowed to write % activity logs', NEW.module;
  END IF;

  SELECT name INTO v_name FROM public.profiles WHERE id = v_uid;

  -- The control that actually matters: a customer-authored row can never
  -- carry a staff identity, whatever module it claims.
  NEW.admin_id   := v_uid;
  NEW.admin_name := COALESCE(NULLIF(btrim(v_name), ''), 'Unknown Admin');

  RETURN NEW;
END;
$function$;
