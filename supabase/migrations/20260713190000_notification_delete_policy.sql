-- Migration: Allow customers to delete their own notifications
-- This adds the missing DELETE RLS policy so that the client-side
-- deleteNotification / deleteAllNotifications functions actually persist.

-- Drop first to make migration idempotent
DROP POLICY IF EXISTS "Users can delete own notifications" ON public.notifications;

CREATE POLICY "Users can delete own notifications" ON public.notifications
  FOR DELETE USING (user_id = auth.uid());
