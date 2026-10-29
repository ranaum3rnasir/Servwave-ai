// Customer / Contact / ChannelIdentity entities introduced by the Phone module.
// Per PHONE-SYSTEM-PRD §6.1: canonical record = Customer/Contact; channel
// identities (phone/sms/email) are CHILD objects. Types + pure helpers only;
// production rows come from /api/communication/contacts.

export type ChannelKind = "phone" | "sms" | "email";

export type ChannelIdentity = {
  id: string;
  kind: ChannelKind;
  value: string;
  label?: string;
  consented?: boolean;
};

export type Contact = {
  id: string;
  name: string;
  role?: string;
  preferredLang: "en" | "es";
  channels: ChannelIdentity[];
};

export type PhoneCustomer = {
  id: string;
  name: string;
  type: "commercial" | "residential";
  site: string;
  membershipTier?: string;
  slaProfile?: string;
  contacts: Contact[];
  /** Raw phone strings (phone / secondary_phone / customer_phones[]),
   *  de-duped — the composer search haystack (n-search) reads these since
   *  contacts[].channels[] carries no phone data in practice. */
  phones?: string[];
  linkedJobIds?: string[];
};

/** Resolve a Customer/Contact from an inbound E.164 number (the screen-pop
 *  identity step, PHONE-SYSTEM-PRD §4.1.B). Returns null for unknown callers. */
export function matchByNumber(
  customers: PhoneCustomer[],
  e164: string,
): { customer: PhoneCustomer; contact: Contact } | null {
  for (const customer of customers) {
    for (const contact of customer.contacts) {
      if (contact.channels.some((c) => c.value === e164)) {
        return { customer, contact };
      }
    }
  }
  return null;
}

/** Pretty-print +1XXXXXXXXXX → (XXX) XXX-XXXX for display. */
export function fmtPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** Normalize a North-American phone string to E.164 (+1XXXXXXXXXX), or null.
 *  Client-side mirror of the backend's `normalizeNAPhone`
 *  (backend/src/lib/comms-identity.ts) so composer validation and thread
 *  keying agree on what counts as a textable number. */
export function normalizeNAPhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
