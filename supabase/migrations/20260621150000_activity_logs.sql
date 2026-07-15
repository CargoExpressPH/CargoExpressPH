-- Activity Log / Audit Trail for CargoExpress PH
-- Immutable records: INSERT and SELECT only for admins. No UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  admin_name TEXT NOT NULL DEFAULT 'Unknown Admin',
  module TEXT NOT NULL CHECK (module IN ('Orders', 'Trips', 'Payments', 'Chat', 'Authentication', 'System')),
  action TEXT NOT NULL,
  record_type TEXT DEFAULT NULL,   -- 'order', 'trip', 'payment', 'conversation', etc.
  record_id UUID DEFAULT NULL,     -- FK to related record (not enforced to support multiple tables)
  record_ref TEXT DEFAULT NULL,    -- Human-readable reference e.g. CE-2026-001, TRIP-001
  previous_value JSONB DEFAULT NULL,
  new_value JSONB DEFAULT NULL,
  details TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_activity_logs_admin_id ON public.activity_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_module ON public.activity_logs(module);
CREATE INDEX IF NOT EXISTS idx_activity_logs_record_id ON public.activity_logs(record_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON public.activity_logs(created_at DESC);

-- RLS: Admins can read all logs and insert new ones. No update/delete allowed.
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view activity logs"
  ON public.activity_logs
  FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins can insert activity logs"
  ON public.activity_logs
  FOR INSERT
  WITH CHECK (public.is_admin());

-- Intentionally NO UPDATE or DELETE policies — logs are immutable from the application layer.
