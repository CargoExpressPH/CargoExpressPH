# Archived Migrations — DO NOT MOVE BACK TO migrations/

These files are intentionally excluded from `supabase db push`.

- `20260825999999_cleanup_dummy_data.sql` — destructive `DELETE FROM orders/trips/...` used once to clean dummy data. Running it on production would wipe live data. Keep archived for reference only.
