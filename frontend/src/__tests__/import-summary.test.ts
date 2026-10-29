import { describe, it, expect } from 'vitest';
import { importSummary } from '@/lib/inventory/import-summary';
import type { ImportItemsResult } from '@/lib/api/inventory';

// The CSV importer answers with four counts, and the toast is the only place
// the operator ever sees three of them. The distinctions that matter: a row in
// `errors` was NOT imported; a row in `warnings` WAS, it just named a vendor
// the org does not own; and `createdCategories` is a write the import made on
// its own initiative, which the operator has to be told about.

function result(over: Partial<ImportItemsResult> = {}): ImportItemsResult {
  return { created: 0, updated: 0, errors: [], warnings: [], createdCategories: [], ...over };
}
const warn = (n: number) =>
  Array.from({ length: n }, (_, index) => ({ index, message: 'Vendor "X" not found - left blank' }));
const err = (n: number) =>
  Array.from({ length: n }, (_, index) => ({ index, message: 'Name is required' }));

describe('importSummary', () => {
  it('a clean import states the two counts and nothing else', () => {
    expect(importSummary(result({ created: 12, updated: 3 }))).toBe('✓ Imported 12 new · 3 updated');
  });

  it('reports created categories, skipped rows and unmatched vendors as three separate counts', () => {
    const line = importSummary(
      result({ created: 8, updated: 1, errors: err(2), warnings: warn(4), createdCategories: ['Hinges', 'Panels'] }),
    );
    expect(line).toBe(
      '✓ Imported 8 new · 1 updated · 2 rows skipped · 2 categories created · 4 vendor names not found',
    );
  });

  it('never reports an unmatched vendor as a skipped row', () => {
    // The whole point of the split: these 5 items ARE in the catalog.
    const line = importSummary(result({ created: 5, warnings: warn(5) }));
    expect(line).toContain('5 vendor names not found');
    expect(line).not.toContain('skipped');
  });

  it('a created category is never counted as a failure of any kind', () => {
    const line = importSummary(result({ created: 5, createdCategories: ['Hinges'] }));
    expect(line).toBe('✓ Imported 5 new · 0 updated · 1 category created');
    expect(line).not.toContain('skipped');
    expect(line).not.toContain('not found');
  });

  it('singularises all three counts', () => {
    expect(
      importSummary(result({ created: 1, errors: err(1), warnings: warn(1), createdCategories: ['Hinges'] })),
    ).toBe('✓ Imported 1 new · 0 updated · 1 row skipped · 1 category created · 1 vendor name not found');
  });

  it('survives a backend one deploy behind, which sends neither newer key', () => {
    const legacy = { created: 4, updated: 0, errors: [] } as ImportItemsResult;
    expect(importSummary(legacy)).toBe('✓ Imported 4 new · 0 updated');
  });
});
