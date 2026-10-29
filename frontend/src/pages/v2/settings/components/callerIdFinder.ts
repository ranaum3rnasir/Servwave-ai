import { fmtPhone } from '@/lib/api/communication';
import { canBeDefault, textingState, type NumberAssignmentRow } from '@/lib/api/phoneNumbers';

/**
 * Caller ID slice 04: how the Caller ID list is searched, filtered, counted and
 * paged. Pure, so the rules are read in one place and the page only holds the
 * state.
 */

/** The toolbar's filters. */
export type CallerIdFilter = 'all' | 'unassigned' | 'calls-only';

/** Numbers per page. */
export const CALLER_ID_PAGE_SIZE = 25;

/** A query that is only digits and the punctuation people type in a phone
 *  number ("5552014410", "+1 555 201-4410", "(555) 201"). Such a query is also
 *  matched digit for digit against the number, ignoring the formatting. */
const PHONE_LIKE = /^[\d\s()+.-]+$/;

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

function matchesFilter(row: NumberAssignmentRow, filter: CallerIdFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    // An active org default with nobody on it is used by everyone, so it is not
    // an unused number. One that is not active is skipped when choosing a
    // caller ID, so nobody uses it and it is listed.
    case 'unassigned':
      return row.assignments.length === 0 && !(row.is_org_default && canBeDefault(row));
    // Exactly the rows tagged "Calls only": an active number that cannot text.
    // Paused and not-yet-ready numbers cannot text either, but they carry their
    // own "Paused" / "Unavailable" tag and are left out, so the filter never
    // shows a row tagged something else.
    case 'calls-only':
      return textingState(row) === 'calls-only';
  }
}

function matchesQuery(row: NumberAssignmentRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const text = [fmtPhone(row.e164), row.e164, row.label ?? '', ...row.assignments.map((a) => a.user_name)]
    .join('\n')
    .toLowerCase();
  if (text.includes(q)) return true;

  // E.164 keeps the country code, so a 10-digit query, a leading "1" or "+1",
  // and any run of digits inside the number all match.
  const qDigits = digitsOf(q);
  return PHONE_LIKE.test(q) && qDigits.length > 0 && digitsOf(row.e164).includes(qDigits);
}

/** The rows that match a search and a filter, in their original order.
 *  Search matches the formatted number, its digits, the number's name and the
 *  names of the people assigned to it, ignoring case. */
export function filterCallerIdRows(
  rows: NumberAssignmentRow[],
  { query, filter }: { query: string; filter: CallerIdFilter },
): NumberAssignmentRow[] {
  return rows.filter((row) => matchesFilter(row, filter) && matchesQuery(row, query));
}

/** "30 numbers", or "4 of 30 numbers" while a search or filter narrows the list. */
export function callerIdCountLabel(matched: number, total: number, narrowed: boolean): string {
  const noun = (n: number) => (n === 1 ? 'number' : 'numbers');
  return narrowed ? `${matched} of ${total} ${noun(total)}` : `${total} ${noun(total)}`;
}

/** One page of the matches. A page past the end (the list shrank after a save
 *  or refetch) is pulled back to the last page, so a page is never empty while
 *  anything matches. Pages are numbered from 1. */
export function pageOf<T>(items: T[], requested: number, size = CALLER_ID_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(Math.max(1, requested), pageCount);
  return { page, pageCount, items: items.slice((page - 1) * size, page * size) };
}
