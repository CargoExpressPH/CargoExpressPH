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
  default_capacity: 1000,
  features,
  coverage,
};

const currentPriceOnly = JSON.parse(JSON.stringify(previous));
currentPriceOnly.default_price_per_kg = 75;

const priceDetails = buildCompanyInfoAuditDetails(previous, currentPriceOnly);
assert.equal(priceDetails, 'Default price per kg changed from ₱80.00/kg to ₱75.00/kg.');
assert.doesNotMatch(priceDetails, /\[object Object\]/);
assert.doesNotMatch(priceDetails, /features|coverage/i);

const currentCapacityOnly = JSON.parse(JSON.stringify(previous));
currentCapacityOnly.default_capacity = 1200;

const capacityDetails = buildCompanyInfoAuditDetails(previous, currentCapacityOnly);
assert.equal(capacityDetails, 'Default capacity changed from 1,000 kg to 1,200 kg.');
assert.doesNotMatch(capacityDetails, /\[object Object\]/);

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
