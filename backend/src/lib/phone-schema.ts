import { z } from 'zod';
import { normalizePhone } from './customer-duplicate';

/**
 * Canonical customer-phone input gates (#352).
 *
 * Every customer-phone field (customer create/update incl. phones[], plus the
 * inline new_customer paths on leads and jobs) validates through these so the
 * DB only ever stores the DIGITS-ONLY form — `(555) 123-4567`, `+1 555 123 4567`
 * and `5551234567` all persist as `5551234567` (a single leading US `1` is
 * stripped from an 11-digit value, mirroring {@link normalizePhone}). The
 * `validate()` middleware assigns `req.body = schema.parse(req.body)`, so the
 * transformed digits flow into every controller write untouched. Display
 * re-formats via the shared formatters (frontend `formatPhone`, backend
 * `formatPhoneDisplay`).
 */

/**
 * Required phone. Accepts any punctuation the client sends (≤25 chars raw),
 * normalizes to digits, and validates the DIGIT count (7–20) — preserving the
 * pre-#352 min(7)/max(20) semantics but on digits instead of raw characters.
 */
export const requiredCustomerPhone = z
  .string()
  .max(25)
  .transform((v) => normalizePhone(v) ?? '')
  .refine((d) => d.length >= 7 && d.length <= 20, 'Enter a valid phone number');

/**
 * Optional phone (e.g. `secondary_phone`). A blank/whitespace-only string
 * normalizes to `null` (clears the column); any non-blank value must
 * digit-validate like {@link requiredCustomerPhone}. Deliberate tightening:
 * a non-blank value with <7 digits now 400s where it used to be accepted as
 * ≤20-char free text — safe because the 20260703000000 backfill migration
 * leaves the nullable customer columns as NULL-or-7-to-20-digits first.
 */
export const optionalCustomerPhone = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  requiredCustomerPhone.nullable(),
).optional();
