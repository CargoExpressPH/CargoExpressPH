-- Restore original policy expressions captured before the optimization.
-- Use only to undo the matching migration on the same project schema.
SET LOCAL lock_timeout = '5s';

-- activity_logs: Admins can insert activity logs
ALTER POLICY "Admins can insert activity logs" ON "public"."activity_logs"
  WITH CHECK (is_admin());

-- activity_logs: Admins can view activity logs
ALTER POLICY "Admins can view activity logs" ON "public"."activity_logs"
  USING (is_admin());

-- activity_logs: Users can insert their own activity logs
ALTER POLICY "Users can insert their own activity logs" ON "public"."activity_logs"
  WITH CHECK ((admin_id = auth.uid()));

-- announcements: Admins can manage announcements
ALTER POLICY "Admins can manage announcements" ON "public"."announcements"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

-- chat_messages: Admins update messages
ALTER POLICY "Admins update messages" ON "public"."chat_messages"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

-- chat_messages: Customers mark admin messages read
ALTER POLICY "Customers mark admin messages read" ON "public"."chat_messages"
  USING ((((sender_role)::text = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = chat_messages.conversation_id) AND (conversations.customer_id = auth.uid()))))))
  WITH CHECK ((((sender_role)::text = 'admin'::text) AND (is_read = true) AND (EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = chat_messages.conversation_id) AND (conversations.customer_id = auth.uid()))))));

-- chat_messages: Users insert messages in allowed conversations
ALTER POLICY "Users insert messages in allowed conversations" ON "public"."chat_messages"
  WITH CHECK (((sender_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = chat_messages.conversation_id) AND ((conversations.customer_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM profiles
          WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text))))))))));

-- chat_messages: Users view messages in allowed conversations
ALTER POLICY "Users view messages in allowed conversations" ON "public"."chat_messages"
  USING ((EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = chat_messages.conversation_id) AND ((conversations.customer_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM profiles
          WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))))))));

-- company_information: Allow admin full access
ALTER POLICY "Allow admin full access" ON "public"."company_information"
  USING (is_admin())
  WITH CHECK (is_admin());

-- contact_inquiries: Admins can delete contact inquiries
ALTER POLICY "Admins can delete contact inquiries" ON "public"."contact_inquiries"
  USING (is_admin());

-- contact_inquiries: Admins can update contact inquiries
ALTER POLICY "Admins can update contact inquiries" ON "public"."contact_inquiries"
  USING (is_admin())
  WITH CHECK (is_admin());

-- contact_inquiries: Admins can view inquiries
ALTER POLICY "Admins can view inquiries" ON "public"."contact_inquiries"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

-- conversations: Admins can update conversations
ALTER POLICY "Admins can update conversations" ON "public"."conversations"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

-- conversations: Admins insert conversations
ALTER POLICY "Admins insert conversations" ON "public"."conversations"
  WITH CHECK ((is_admin() AND (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = conversations.customer_id) AND ((profiles.role)::text = 'customer'::text))))));

-- conversations: Customers can update own conversations
ALTER POLICY "Customers can update own conversations" ON "public"."conversations"
  USING ((customer_id = auth.uid()));

-- conversations: Customers insert own conversations
ALTER POLICY "Customers insert own conversations" ON "public"."conversations"
  WITH CHECK ((customer_id = auth.uid()));

-- conversations: Customers view own conversations
ALTER POLICY "Customers view own conversations" ON "public"."conversations"
  USING (((customer_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text))))));

-- customer_feedback: Admins can manage all feedback
ALTER POLICY "Admins can manage all feedback" ON "public"."customer_feedback"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

-- customer_feedback: Customers can insert own delivered-order feedback
ALTER POLICY "Customers can insert own delivered-order feedback" ON "public"."customer_feedback"
  WITH CHECK (((auth.uid() = customer_id) AND (EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = customer_feedback.order_id) AND (o.user_id = auth.uid()) AND ((o.status)::text = 'Delivered'::text))))));

-- customer_feedback: Customers can read own feedback
ALTER POLICY "Customers can read own feedback" ON "public"."customer_feedback"
  USING ((auth.uid() = customer_id));

-- legal_consents: Admins can view legal consents
ALTER POLICY "Admins can view legal consents" ON "public"."legal_consents"
  USING (is_admin());

-- legal_consents: Users can view own legal consents
ALTER POLICY "Users can view own legal consents" ON "public"."legal_consents"
  USING ((user_id = auth.uid()));

-- order_status_events: Users view own order status events
ALTER POLICY "Users view own order status events" ON "public"."order_status_events"
  USING ((is_admin() OR (EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = order_status_events.order_id) AND (o.user_id = auth.uid()))))));

-- orders: Admins can delete orders
ALTER POLICY "Admins can delete orders" ON "public"."orders"
  USING (is_admin());

-- orders: Admins can update orders
ALTER POLICY "Admins can update orders" ON "public"."orders"
  USING (is_admin())
  WITH CHECK (is_admin());

-- orders: Users can create own orders
ALTER POLICY "Users can create own orders" ON "public"."orders"
  WITH CHECK (((user_id = auth.uid()) AND ((status)::text = ANY ((ARRAY['Pending'::character varying, 'Assigned'::character varying])::text[])) AND (actual_weight IS NULL) AND (payment_method IS NULL) AND ((payment_status)::text = 'unpaid'::text) AND (amount_paid = (0)::numeric) AND (pickup_photos = '[]'::jsonb) AND (delivery_photos = '[]'::jsonb) AND (service_area_status = ANY (ARRAY['standard'::text, 'for_review'::text])) AND (service_area_remarks IS NULL)));

-- orders: Users can view own orders
ALTER POLICY "Users can view own orders" ON "public"."orders"
  USING (((user_id = auth.uid()) OR is_admin()));

-- payment_attempts: Admins can manage payment attempts
ALTER POLICY "Admins can manage payment attempts" ON "public"."payment_attempts"
  USING (is_admin())
  WITH CHECK (is_admin());

-- payment_transactions: Admins can view payment transactions
ALTER POLICY "Admins can view payment transactions" ON "public"."payment_transactions"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));

-- photo_storage_events: Admins view photo storage events
ALTER POLICY "Admins view photo storage events" ON "public"."photo_storage_events"
  USING (is_admin());

-- profiles: Admins can update profiles
ALTER POLICY "Admins can update profiles" ON "public"."profiles"
  USING (is_admin())
  WITH CHECK (is_admin());

-- profiles: Admins can view profiles
ALTER POLICY "Admins can view profiles" ON "public"."profiles"
  USING (is_admin());

-- profiles: Users can insert own profile
ALTER POLICY "Users can insert own profile" ON "public"."profiles"
  WITH CHECK ((id = auth.uid()));

-- profiles: Users can update own profile
ALTER POLICY "Users can update own profile" ON "public"."profiles"
  USING ((id = auth.uid()))
  WITH CHECK ((id = auth.uid()));

-- profiles: Users can view own profile
ALTER POLICY "Users can view own profile" ON "public"."profiles"
  USING ((id = auth.uid()));

-- trips: Admins can manage trips
ALTER POLICY "Admins can manage trips" ON "public"."trips"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = 'admin'::text)))));
