type CustomerNameInput = {
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
};

export function customerDisplayName(c: CustomerNameInput | null | undefined, fallback = 'Customer'): string {
  if (!c) return fallback;
  const first = c.first_name?.trim();
  const last = c.last_name?.trim();
  if (last && first) return `${first} ${last}`;
  return last || first || c.company_name?.trim() || fallback;
}
