import { buildFullAddress } from './address';

/**
 * Sender/receiver display values, derived from the structured columns.
 *
 * orders.sender_name / receiver_name / sender_address / receiver_address are
 * no longer stored (20260926110000_simplify_stage2_drop_columns.sql). These
 * helpers are the frontend half of the single formatting rule; the database
 * half is public.format_person_name() / public.format_address(), and
 * scripts/db-simplification-pgtest checks both produce identical output.
 *
 * The legacy value on the row is used only as a fallback, for responses that
 * carry no parts at all (e.g. RPCs that return an already-formatted or masked
 * name, or a row from an older response shape).
 */

/** Blank parts skipped, whitespace runs collapsed, trimmed. '' when blank. */
export const formatPersonName = (first, last) =>
  [first, last]
    .map((part) => String(part ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');

/** Full name of `side` ('sender' | 'receiver') on an order row. */
export const orderPartyName = (order, side) => {
  if (!order) return '';
  const derived = formatPersonName(order[`${side}_first_name`], order[`${side}_last_name`]);
  return derived || order[`${side}_name`] || '';
};

/** Full address of `side` ('sender' | 'receiver') on an order row. */
export const orderPartyAddress = (order, side) => {
  if (!order) return '';
  const derived = buildFullAddress({
    lotBlock: order[`${side}_lot_block`],
    street: order[`${side}_street`],
    barangay: order[`${side}_barangay`],
    city: order[`${side}_city`],
    province: order[`${side}_province`],
    landmark: order[`${side}_landmark`],
  });
  return derived || order[`${side}_address`] || '';
};

/** Column list for explicit selects that need to display both names. */
export const ORDER_PARTY_NAME_COLUMNS =
  'sender_first_name, sender_last_name, receiver_first_name, receiver_last_name';
