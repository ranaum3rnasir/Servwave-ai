/**
 * Backend customer-phone display formatter (#352) — the twin of the frontend's
 * `formatPhone` (frontend/src/lib/utils.ts). Storage is digits-only canonical;
 * anything customer-facing the backend renders (PDF templates) formats through
 * this. Deliberately dependency-free so PDF templates can import it.
 *
 * - 10 digits            → `(xxx) xxx-xxxx`
 * - 11 digits, leading 1 → same, on the last 10
 * - anything else (placeholder sentinels, legacy junk) → returned unchanged
 * - null/undefined       → ''
 */
export function formatPhoneDisplay(phone: string | null | undefined): string {
  if (phone == null) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}
