export const formatCommaNumber = (val) => {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/,/g, '');
  if (!str) return '';
  if (isNaN(str) && str !== '.' && !str.endsWith('.')) return str; 
  const parts = str.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
};

export const parseCommaNumber = (val) => {
  if (val === null || val === undefined) return '';
  return String(val).replace(/,/g, '');
};
