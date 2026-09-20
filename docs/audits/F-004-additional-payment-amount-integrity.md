# F-004 — Additional payments can disagree with the order or exceed the balance

- **Status:** Confirmed
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Verified:** 2026-09-11
- **Area:** Manual and additional payment recording

## Finding

The deployed `record_additional_payment` RPC labels a transaction using the undiscounted `shipping_cost`. It also validates that the amount is positive but does not enforce a maximum equal to the order's current payable balance.

## Evidence

The live function contains logic equivalent to:

```sql
SELECT COALESCE(SUM(amount), 0) + p_amount INTO v_paid_after;
v_label := CASE
  WHEN v_paid_after >= COALESCE(v_order.shipping_cost, 0)
    THEN 'paid'
  ELSE 'partial'
END;
```

It does not use `discount_amount` or `order_payable_amount()` for this label and has no server-side comparison against the current remaining balance.

The current frontend invokes this function from [`src/lib/database.js`](../src/lib/database.js#L2667). The RPC is admin-protected, but it is still a trusted server-side ledger path.

## Safe reproduction

Using the live discounted order:

```text
Payable: 3,350
Already paid: 3,000
Additional payment: 350
```

The order trigger can reach paid status based on the discounted payable amount, while this RPC can label the transaction `partial` because 3,350 is less than the raw 3,850 shipping cost.

An amount greater than the current balance is also accepted by the RPC unless another caller-side rule prevents it.

No modifying payment request was sent during the audit.

## Impact

The payment transaction and order can disagree about whether the order is fully paid. Oversized administrative submissions can create overpayment records without an explicit overpayment policy.

## Recommended fix

- Calculate the label from `order_payable_amount(shipping_cost, discount_amount)`.
- Enforce a server-side amount ceiling against the current balance.
- Define explicit handling for overpayments, refunds, and rounding.
- Add tests for discounted final payments, duplicate requests, and overpayments.
