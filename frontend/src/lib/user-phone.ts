import { normalizeNAPhone } from '@/lib/api/communication-shared/phone-customers';

/**
 * The client mirror of the staff-phone rule the API enforces
 * (backend/src/lib/user-phone.ts). Every surface that writes `User.phone` -
 * the invite card, the admin edit dialog and the user's own profile - gates on
 * this, so none of them can offer to submit what the server would 400.
 *
 * The predicate is deliberately separate from `formatPhoneInput`, which stays
 * the typing MASK: a half-typed number must keep formatting itself as the user
 * goes, and only the submit decision cares whether what is there yet is usable.
 *
 * Blank is not invalid. The field is optional everywhere and clearing it is how
 * a number is removed, so an empty box shows no message and blocks no save.
 */
export const USER_PHONE_INVALID_MESSAGE =
  'Enter a 10-digit US or Canadian phone number';

/** True when `raw` is empty or normalizes - i.e. the server would accept it. */
export function isUsableUserPhone(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim();
  return v === '' || normalizeNAPhone(v) !== null;
}

/**
 * What to SEND for a phone box: the E.164 form, or null when it is blank.
 *
 * The surfaces mask to a US display form as the admin types, and sending that
 * masked string is how the column ended up holding several spellings of the
 * same number. Normalizing here means the value that leaves the page is already
 * the value the column will hold, so a reopened dialog shows what was saved.
 * Only ever called behind `isUsableUserPhone`, so the `?? null` is the blank
 * case, never a silent drop of a bad number.
 */
export function userPhoneForSubmit(raw: string): string | null {
  const v = raw.trim();
  return v === '' ? null : normalizeNAPhone(v);
}
