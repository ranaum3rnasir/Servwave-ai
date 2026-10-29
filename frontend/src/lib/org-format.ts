// Org-aware formatting preferences (#126).
//
// The organization's currency + date_format are persisted on `organizations`
// and hydrated once when the authed app shell mounts (see AppLayout). Rather
// than thread these through ~240 call sites, the central formatters
// (`formatCurrency` in lib/utils, the `formatExact*` pair in lib/format-date) read
// this module-level holder as their default.
//
// Defaults are intentionally "unset" (currency USD, dateFormat null) so that,
// before hydration and in unit tests, the formatters behave exactly as they did
// before this change (USD currency, long-form "May 14, 2026" dates).

export interface OrgFormattingPrefs {
  /** ISO 4217 currency code, e.g. 'USD', 'EUR', 'CAD'. */
  currency: string;
  /** Date pattern, e.g. 'MM/DD/YYYY'. null = long-form ("May 14, 2026"). */
  dateFormat: string | null;
}

const prefs: OrgFormattingPrefs = {
  currency: 'USD',
  dateFormat: null,
};

/**
 * Set the active org formatting preferences. Called once on org hydration.
 * Empty/blank inputs fall back to the prior default so a half-configured org
 * never produces broken output.
 */
export function setOrgFormattingPrefs(next: {
  currency?: string | null;
  dateFormat?: string | null;
}): void {
  const currency = next.currency?.trim();
  prefs.currency = currency && currency.length === 3 ? currency.toUpperCase() : 'USD';
  const dateFormat = next.dateFormat?.trim();
  prefs.dateFormat = dateFormat ? dateFormat : null;
}

/** Read the active org currency code (defaults to 'USD'). */
export function getOrgCurrency(): string {
  return prefs.currency;
}

/** Read the active org date pattern (null = long-form default). */
export function getOrgDateFormat(): string | null {
  return prefs.dateFormat;
}
