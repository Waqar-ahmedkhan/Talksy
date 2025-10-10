/**
 * Normalize phone to E.164 without '+' (e.g., "923001234567")
 * Supports: +92300..., 92300..., 0300..., 300...
 */
export const normalizePhoneNumber = (phone) => {
  if (!phone) return null;
  
  // Remove all non-digits
  let digits = phone.replace(/\D/g, '');
  
  // Handle common Pakistani formats
  if (digits.startsWith('0')) {
    // 03001234567 → 923001234567
    digits = '92' + digits.substring(1);
  } else if (digits.startsWith('3') && digits.length === 10) {
    // 3001234567 → 923001234567
    digits = '92' + digits;
  } else if (digits.startsWith('92') && digits.length === 12) {
    // Already good
  } else if (digits.length === 11 && digits.startsWith('92')) {
    // 9203001234567 → invalid, but try to fix
    digits = digits.substring(0, 2) + digits.substring(3);
  }

  // Must be 12 digits (92 + 10)
  return digits.length === 12 ? digits : null;
};