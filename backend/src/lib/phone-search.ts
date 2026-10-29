/**
 * Phone-number search normalization (issue #350).
 *
 * Customer phones are stored inconsistently — sometimes digits-only (`5551234567`),
 * sometimes formatted (`(555) 123-4567`) — because the API persists whatever the
 * client sends. A raw substring `contains` therefore misses across the punctuation
 * gap: a digits-only query never matches a formatted stored value and vice-versa.
 *
 * `phoneSearchClauses` turns a search term into a small set of Prisma
 * `{ phone: { contains } }` OR-clauses that, together, match a phone regardless of
 * how either the query or the stored value is punctuated. It is intentionally
 * scoped to phone-shaped queries: a term with no digits yields no clauses, so name
 * / email / number searches are completely unaffected.
 */

type PhoneContainsClause = { phone: { contains: string } };
type PhoneRelationContainsClause = { phones: { some: { phone: { contains: string } } } };

/** Strip every non-digit and drop a single leading US country code from an 11-digit result. */
function digitsOf(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

/**
 * Format a run of digits with standard US separators so a digits-only query can match
 * a fully-formatted stored value. Returns null when the length is not a phone shape we
 * can format unambiguously (we only format the 7-digit local part and the 10-digit form).
 */
function canonicalFormat(digits: string): string | null {
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 7) {
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  }
  return null;
}

/**
 * Build the deduped `contains` candidate set for a search term. Always digit-normalizes
 * both directions:
 *   - the raw term            → matches a formatted fragment against a formatted store
 *   - the digits-only term    → matches against a digits-only store
 *   - a canonically-formatted variant of those digits → matches a formatted store from
 *     a digits-only query (the core bug)
 *
 * Returns `[]` for any term with no digits so non-phone searches stay untouched.
 */
function phoneSearchCandidates(term: string): string[] {
  const digits = digitsOf(term);
  if (!digits) return [];

  const candidates = new Set<string>();
  candidates.add(digits);

  // Preserve the literal punctuated fragment a user typed (e.g. `555-1234`, `(555)`),
  // which already matches an identically-formatted store.
  const trimmed = term.trim();
  if (trimmed) candidates.add(trimmed);

  const formatted = canonicalFormat(digits);
  if (formatted) candidates.add(formatted);

  return [...candidates];
}

/**
 * Phone-match OR-clauses against the LEGACY scalar `Customer.phone` column.
 * Returns `[]` for any term with no digits so non-phone searches stay untouched.
 */
export function phoneSearchClauses(term: string): PhoneContainsClause[] {
  return phoneSearchCandidates(term).map((contains) => ({ phone: { contains } }));
}

/**
 * Phone-match OR-clauses against the `phones[]` relation (`CustomerPhone`, entity-redesign
 * §2), where the current create/edit path now stores numbers (and Talon-import rows live
 * digit-only). Mirrors the `extra_emails: { some: { email: { contains } } }` relation
 * pattern and reuses the identical candidate set as `phoneSearchClauses` (#460).
 * Returns `[]` for any term with no digits.
 */
export function phoneRelationSearchClauses(term: string): PhoneRelationContainsClause[] {
  return phoneSearchCandidates(term).map((contains) => ({ phones: { some: { phone: { contains } } } }));
}
