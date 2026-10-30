/**
 * The name part of a user's mailbox address (PRD 10): what an admin types before the fixed company part and domain.
 * The same rule the server applies (backend lib/mailbox/address-core.ts, checkUserNamePart): lowercase letters and
 * digits with a single dot allowed between words, the whole local part inside 64 characters, a reserved name
 * refused. The page may check as the admin types; the server's answer is the one that counts.
 */

/** Longest local part (everything before the @) an address may have. */
export const MAX_LOCAL_PART_LENGTH = 64;

/** The local parts that are never issued to anyone. */
const RESERVED = ['postmaster', 'abuse', 'bounce', 'bounces', 'no-reply', 'noreply'];

export const NAME_PART_INVALID_MESSAGE =
  'Use only letters, numbers and single dots between them. The whole address can be up to 64 characters before the @.';
export const NAME_PART_RESERVED_MESSAGE = 'This address is reserved.';
export const NAME_PART_TAKEN_MESSAGE = 'This address is already in use. Choose a different one.';

/**
 * Why `typed` cannot be the name part, or null when it can. `suffix` is the fixed text after the name part
 * (`.company@domain`): its company part counts against the 64-character limit.
 */
export function namePartProblem(typed: string, suffix: string): string | null {
  const namePart = typed.trim().toLowerCase();
  if (!namePart) return null; // nothing typed yet is not an error, only a Save that stays off
  if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(namePart)) return NAME_PART_INVALID_MESSAGE;
  const companyPart = suffix.replace(/^\./, '').split('@')[0] ?? '';
  if (namePart.length + 1 + companyPart.length > MAX_LOCAL_PART_LENGTH) return NAME_PART_INVALID_MESSAGE;
  if (RESERVED.includes(namePart)) return NAME_PART_RESERVED_MESSAGE;
  return null;
}
