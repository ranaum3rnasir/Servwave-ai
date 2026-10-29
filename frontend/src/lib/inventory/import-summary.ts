import type { ImportItemsResult } from '@/lib/api/inventory';

/**
 * The one line the operator gets back from a CSV import.
 *
 * Three counts, kept apart on purpose:
 *  - skipped rows were NOT imported;
 *  - created categories are a receipt for a write the import made on its own,
 *    and the cue to fix a typo that has just become a real row;
 *  - an unmatched vendor row WAS imported, it just arrived with no vendor.
 * Folding any of these together would tell the operator rows were dropped when
 * none were, or hide a category they did not mean to create.
 *
 * Extracted from InventoryPage so the deploy-overlap case is testable: a
 * backend one release behind answers without the two newer keys at all.
 */
export function importSummary(result: ImportItemsResult): string {
  const plural = (n: number) => (n === 1 ? '' : 's');
  const skipped = result.errors.length;
  const madeCategories = (result.createdCategories ?? []).length;
  const unmatchedVendors = (result.warnings ?? []).length;

  const errPart = skipped > 0 ? ` · ${skipped} row${plural(skipped)} skipped` : '';
  const catPart =
    madeCategories > 0
      ? ` · ${madeCategories} categor${madeCategories === 1 ? 'y' : 'ies'} created`
      : '';
  const warnPart =
    unmatchedVendors > 0
      ? ` · ${unmatchedVendors} vendor name${plural(unmatchedVendors)} not found`
      : '';

  return `✓ Imported ${result.created} new · ${result.updated} updated${errPart}${catPart}${warnPart}`;
}

/**
 * One row of the CSV as the operator sees it: the line number in their
 * spreadsheet (header is line 1) and something to recognise it by.
 */
export type ImportRowRef = { line: number; label: string };

/** A problem, addressed to the person who has to fix the file. */
export type ImportIssue = { line: number; label: string; message: string };

/**
 * Resolve the server's row INDEXES back to spreadsheet LINE numbers.
 *
 * The API answers with `index` into the array it was sent, which is not what
 * the operator is looking at: their file has a header line, and may have blank
 * lines we skipped. `rows` is the mapping the dialog built when it read the
 * file, so the two cannot drift apart as long as it is passed from the same
 * parse. The fallback (`index + 2`) is the no-blank-lines case, and is only
 * reached if a caller loses the mapping.
 */
export function importIssues(
  entries: { index: number; message: string }[] | undefined,
  rows: ImportRowRef[],
): ImportIssue[] {
  return (entries ?? []).map((entry) => {
    const row = rows[entry.index];
    return {
      line: row?.line ?? entry.index + 2,
      label: row?.label ?? '',
      message: entry.message,
    };
  });
}
