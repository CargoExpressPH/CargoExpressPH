export const validateName = (name) => {
  if (!name || !name.trim()) return 'Required field.';
  
  // Allow letters (including diacritics), spaces, dots, hyphens, commas, apostrophes
  // Reject if it contains numbers or other special characters
  const isValid = /^[A-Za-zñÑáéíóúÁÉÍÓÚüÜ\s\.\-,'`]+$/.test(name);
  if (!isValid) {
    return 'Please enter a valid name (letters only).';
  }
  
  if (name.trim().length < 2) return 'Name must be at least 2 characters long.';
  if (name.trim().length > 100) return 'Name is too long.';
  
  return null;
};

export const validateAddressLine = (line) => {
  if (!line || !line.trim()) return 'Required field.';
  
  // Address should contain at least one letter or number
  const hasAlphanumeric = /[A-Za-z0-9]/.test(line);
  if (!hasAlphanumeric) {
    return 'Must contain valid words or numbers.';
  }
  
  return null;
};

export const validateFacebookName = (name) => {
  if (!name || !name.trim()) return 'Required field.';
  
  const hasAlphanumeric = /[A-Za-z0-9]/.test(name);
  if (!hasAlphanumeric) {
    return 'Please enter a valid Facebook name or link.';
  }
  
  return null;
};
