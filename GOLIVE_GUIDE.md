# Going Live — PayMongo (GCash) Production Checklist

The app runs the **exact same code** in test and live mode. The mode is decided
entirely by which keys are loaded:

| Key | Test mode (current) | Live mode |
|---|---|---|
| `VITE_PAYMONGO_PUBLIC_KEY` (`.env` → bundle) | `pk_test_...` | `pk_live_...` |
| `PAYMONGO_SECRET_KEY` (Edge secret) | test value | live value |
| `PAYMONGO_WEBHOOK_SECRET` (Edge secret) | test value | live value |

**Do not mix modes** — a live public key with a test secret (or vice versa)
fails every capture and every webhook silently.

---

## Prerequisites

1. PayMongo account with **completed business verification** (KYC). Test mode
   works on any account; live mode requires an approved merchant profile.
2. Your live keys from the PayMongo Dashboard → Developers → Keys.
3. Supabase CLI logged in (`npx supabase login`) — you already have
   `SUPABASE_PERSONAL_ACCESS_TOKEN` in `.env`.

---

## Steps

### 1. Swap the browser key

`.env`:

```ini
VITE_PAYMONGO_PUBLIC_KEY=pk_live_xxxxxxxxxxxxxxxx
```

This key is inlined into the bundle at build time — changing it alone does
**nothing** until step 3 (redeploy).

### 2. Swap the Edge Function secrets

```bash
npx supabase secrets set PAYMONGO_SECRET_KEY=sk_live_xxxxxxxx PAYMONGO_WEBHOOK_SECRET=whsec_live_xxxxxxxx
```

`PAYMONGO_SECRET_KEY` must be the **live** secret key matching the live public
key. `PAYMONGO_WEBHOOK_SECRET` must match what you enter in step 4.

### 3. Configure the webhook in the PayMongo Dashboard

PayMongo Dashboard → Developers → Webhooks → Add webhook:

- **URL:** `https://duigaivxgxlnjmfienhg.supabase.co/functions/v1/paymongo-webhook`
- **Events:** `source.chargeable`, `source.paid`, `payment.paid` (any event is
  fine; the function verifies the HMAC before parsing)
- **Secret:** copy the `whsec_live_...` value from step 2

The webhook is the safety net for customers who close the browser mid-payment.
The in-app poll also reconciles, so a missing webhook is a gap, not a
crash — but configure it, because that is what "paid but never seen" orders
depend on.

### 4. Redeploy

```bash
git add . && git commit -m "chore: go live with PayMongo"
git push origin main   # Vercel auto-deploys
```

Verify on the live site: DevTools → Sources → search the bundle for
`pk_live_` (the old `pk_test_` must be gone).

### 5. Verify with a real ₱1 payment

1. Log in to the live site as an admin, open an order's pickup/additional
   payment, choose GCash, and process it for **₱1**.
2. On the phone: scan the QR (or tap **Open GCash**) → the real GCash app
   opens with the branded consent screen → approve.
3. Expect: panel flips to "Payment received", the ledger gains a `gcash` row,
   `orders.payment_status` becomes `paid`, and the PayMongo dashboard shows
   the captured payment.
4. Also test the **webhook path**: pay without returning to the tab, close
   it, reopen the order page 1–2 minutes later — the payment must already be
   reconciled. (`payment_attempts` row status `reconciled`.)

### 6. Rollback

To go back to test mode, reverse steps 1–3 (test keys + test webhook secret)
and redeploy. The DB is untouched by the mode switch — ledger rows and
payments are mode-agnostic.

---

## Test mode — still fine to keep developing

Nothing in the app requires live keys to develop against. Test mode gives
you the full pipeline (create → register → authorize on the sandbox page →
capture → reconcile → ledger) with fake money. Keep `pk_test_` until you are
ready for the real ₱1 verification above.

## Notes

- Redirect URLs use `window.location.origin` at runtime — they follow the
  deployed site automatically, no config needed.
- The GCash-branded payment page (blue GCash consent screen) only appears in
  **live** mode; the sandbox shows a plain "Authorize Test Payment" page.
- PayMongo dashboard payments are labeled `[TEST]` in test mode — a live
  dashboard must show no `[TEST]` suffix on your real payment.