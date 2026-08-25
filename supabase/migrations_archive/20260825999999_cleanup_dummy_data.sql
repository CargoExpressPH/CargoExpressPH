DELETE FROM public.activity_logs;
DELETE FROM public.contact_inquiries;
DELETE FROM public.customer_feedback;
DELETE FROM public.notifications;
DELETE FROM public.chat_messages;
DELETE FROM public.conversations;
DELETE FROM public.payment_attempts;
DELETE FROM public.payment_transactions;
DELETE FROM public.order_status_events;
DELETE FROM public.orders;
DELETE FROM public.trips;
DELETE FROM public.announcements;

DELETE FROM auth.users 
WHERE email != 'maybesmd@gmail.com' 
AND id IN (
  SELECT id FROM public.profiles WHERE role != 'admin'
);
