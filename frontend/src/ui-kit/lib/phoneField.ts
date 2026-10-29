/* =============================================================================
   Phone field values (mobile slice 36, KB-02).

   Every phone field is a <PhoneInput> (src/ui-kit/components/form/phoneInput.tsx).
   Its value is the form's own string, so no form changed its state shape and
   storage did not change: customer phones are still normalised to digits by the
   backend, user phones still follow the user-phone rule, and everything else is
   stored as the form sends it.

   Two formats:

   * 'us' - the US typing mask the masked forms always had: "(512) 555-0147",
     at most ten digits. A ten-digit number saves exactly what it saved before.
     What the old mask got wrong is fixed, never truncated:
       - a value that starts with "+" is an international number and is kept
         as typed ("+44 7700 900123"); "+1" and ten digits is a US number and
         is masked like one;
       - "1" and ten digits (a country code without the plus) is masked as the
         ten digits, not as "(151) 255-5014";
       - a value that already holds more than ten digits (a stored number the
         form opened with) keeps every digit while it is edited.
     A number with an extension typed into the number box still drops the
     extension, as before: the extension has its own box.

   * 'as-typed' - for fields that never had a mask (dial pads, forwarding
     numbers, the block list): the value passes through untouched.

   phoneFieldValue() is what a form shows for a STORED number. The masked forms
   used to run the typing mask over it, which kept the first ten digits of an
   international number; now a number the mask cannot represent is shown, and
   re-saved, exactly as stored, and never given a +1.
   ============================================================================= */
export type PhoneFormat = 'us' | 'as-typed';

/**
 * Live-format a US phone as the user types -> "(555) 123-4567". Re-derived from
 * the raw digits on every keystroke (so backspace/edits work naturally) and
 * capped at 10 digits. Shared by every masked customer-phone input (#352).
 * Lives in the kit so the phone field needs nothing from the app; the app's
 * src/lib/utils re-exports it.
 */
export function formatPhoneInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length === 0) return '';
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

const digitsOf = (raw: string) => raw.replace(/\D/g, '');
const startsWithPlus = (raw: string) => raw.trimStart().startsWith('+');

/**
 * True when the US mask can show `raw` without losing anything: no leading
 * "+" and at most ten digits. Empty is a US value (an empty field).
 */
export function isUsPhoneValue(raw: string | null | undefined): boolean {
  const v = raw ?? '';
  return !startsWithPlus(v) && digitsOf(v).length <= 10;
}

/**
 * What a phone field shows for a stored number: the US mask when it fits
 * (exactly what the masked forms showed before), otherwise the stored text
 * unchanged.
 */
export function phoneFieldValue(stored: string | null | undefined): string {
  if (!stored) return '';
  return isUsPhoneValue(stored) ? formatPhoneInput(stored) : stored;
}

/**
 * The field's next value after the user changed it from `prev` to `next`.
 * See the header for the rules.
 */
export function nextPhoneValue(next: string, prev: string, format: PhoneFormat = 'us'): string {
  if (format === 'as-typed') return next;
  const d = digitsOf(next);
  const plus = startsWithPlus(next);
  // A US number with its country code: "+1 512 555 0147", "1 512 555 0147".
  // No US area code starts with 1, so a leading 1 before ten more digits is never part of the number.
  if (d.length === 11 && d.startsWith('1') && (!plus || /^\s*\+\s*1/.test(next))) return formatPhoneInput(d.slice(1));
  // An international number: kept as typed, never masked, never given a +1.
  if (plus) return next;
  // A field that opened holding more than ten digits keeps every one of them while edited.
  if (d.length > 10 && !isUsPhoneValue(prev)) return next;
  // Everything else: the old mask, byte for byte (ten digits at most).
  return formatPhoneInput(next);
}

/**
 * For a form's own validation: true when `raw` is a number the US mask could
 * not show (an international or long number) with a digit count the backend's
 * customer-phone rule accepts (7 to 20). Such a value reached the field as a
 * stored number or was typed with a "+", and must be savable unchanged.
 */
export function isUnmaskedPhoneNumber(raw: string | null | undefined): boolean {
  const v = raw ?? '';
  const n = digitsOf(v).length;
  return !isUsPhoneValue(v) && n >= 7 && n <= 20;
}
