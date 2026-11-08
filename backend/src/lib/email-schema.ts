import { z } from 'zod';

/**
 * Canonical email input gate.
 *
 * Trims and lowercases every email at the validation boundary so casing can
 * never fork an identity. Supabase Auth and OAuth providers normalize emails
 * to lowercase, but our `users.email` column is `text` and matched
 * case-sensitively — so a mixed-case row (e.g. `Sagiv@…`) stored from an invite
 * form would never reconcile with the `sagiv@…` a provider hands back, locking
 * the user out. Reuse this for every email field that reaches the DB.
 */
export const emailSchema = z.string().trim().toLowerCase().email();

/**
 * Optional email for customer-facing records (customers, plus the inline
 * new_customer paths on leads and jobs). Email is NOT required on its own — a
 * customer needs a name plus at least one of {@link hasPhoneOrEmail} phone/email
 * (SERV10X-35). An empty/whitespace-only string or a missing value normalizes
 * to `undefined` so it is omitted on persist (→ SQL NULL); any provided value
 * must still be a valid email. Casing is preserved (unlike {@link emailSchema})
 * to match how customer emails have always been stored and displayed.
 */
export const optionalCustomerEmail = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().email().optional().nullable(),
);

/**
 * SERV10X-35 — a customer needs at least one contact method. Phone and email
 * are each individually optional; this predicate is the cross-field gate that
 * blocks only when BOTH are absent.
 */
const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

export const CONTACT_REQUIRED_MSG = 'Enter a phone number or an email';

export const hasPhoneOrEmail = (d: { phone?: string | null; email?: string | null }): boolean =>
  hasText(d.phone) || hasText(d.email);
