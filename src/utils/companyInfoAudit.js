const FIELD_LABELS = {
  name: 'Company name',
  short_description: 'Short description',
  long_description: 'Long description',
  story: 'Company story',
  core_values: 'Core values',
  banner_image_url: 'Banner image',
  banner_title: 'Banner title',
  banner_description: 'Banner description',
  banner_button_text: 'Banner button text',
  banner_button_link: 'Banner button link',
  email: 'Email',
  facebook: 'Facebook link',
  smart_phone: 'Smart phone number',
  globe_phone: 'Globe phone number',
  manila_address: 'Manila address',
  bohol_address: 'Bohol address',
  default_price_per_kg: 'Default price per kg',
  default_capacity: 'Default capacity',
  features: 'Company features',
  coverage: 'Coverage areas',
};

const isEmpty = value => value === null || value === undefined || value === '';

const valuesMatch = (left, right) => {
  if (isEmpty(left) && isEmpty(right)) return true;
  if (Object.is(left, right)) return true;

  if (left && right && typeof left === 'object' && typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  return false;
};

const formatPrice = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'not set';

  return `₱${amount.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}/kg`;
};

const formatCapacity = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'not set';

  return `${amount.toLocaleString('en-PH')} kg`;
};

const summarizeValue = (field, value) => {
  if (isEmpty(value)) return 'not set';
  if (field === 'default_price_per_kg') return formatPrice(value);
  if (field === 'default_capacity') return formatCapacity(value);

  if (Array.isArray(value)) {
    return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  }

  if (typeof value === 'object') return 'updated settings';

  const text = String(value).trim();
  if (!text) return 'not set';
  const shortened = text.length > 80 ? `${text.slice(0, 77)}…` : text;
  return `“${shortened}”`;
};

/**
 * Build a readable, bounded audit message for the simple Company Information
 * form. Deep comparison matters here: the saved snapshot is parsed from JSON,
 * so unchanged arrays otherwise have different references and stringify as
 * "[object Object]" when only the price was edited.
 */
export const buildCompanyInfoAuditDetails = (previous = {}, current = {}) => {
  const changedFields = Object.keys(current).filter(field => !valuesMatch(previous[field], current[field]));

  if (changedFields.length === 0) return 'Saved without changes.';

  return changedFields.map(field => {
    const label = FIELD_LABELS[field] || field.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
    return `${label} changed from ${summarizeValue(field, previous[field])} to ${summarizeValue(field, current[field])}.`;
  }).join(' ');
};
