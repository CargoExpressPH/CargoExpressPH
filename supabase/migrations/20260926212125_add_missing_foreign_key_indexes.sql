-- Cover the foreign keys reported by the Supabase unindexed_foreign_keys advisor.
-- The affected tables were empty or one 8 KB page at migration time, so a
-- transactional build is short and keeps this migration atomic.
-- The compound legal-consent index follows the foreign key's column order.

CREATE INDEX IF NOT EXISTS idx_announcements_author_id_fk
  ON public.announcements (author_id);

CREATE INDEX IF NOT EXISTS idx_cancellation_settlement_history_changed_by_fk
  ON public.cancellation_settlement_history (changed_by);

CREATE INDEX IF NOT EXISTS idx_cancellation_settlements_decided_by_fk
  ON public.cancellation_settlements (decided_by);

CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_id_fk
  ON public.chat_messages (sender_id);

CREATE INDEX IF NOT EXISTS idx_contact_inquiries_assigned_admin_id_fk
  ON public.contact_inquiries (assigned_admin_id);

CREATE INDEX IF NOT EXISTS idx_email_subscriptions_updated_by_fk
  ON public.email_subscriptions (updated_by);

CREATE INDEX IF NOT EXISTS idx_legal_consents_document_type_document_version_fk
  ON public.legal_consents (document_type, document_version);

CREATE INDEX IF NOT EXISTS idx_order_status_events_changed_by_fk
  ON public.order_status_events (changed_by);

CREATE INDEX IF NOT EXISTS idx_orders_discount_applied_by_fk
  ON public.orders (discount_applied_by);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_created_by_fk
  ON public.payment_attempts (created_by);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_admin_id_fk
  ON public.payment_transactions (admin_id);

CREATE INDEX IF NOT EXISTS idx_photo_storage_events_created_by_fk
  ON public.photo_storage_events (created_by);

CREATE INDEX IF NOT EXISTS idx_photo_storage_settings_updated_by_fk
  ON public.photo_storage_settings (updated_by);

CREATE INDEX IF NOT EXISTS idx_trips_created_by_fk
  ON public.trips (created_by);
