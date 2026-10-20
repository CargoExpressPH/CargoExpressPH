// Masks a person's name for on-screen verification: first and last letter of
// each word stay, the middle becomes asterisks ("Bea Sarong" -> "B*a S****g").
// Enough for a driver to match against the person they are handing a box to,
// not enough to read the name off a shared screen.
export const maskPersonName = (name) => String(name || '')
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((word) => {
    const chars = Array.from(word);
    if (chars.length === 1) return chars[0];
    if (chars.length === 2) return `${chars[0]}*`;
    return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
  })
  .join(' ');

/** "09171234567" -> "0917•••4567" (display only; the tel: link keeps the full number). */
export const maskPhone = (phone) => {
  const digits = String(phone || '').replace(/\s+/g, '');
  if (digits.length < 8) return digits ? '••••' : '';
  return `${digits.slice(0, 4)}•••${digits.slice(-4)}`;
};
