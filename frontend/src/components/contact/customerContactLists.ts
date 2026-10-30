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
