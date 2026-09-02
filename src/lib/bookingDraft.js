// Route and trip are lightweight setup choices: selecting either one alone
// should never trap a customer behind a destructive-change warning. These are
// the fields that represent actual customer-entered booking data worth guarding.
export const BOOKING_DATA_FIELDS = [
  'sender_name',
  'sender_phone',
  'sender_facebook',
  'sender_lot_block',
  'sender_street',
  'sender_barangay',
  'sender_city',
  'sender_province',
  'sender_landmark',
  'sender_other_province',
  'receiver_name',
  'receiver_phone',
  'receiver_facebook',
  'receiver_lot_block',
  'receiver_street',
  'receiver_barangay',
  'receiver_city',
  'receiver_province',
  'receiver_landmark',
  'package_description',
  'notes',
];

export const hasMeaningfulBookingData = (form = {}) => (
  BOOKING_DATA_FIELDS.some((field) => String(form[field] ?? '').trim().length > 0)
);
