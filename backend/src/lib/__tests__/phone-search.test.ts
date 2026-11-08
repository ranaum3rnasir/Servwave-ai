import { describe, it, expect } from 'vitest';
import { phoneSearchClauses, phoneRelationSearchClauses } from '../phone-search';

/**
 * Issue #350 — phone-number search must match regardless of how either the query
 * OR the stored value is punctuated. Phones are stored either digits-only
 * (`5551234567`) or formatted (`(555) 123-4567`), and users type either form.
 * `phoneSearchClauses` returns a set of Prisma `{ phone: { contains } }` OR-clauses
 * that, taken together, match across that punctuation gap.
 */

/** True if any clause is a `{ phone: { contains: <needle> } }` where `<haystack>` contains `<needle>` (case-insensitive). */
function matchesStored(term: string, stored: string): boolean {
  const haystack = stored.toLowerCase();
  return phoneSearchClauses(term).some((clause) => {
    const contains = (clause as { phone: { contains: string } }).phone.contains.toLowerCase();
    return contains.length > 0 && haystack.includes(contains);
  });
}

describe('phoneSearchClauses', () => {
  it('digits-only query finds a customer stored with a formatted phone', () => {
    // The core bug: `5551234567` must find `(555) 123-4567`.
    expect(matchesStored('5551234567', '(555) 123-4567')).toBe(true);
  });

  it('digits-only query finds a customer stored digits-only', () => {
    expect(matchesStored('5551234567', '5551234567')).toBe(true);
  });

  it('formatted query finds a customer stored digits-only', () => {
    expect(matchesStored('(555) 123-4567', '5551234567')).toBe(true);
  });

  it('formatted query finds a customer stored with the same formatting', () => {
    expect(matchesStored('(555) 123-4567', '(555) 123-4567')).toBe(true);
  });

  it('partial formatted fragment still matches a formatted stored phone', () => {
    // A 7-digit local-number fragment `555-1234` against a phone whose local part is 555-1234.
    expect(matchesStored('555-1234', '(212) 555-1234')).toBe(true);
    // An area-code fragment `(555)` against a phone in that area code.
    expect(matchesStored('(555)', '(555) 123-4567')).toBe(true);
  });

  it('partial digits match the right customer and not unrelated ones', () => {
    expect(matchesStored('1234567', '(555) 123-4567')).toBe(true);
    expect(matchesStored('1234567', '(999) 888-7777')).toBe(false);
  });

  it('returns no clauses for a term with no digits (name search must be untouched)', () => {
    expect(phoneSearchClauses('John')).toEqual([]);
    expect(phoneSearchClauses('')).toEqual([]);
  });

  it('every clause is a Prisma { phone: { contains } } predicate', () => {
    for (const clause of phoneSearchClauses('5551234567')) {
      expect(clause).toHaveProperty('phone.contains');
      expect(typeof (clause as { phone: { contains: string } }).phone.contains).toBe('string');
    }
  });
});

/**
 * Issue #460 — customer phones moved to a one-to-many `phones[]` relation
 * (`CustomerPhone`), so search must also target `phones.some.phone.contains`.
 * `phoneRelationSearchClauses` mirrors `phoneSearchClauses` exactly but wraps each
 * candidate in the relation predicate, so a phones[]-stored number is findable.
 */

/** The inner `contains` values a relation clause carries, for parity comparison. */
function relationContainsSet(term: string): string[] {
  return phoneRelationSearchClauses(term).map(
    (clause) => clause.phones.some.phone.contains,
  );
}

/** True if any relation clause's inner `contains` substring-matches `stored`. */
function relationMatchesStored(term: string, stored: string): boolean {
  const haystack = stored.toLowerCase();
  return phoneRelationSearchClauses(term).some((clause) => {
    const contains = clause.phones.some.phone.contains.toLowerCase();
    return contains.length > 0 && haystack.includes(contains);
  });
}

describe('phoneRelationSearchClauses', () => {
  it('produces the same candidate set as phoneSearchClauses (canonical query)', () => {
    const scalar = phoneSearchClauses('(917) 817-6226').map((c) => c.phone.contains);
    expect(relationContainsSet('(917) 817-6226')).toEqual(scalar);
  });

  it('produces the same candidate set as phoneSearchClauses (digits-only query)', () => {
    const scalar = phoneSearchClauses('9178176226').map((c) => c.phone.contains);
    expect(relationContainsSet('9178176226')).toEqual(scalar);
  });

  it('produces the same candidate set as phoneSearchClauses (dashed query)', () => {
    const scalar = phoneSearchClauses('917-817-6226').map((c) => c.phone.contains);
    expect(relationContainsSet('917-817-6226')).toEqual(scalar);
  });

  it('finds a Riverbend-style digits-only store from a canonical query and vice-versa', () => {
    expect(relationMatchesStored('(917) 817-6226', '9178176226')).toBe(true);
    expect(relationMatchesStored('9178176226', '(917) 817-6226')).toBe(true);
  });

  it('every clause is shaped { phones: { some: { phone: { contains } } } }', () => {
    for (const clause of phoneRelationSearchClauses('5551234567')) {
      expect(clause).toHaveProperty('phones.some.phone.contains');
      expect(typeof clause.phones.some.phone.contains).toBe('string');
    }
  });

  it('returns no clauses for a term with no digits', () => {
    expect(phoneRelationSearchClauses('John')).toEqual([]);
    expect(phoneRelationSearchClauses('')).toEqual([]);
  });
});
