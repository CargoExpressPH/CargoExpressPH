# F-002 — Discounted delivery payment uses the wrong balance

- **Status:** Confirmed
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Verified:** 2026-09-11
- **Area:** Payment settlement and shipment delivery

## Finding

The deployed `record_delivery_payment` PostgreSQL function calculates the projected remaining balance from `orders.shipping_cost`, without subtracting `orders.discount_amount`.

## Evidence

The live production database currently contains one discounted order with these values:

| Field | Value |
|---|---:|
| Shipping cost | 3,850 |
| Discount | 500 |
| Correct payable amount | 3,350 |
| Amount already paid | 3,000 |
| Correct remaining balance | 350 |

The live 12-argument function contains the equivalent of:

```sql
v_total_paid_projected := v_total_paid_projected + GREATEST(COALESCE(p_amount, 0), 0);
v_remaining_projected := GREATEST(
  0,
  COALESCE(v_order.shipping_cost, 0) - v_total_paid_projected
);
```

The customer-facing call is in [`src/lib/database.js`](../src/lib/database.js#L2625), and the deployed function definition is created by [`20260909030000_manual_payment_hardening.sql`](../supabase/migrations/20260909030000_manual_payment_hardening.sql#L246).

## Safe reproduction

For a final payment of 350:

```text
3,850 - (3,000 + 350) = 500
```

The correct discounted calculation is:

```text
3,350 - (3,000 + 350) = 0
```

No modifying payment request was sent during the audit.

## Impact

A customer paying the exact discounted balance can be rejected, incorrectly asked for a promised payment date, or treated as still owing money.

## Recommended fix

Use the same server-side payable calculation everywhere:

```sql
order_payable_amount(shipping_cost, discount_amount)
```

Apply it to the delivery promise-date guard, transaction label, remaining balance, and any payment ceiling. Add regression coverage for discounted partial and final payments.
