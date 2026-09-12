-- Cover the audit-user foreign key so profile updates/deletes do not require
-- scanning the refund ledger.
CREATE INDEX payment_refunds_initiated_by_idx
  ON public.payment_refunds (initiated_by)
  WHERE initiated_by IS NOT NULL;
