-- Both audiences have the same SELECT role. Combining the predicates avoids
-- evaluating two permissive policies for every payment-history row while
-- preserving identical admin/customer access.
DROP POLICY IF EXISTS "Admins can view payment refunds" ON public.payment_refunds;
DROP POLICY IF EXISTS "Customers can view own payment refunds" ON public.payment_refunds;

CREATE POLICY "Authorized users can view payment refunds"
  ON public.payment_refunds FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin())
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = payment_refunds.order_id
        AND o.user_id = (SELECT auth.uid())
    )
  );
