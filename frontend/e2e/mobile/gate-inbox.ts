/**
 * The gate's test-inbox address: how it is built, and the one pattern that recognises it.
 *
 * Kept free of imports so the copy check (vendor-terms.ts) and the seed (gate-customer.ts) share ONE
 * definition. The builder refuses any label outside GATE_LABEL_CHARS, and the exception in
 * vendor-terms.ts matches exactly that charset, so the exception can only ever cover an address this
 * file produced. Ran's decision of 13 Oct 2026 (allowlist.json acceptedExceptions.gateTestInbox).
 */

/** The characters a label may hold: lowercase letters, digits and a hyphen (the seed suffix is base 36). */
export const GATE_LABEL_CHARS = 'a-z0-9-';
const GATE_LABEL = new RegExp(`^[${GATE_LABEL_CHARS}]+$`);

/** The address every customer the gate seeds is created with: the email provider's test inbox. */
export function gateCustomerEmail(label: string): string {
  if (!GATE_LABEL.test(label)) {
    throw new Error(`gateCustomerEmail: label ${JSON.stringify(label)} must match [${GATE_LABEL_CHARS}]+ (the copy check's exception covers only that shape)`);
  }
  return `delivered+${label}@resend.dev`;
}

/**
 * Exactly the address gateCustomerEmail builds, and only as a whole token: not after a character that
 * could continue an address, a URL or a word, and not before one that could continue the host or a
 * path. `delivered@resend.dev`, `support@resend.dev`, a sub-domain, a different local part, an upper-case
 * or underscored label, `resend.dev` in a URL and the address inside a longer token do not match.
 */
export const GATE_TEST_INBOX = new RegExp(
  `(?<![A-Za-z0-9._%+:/@\\\\=?&#-])delivered\\+[${GATE_LABEL_CHARS}]+@resend\\.dev(?![A-Za-z0-9_@/\\\\?#=%+:-]|\\.[A-Za-z0-9])`,
  'g',
);
