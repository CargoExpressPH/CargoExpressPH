-- Add the missing structured address columns for sender/receiver.
--
-- BookShipmentPage and AdminCreateBookingPage have always collected Barangay,
-- Street/Subdivision, Lot/Block/Purok and Landmark as separate form fields,
-- but every booking-creation payload only ever forwarded the single
-- concatenated string built by buildFullAddress() into `sender_address` /
-- `receiver_address` — the discrete values were discarded the moment they
-- were folded into that string. `orders` never had columns for them.
--
-- That is the actual cause of the "Edit Sender & Receiver Details" modal
-- showing Barangay/Street/Landmark as blank on open: it reads
-- `order.sender_barangay` etc., and that column has never existed, so the
-- value was always undefined — for every order, not just old ones. This is
-- not a React state bug; there was nothing in the row to initialize from.
--
-- These columns are nullable and NOT backfilled from the existing
-- `sender_address` / `receiver_address` text. That string is a
-- human-punctuated join ("Lot 4, Rizal St, Poblacion, Tagbilaran City, Bohol
-- (Landmark: near the church)") with no reliable, lossless way to split back
-- into its parts — attempting to parse it would risk silently writing WRONG
-- values into structured fields, which is worse than leaving them blank and
-- visibly incomplete. Existing orders will show these three fields empty in
-- the edit modal until someone fills them in once; every booking created
-- after this migration (see BookShipmentPage.jsx / AdminCreateBookingPage.jsx)
-- populates them from the start.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS sender_barangay   TEXT,
  ADD COLUMN IF NOT EXISTS sender_street     TEXT,
  ADD COLUMN IF NOT EXISTS sender_lot_block  TEXT,
  ADD COLUMN IF NOT EXISTS sender_landmark   TEXT,
  ADD COLUMN IF NOT EXISTS receiver_barangay  TEXT,
  ADD COLUMN IF NOT EXISTS receiver_street    TEXT,
  ADD COLUMN IF NOT EXISTS receiver_lot_block TEXT,
  ADD COLUMN IF NOT EXISTS receiver_landmark  TEXT;

COMMENT ON COLUMN public.orders.sender_barangay IS
  'Structured address component captured at booking time (or via Edit Sender & Receiver Details). NULL on orders created before 20260910025000 — never captured; only the concatenated sender_address existed.';
COMMENT ON COLUMN public.orders.receiver_barangay IS
  'Structured address component captured at booking time (or via Edit Sender & Receiver Details). NULL on orders created before 20260910025000 — never captured; only the concatenated receiver_address existed.';
