export const cleanAddressPart = (value) => {
  if (value == null) return '';

  return value
    .toString()
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/,+/g, ',')
    .trim();
};

export const joinAddressParts = (parts = []) => {
  const cleaned = parts.flat().map(cleanAddressPart).filter(Boolean);
  const deduplicated = cleaned.filter((part, index) => index === 0 || part.toLowerCase() !== cleaned[index - 1].toLowerCase());
  return deduplicated.join(', ');
};

export const buildFullAddress = ({ lotBlock, street, barangay, city, province, landmark } = {}) => {
  const address = joinAddressParts([lotBlock, street, barangay, city, province]);
  const normalizedLandmark = cleanAddressPart(landmark);

  if (!normalizedLandmark) return address;
  return address ? `${address} (Landmark: ${normalizedLandmark})` : `(Landmark: ${normalizedLandmark})`;
};

export const normalizeProfileAddressFields = (profile = {}) => ({
  address_lot_block: cleanAddressPart(profile.address_lot_block),
  address_street: cleanAddressPart(profile.address_street),
  address_barangay: cleanAddressPart(profile.address_barangay),
  address_city: cleanAddressPart(profile.address_city),
  address_province: cleanAddressPart(profile.address_province),
  address_landmark: cleanAddressPart(profile.address_landmark),
});

export const buildProfileAddress = (profile = {}) => buildFullAddress({
  lotBlock: profile.address_lot_block,
  street: profile.address_street,
  barangay: profile.address_barangay,
  city: profile.address_city,
  province: profile.address_province,
  landmark: profile.address_landmark,
});
