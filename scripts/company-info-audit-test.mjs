import assert from 'node:assert/strict';
import { buildCompanyInfoAuditDetails } from '../src/utils/companyInfoAudit.js';

const features = [
  { id: '1', title: 'Fast delivery' },
  { id: '2', title: 'Secure handling' },
];
const coverage = [{ id: 'bohol', municipalities: [{ id: 'tagbilaran' }] }];

const previous = {
  name: 'CargoExpress PH',
  default_price_per_kg: 80,
  features,
  coverage,
};

const currentPriceOnly = JSON.parse(JSON.stringify(previous));
currentPriceOnly.default_price_per_kg = 75;

const priceDetails = buildCompanyInfoAuditDetails(previous, currentPriceOnly);
assert.equal(priceDetails, 'Default price per kg changed from ₱80.00/kg to ₱75.00/kg.');
assert.doesNotMatch(priceDetails, /\[object Object\]/);
assert.doesNotMatch(priceDetails, /features|coverage/i);

const featureChange = buildCompanyInfoAuditDetails(previous, {
  ...previous,
  features: [...features, { id: '3', title: 'Island coverage' }],
});
assert.equal(featureChange, 'Company features changed from 2 items to 3 items.');
assert.doesNotMatch(featureChange, /\[object Object\]/);

assert.equal(
  buildCompanyInfoAuditDetails(previous, JSON.parse(JSON.stringify(previous))),
  'Saved without changes.',
);

console.log('Company information audit tests passed.');
