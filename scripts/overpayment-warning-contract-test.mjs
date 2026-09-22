// ── Overpayment warning contract (structural + pure-function test) ─────────
//
// This is NOT a browser test. It imports the panel's pure exports
// (derivePaymentCollection / validatePaymentCollection / overpaymentMessage)
// and asserts their behaviour directly, plus a few source assertions about
// the JSX that renders the warning. Actual rendering was not exercised.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPaymentCollectionState, derivePaymentCollection,
  validatePaymentCollection, overpaymentMessage, PAYMENT_FIELDS,
} from '../src/utils/paymentCollection.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const failures = [];
const ok = (d, c, extra) => {
  if (c) { passed++; console.log(`  ok   ${d}`); }
  else { failed++; failures.push(d); console.log(`  FAIL ${d}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
};

const state = (over) => createPaymentCollectionState({ payment_method: 'cash', ...over });
// Delivery: `expected` IS the database's remaining_balance -> authoritative.
const DELIVERY = { expectedAmount: 1000, expectedNoun: 'remaining balance', capAtExpected: true };
// Pickup: `expected` is a pre-weighing estimate -> warn only.
const PICKUP   = { expectedAmount: 1000, expectedNoun: 'total cost', capAtExpected: false };

console.log('== The worded example from the brief: payable ₱1,000, entered ₱1,100 ==');
{
  const d = derivePaymentCollection(state({ amount: '1100' }), DELIVERY);
  ok('the entered amount is kept as ₱1,100, not clamped to ₱1,000', d.collected === 1100, d.collected);
  ok('an excess is detected', d.exceedsExpected === true);
  ok('the excess is exactly ₱100', d.excessAmount === 100, d.excessAmount);
  const msg = overpaymentMessage(d.excessAmount);
  ok('the message states the excess as ₱100.00',
    msg.includes('exceeds the amount still payable by ₱100.00'), msg);
  ok('the message asks the admin to check the amount',
    msg.includes('Please check the amount.'), msg);
  ok('the message says the extra is NOT automatically a tip',
    msg.includes('Extra money is not automatically recorded as a tip.'), msg);
}

console.log('\n== Delivery (authoritative balance): the warning BLOCKS submission ==');
{
  const v = validatePaymentCollection(state({ amount: '1100' }), DELIVERY);
  ok('submission is rejected', v.error !== null, v);
  ok('the rejection carries the shared wording',
    v.error.includes('not automatically recorded as a tip'), v.error);
  ok('the amount field is the one flagged', v.field === PAYMENT_FIELDS.amount, v.field);
  ok('correcting the amount to ₱1,000 clears it',
    validatePaymentCollection(state({ amount: '1000' }), DELIVERY).error === null);
  ok('a partial ₱400 is not an overpayment',
    derivePaymentCollection(state({ amount: '400' }), DELIVERY).exceedsExpected === false);
}

console.log('\n== Pickup (pre-weighing estimate): warns, does NOT block on the estimate ==');
{
  const d = derivePaymentCollection(state({ amount: '1100' }), PICKUP);
  ok('the excess is still surfaced', d.exceedsExpected === true && d.excessAmount === 100);
  ok('but the panel does not block on a non-authoritative figure', d.blocksOnExcess === false);
  const v = validatePaymentCollection(state({ amount: '1100' }), PICKUP);
  ok('so the pickup submission is not refused client-side', v.error === null, v);
  const msg = overpaymentMessage(d.excessAmount, { authoritative: false });
  ok('the pickup wording says the figure is an estimate', msg.includes('is an estimate'), msg);
  ok('the pickup wording says a real excess will be refused on save',
    msg.includes('will be refused'), msg);
}

console.log('\n== The old silent clamp is gone from the source ==');
{
  const src = readFileSync(path.join(REPO, 'src/components/ui/PaymentCollectionPanel.jsx'), 'utf8');
  ok('the amount field no longer rewrites itself to `expected`',
    !src.includes('newAmount = d.expected.toString()'), 'clamp still present');
  ok('the overpayment warning is rendered from the shared wording',
    src.includes('{overpaymentMessage(d.excessAmount, { authoritative:'));
  ok('the warning replaces the "will still be owing" line rather than stacking with it',
    src.includes('{d.expected > 0 && !d.exceedsExpected && ('));
  const pickup = readFileSync(path.join(REPO, 'src/components/ui/PickupModal.jsx'), 'utf8');
  ok('PickupModal still sets capAtExpected: false (no estimate cap on the checkout flow)',
    /capAtExpected:\s*false/.test(pickup));
  const delivery = readFileSync(path.join(REPO, 'src/components/ui/DeliveryModal.jsx'), 'utf8');
  ok('DeliveryModal still sets capAtExpected: true (its figure is authoritative)',
    /capAtExpected:\s*true/.test(delivery));
}

console.log('\n== Backend remains the enforcement point ==');
{
  const sql = readFileSync(path.join(REPO, 'supabase/migrations/20260922150000_pickup_payment_amount_guards.sql'), 'utf8');
  ok('record_pickup_payment rejects a negative amount', /p_amount IS NOT NULL AND p_amount < 0/.test(sql));
  ok('record_pickup_payment caps against the recomputed payable',
    /order_payable_amount\(v_order\.shipping_cost, v_order\.discount_amount\)/.test(sql));
  ok('the server message matches the client wording',
    sql.includes('Extra money is not automatically recorded as a tip.'));
  ok('the cap is refund-aware', /payment_refunds[\s\S]{0,200}succeeded/.test(sql));
}

console.log('\n== No tip/gratuity model is invented anywhere ==');
{
  // Comments DISCUSS tips at length (that is the point — the decision is
  // recorded). What must not exist is a tip in the SCHEMA, so the check is
  // run against the SQL with every `--` comment line stripped out.
  const strip = (f) => readFileSync(path.join(REPO, 'supabase/migrations', f), 'utf8')
    .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
  const mine = [
    '20260922140000_restore_public_tracking_privacy.sql',
    '20260922150000_pickup_payment_amount_guards.sql',
    '20260922160000_person_name_policy.sql',
    '20260922170000_person_name_policy_order_updates.sql',
  ];
  ok('no tip/gratuity column, table or function is created by these migrations',
    mine.every(f => !/\b(tip|tips|tip_amount|gratuity)\b/i.test(
      strip(f).replace(/not automatically recorded as a tip\./g, ''))),
    mine.filter(f => /\b(tip|tips|tip_amount|gratuity)\b/i.test(
      strip(f).replace(/not automatically recorded as a tip\./g, ''))));
  ok('nor does the repository already contain one to reuse',
    !/tip_amount|gratuity|\btips\b/i.test(
      readFileSync(path.join(REPO, 'supabase/schema.sql'), 'utf8')));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
