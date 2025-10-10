export const normalizePhoneNumber = (phone) => {
  if (!phone) return phone;
  let normalized = phone.trim();
  if (!normalized.startsWith("+")) {
    normalized = `+${normalized}`;
  }
  normalized = normalized.replace(/[\s-]/g, "");
  console.log(`normalizePhoneNumber: Normalized phone: ${phone} -> ${normalized}`);
  return normalized;
};