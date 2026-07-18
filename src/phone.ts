import { parsePhoneNumberFromString } from 'libphonenumber-js';

// ============================================================
// Robust phone normalization (P1-8).
// One function, used by EVERY path that touches a phone number
// (Meta lead field data AND inbound WhatsApp `from` values), so
// the same person always resolves to the same lead.
//
// Returns E.164 digits WITHOUT the '+' (what WhatsApp expects),
// e.g. "919876543210". `defaultCountryCode` is the tenant's
// calling code (e.g. "91") used to resolve national-format input
// like "098765 43210".
// ============================================================
export function normalizePhone(input: string, defaultCountryCode?: string | null): string {
  const raw = (input || '').trim();
  if (!raw) return '';

  // "0091..." → "+91..." (international dialing prefix)
  let candidate = raw.replace(/^\s*00/, '+');

  // Already international? Parse directly.
  if (candidate.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(candidate);
    if (parsed && parsed.isValid()) return parsed.number.slice(1);
  }

  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return '';

  // The digits may already include a country code (Meta often sends "9198...").
  const asInternational = parsePhoneNumberFromString('+' + digits.replace(/^0+/, ''));
  if (asInternational && asInternational.isValid()) return asInternational.number.slice(1);

  // National format ("98...", "098...") — prepend the tenant's country code.
  const cc = (defaultCountryCode || '').replace(/[^\d]/g, '');
  if (cc) {
    const national = digits.replace(/^0+/, '');
    const withCc = parsePhoneNumberFromString('+' + cc + national);
    if (withCc && withCc.isValid()) return withCc.number.slice(1);
  }

  // Last resort: old digit-strip behavior, loudly.
  console.warn(`[phone] could not parse "${input}" (cc=${defaultCountryCode ?? 'none'}); falling back to digit-strip`);
  return digits;
}
