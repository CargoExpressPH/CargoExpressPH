-- Backfill email usage logs from September 1 and 2 (from Resend CSV export)
INSERT INTO public.email_usage_logs (source, sent_count, failed_count, created_at)
VALUES 
  ('daily_reminders', 2, 0, '2026-09-01 00:00:05+00'),
  ('daily_reminders', 2, 0, '2026-09-02 00:00:06+00');
