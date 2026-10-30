/**
 * A customer's full contact set: every phone (with label and extension) and every email on file.
 *
 * A customer holds its phones in two places that grew apart: the primary and secondary phone columns
 * on the customer, and the phone list (`customer_phones`, with label, extension and a primary flag).
 * Emails are the same: the primary column plus the extra-email list. A record that carries the customer
 * with it (the job page today) needs them as one list, in a stable order, with no number shown twice.
 *
 * Pure: the caller selects the columns below and hands the row in.
 */
import { normalizePhone } from './customer-duplicate';

export const CUSTOMER_CONTACT_SET_SELECT = {
  phone: true,
  phone_ext: true,
  secondary_phone: true,
  secondary_phone_ext: true,
  email: true,
  phones: {
    select: { phone: true, label: true, extension: true, is_primary: true },
    orderBy: { created_at: 'asc' as const },
  },
  extra_emails: {
    select: { email: true, label: true },
    orderBy: { created_at: 'asc' as const },
  },
} as const;

export interface ContactPhone {
  phone: string;
  label: string | null;
  extension: string | null;
  is_primary: boolean;
}

export interface ContactEmail {
  email: string;
  label: string | null;
  is_primary: boolean;
}

export interface ContactSetSource {
  phone?: string | null;
  phone_ext?: string | null;
  secondary_phone?: string | null;
  secondary_phone_ext?: string | null;
  email?: string | null;
  phones?: { phone: string; label: string | null; extension: string | null; is_primary: boolean }[] | null;
  extra_emails?: { email: string; label: string | null }[] | null;
}

/** The two lists, primary first, each value once (a phone by its digits, an email by its lowercase form). */
export function customerContactSet(source: ContactSetSource): { phones: ContactPhone[]; emails: ContactEmail[] } {
  const listed = source.phones ?? [];
  const phones: ContactPhone[] = [];
  const seenPhones = new Set<string>();
  const addPhone = (phone: string | null | undefined, extension: string | null | undefined, isPrimary: boolean, label: string | null) => {
    const key = normalizePhone(phone);
    if (!phone || !key) return;
    const have = seenPhones.has(key);
    seenPhones.add(key);
    if (have) {
      // The list may know the label of a number the columns hold bare.
      const existing = phones.find((p) => normalizePhone(p.phone) === key)!;
      existing.label ??= label;
      return;
    }
    phones.push({ phone, label, extension: extension || null, is_primary: isPrimary });
  };
  const labelOf = (phone: string | null | undefined) => {
    const key = normalizePhone(phone);
    return listed.find((p) => normalizePhone(p.phone) === key)?.label ?? null;
  };
  addPhone(source.phone, source.phone_ext, true, labelOf(source.phone));
  addPhone(source.secondary_phone, source.secondary_phone_ext, false, labelOf(source.secondary_phone));
  for (const p of listed) addPhone(p.phone, p.extension, false, p.label);
  // A customer whose columns hold no phone but whose list flags one primary: that one is the primary.
  if (!source.phone && phones.length > 0) {
    const flagged = phones.find((p) => listed.some((l) => l.is_primary && normalizePhone(l.phone) === normalizePhone(p.phone)));
    (flagged ?? phones[0]!).is_primary = true;
  }

  const emails: ContactEmail[] = [];
  const seenEmails = new Set<string>();
  const addEmail = (email: string | null | undefined, label: string | null, isPrimary: boolean) => {
    const key = email?.trim().toLowerCase();
    if (!email || !key || seenEmails.has(key)) return;
    seenEmails.add(key);
    emails.push({ email, label, is_primary: isPrimary });
  };
  addEmail(source.email, null, true);
  for (const e of source.extra_emails ?? []) addEmail(e.email, e.label, false);

  return { phones, emails };
}

/**
 * A record's embedded customer, with the raw contact columns and lists the select read folded into the two
 * lists `phones` and `emails` (every one, with label and extension). The job detail and the lead detail both
 * answer a customer in this shape, for anyone who can open the record: View customers plays no part. Anything
 * that is not a customer object passes through.
 */
export function withCustomerContactSet<C>(customer: C): C {
  if (!customer || typeof customer !== 'object') return customer;
  const {
    phone_ext: _phoneExt, secondary_phone: _secondary, secondary_phone_ext: _secondaryExt, extra_emails: _extraEmails, phones: _phones,
    ...rest
  } = customer as Record<string, unknown>;
  return { ...rest, ...customerContactSet(customer as ContactSetSource) } as C;
}
