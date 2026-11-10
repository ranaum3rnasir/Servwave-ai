export interface BlockCustomer {
  id: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  phone_ext?: string | null;
  /** The full set, as the job detail answers. */
  phones?: { phone: string; label: string | null; extension: string | null; is_primary: boolean }[];
  emails?: { email: string; label: string | null; is_primary: boolean }[];
}

/** Every phone the response carries, or the one primary phone an older payload holds. */
export function customerPhonesOf(customer: BlockCustomer) {
  return customer.phones ?? (customer.phone ? [{ phone: customer.phone, label: null, extension: customer.phone_ext ?? null, is_primary: true }] : []);
}

export function customerEmailsOf(customer: BlockCustomer) {
  return customer.emails ?? (customer.email ? [{ email: customer.email, label: null, is_primary: true }] : []);
}

/** The pencil's entry on a record, as far as the effective number needs it. */
interface PhoneEntry {
  kind: string;
  intent: string;
  value: string;
  customer_value_at_change: string | null;
}

/**
 * A lead's or job's EFFECTIVE number (#3016, 4 October Q34): the record's changed number for the customer's primary,
 * else the customer's primary. "Changed for" is read the way the contact block draws it in the primary's place: a CHANGED
 * phone entry whose customer value at the change has the primary's digits. Undefined when the customer has no phone.
 * The server applies the same rule to a text sent from the record (backend lib/communication/recordTextDestination.ts).
 */
export function recordEffectivePhone(primaryPhone: string | null | undefined, entries: PhoneEntry[] | undefined): string | undefined {
  if (!primaryPhone) return undefined;
  const digits = (phone: string) => phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const changed = (entries ?? []).find(
    (e) => e.kind === 'PHONE' && e.intent === 'CHANGED' && e.customer_value_at_change !== null && digits(e.customer_value_at_change) === digits(primaryPhone),
  );
  return changed?.value ?? primaryPhone;
}
