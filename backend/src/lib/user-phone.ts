import { z } from 'zod';
import { normalizeNAPhone } from './comms-identity';

/**
 * The ONE definition of what counts as a staff phone number, applied at every
 * door that writes `User.phone` (create, invite, admin update, self-service
 * profile - and the accept-invite form, which imports this same field).
 *
 * Why normalize at capture rather than at read. Nothing normalized before this,
 * so the column holds whatever the form happened to send: the v2 surfaces mask
 * to a US display form and the API persisted that verbatim, while API callers
 * sent bare digits. One downstream reader already pays for that by normalizing
 * BOTH sides at read time. Deciding the spelling once, here, is what stops a
 * fourth variant arriving with every new entry point.
 *
 * Deliberately strict `normalizeNAPhone` with NO digits fallback, exactly as
 * the blocked-numbers key is (lib/communication/blockedNumbers.ts documents the
 * argument): a number that cannot be dialled is not a number we can text, and
 * accepting a 7-digit local fragment would only re-open the mixed-spelling
 * problem under a different name. Such input is refused at the schema instead.
 *
 * Empty, null and absent all pass through UNTOUCHED. The field is optional on
 * every door, a seat with no phone must stay creatable/invitable/saveable, and
 * a blank is how the forms clear a number - none of those is an invalid number.
 */
export const USER_PHONE_INVALID_MESSAGE =
  'Enter a 10-digit US or Canadian phone number';

/** True when `raw` is blank in the sense above - nothing to normalize, nothing to refuse. */
function isBlank(raw: string | null | undefined): boolean {
  return raw === null || raw === undefined || raw.trim() === '';
}

/**
 * The `phone` field for a user-writing zod object.
 *
 * The `.transform()` is load-bearing, not cosmetic: `validate()` middleware
 * does `req.body = schema.parse(req.body)` (middleware/validate.ts), so the
 * transformed value is what every handler downstream sees - both the admin
 * update's explicit allowlist copy and `updateMe`'s wholesale `data: req.body`
 * spread. A bare `.refine()` would validate the number and still store the
 * spelling the client happened to send.
 */
export const userPhoneField = z
  .string()
  .max(50)
  .nullable()
  .optional()
  .refine((v) => isBlank(v) || normalizeNAPhone(v as string) !== null, USER_PHONE_INVALID_MESSAGE)
  .transform((v) => (isBlank(v) ? v : normalizeNAPhone(v as string)!));

/**
 * What a submitted phone box actually MEANS for a conditional write: the E.164
 * number, or null when the caller left it blank.
 *
 * `userPhoneField` deliberately passes blank through untouched, so the post-
 * parse value for a blank is `undefined`, `null`, `''` or even `'   '` - and
 * the whitespace case is truthy, which a bare `if (phone)` would write. The
 * accept-invite handlers must tell "the hire typed a number" apart from "the
 * hire left it alone" exactly, because on a blank they must NOT touch the
 * column: an admin who filled the invite card has already supplied a number,
 * and overwriting it with null is the data loss this capture exists to prevent.
 */
export function submittedUserPhone(v: string | null | undefined): string | null {
  if (isBlank(v)) return null;
  return (v as string).trim();
}
