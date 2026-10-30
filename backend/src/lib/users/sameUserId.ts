/**
 * A person's id, the one way it is stored (pre-PR review CR-4).
 *
 * Postgres reads a uuid in any letter case, with or without its hyphens, inside braces, or after `urn:uuid:`, so a request
 * that names a person as `ABC…`, `abc…` without hyphens or `{abc…}` finds the same row. A check that compares the id it was
 * handed as a STRING ("is this the Owner?", "is this the caller themself?") would miss it, and the action the check exists to
 * stop goes through. Every such comparison reads the id through `canonicalUserId`, or compares with `sameUserId`.
 */

const UUID_HEX = /^[0-9a-f]{32}$/i;

/** The stored form (lower case, hyphenated) of any spelling Postgres would read as the same uuid; anything else unchanged. */
export function canonicalUserId(raw: string): string;
export function canonicalUserId(raw: string | null | undefined): string | null | undefined;
export function canonicalUserId(raw: string | null | undefined): string | null | undefined {
  if (typeof raw !== 'string') return raw;
  let s = raw.trim();
  if (/^urn:uuid:/i.test(s)) s = s.slice('urn:uuid:'.length);
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  const hex = s.replace(/-/g, '');
  if (!UUID_HEX.test(hex)) return raw;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Whether two ids name the same person, however each is written. Null or missing is nobody. */
export function sameUserId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return canonicalUserId(a) === canonicalUserId(b);
}
