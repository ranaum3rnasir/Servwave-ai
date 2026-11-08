import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoMapColumns, parseCSV } from '@/lib/inventory/csv';
import { ImportCSVDialog } from '@/components/inventory/ImportCSVDialog';

// S4.5 (Purchasing Audit Verdict B15): the catalog import template shipped
// under docs/inventory must be the file a customer can drop on the Import CSV
// dialog with zero column mapping. Pin three things: the template parses to
// one example row, every column the price-book importer parses auto-maps to
// its own header (a renamed header silently falls through to the fallback
// partial match or lands unmapped), and the in-dialog "Need a sample CSV?"
// block shows the same header row so the app and the doc never drift apart.
//
// Path resolution via fileURLToPath(string) + dirname, the pattern
// csv-export-guard.test.ts documents for this repo's jsdom environment.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(SRC, '..', '..', 'docs', 'inventory', 'catalog-import-template.csv');

// Field -> header. Mirrors importRowSchema in
// backend/src/controllers/price-book.controller.ts - those eight are every
// key the importer reads; anything else in a row is ignored server-side.
const EXPECTED_MAPPING: Record<string, string> = {
  sku: 'SKU',
  name: 'Name',
  category: 'Category',
  kind: 'Kind',
  uom: 'UoM',
  unitCost: 'Unit Cost',
  sellPrice: 'Sell Price',
  vendor: 'Vendor',
};

describe('catalog import template (docs/inventory/catalog-import-template.csv)', () => {
  const text = readFileSync(TEMPLATE, 'utf8');
  const parsed = parseCSV(text);

  it('is a header row plus exactly one example row', () => {
    expect(parsed.headers).toEqual(Object.values(EXPECTED_MAPPING));
    expect(parsed.rows).toHaveLength(1);
  });

  it('auto-maps every importer field to its own header', () => {
    const mapping = autoMapColumns(parsed.headers);
    for (const [field, header] of Object.entries(EXPECTED_MAPPING)) {
      expect(mapping[field], field).toBe(header);
    }
  });

  it('example row satisfies the importer: a name and a numeric sell price', () => {
    const row = parsed.rows[0]!;
    expect(row['Name']).not.toBe('');
    expect(Number(row['Sell Price'])).toBeGreaterThan(0);
    expect(Number(row['Unit Cost'])).toBeGreaterThanOrEqual(0);
    // The dialog only accepts material|service; anything else silently
    // becomes material. The template should show a valid token, not rely
    // on the fallback.
    expect(['material', 'service']).toContain(row['Kind']);
  });

  it('the Import CSV dialog sample shows the same header row', () => {
    render(<ImportCSVDialog open onClose={() => {}} onImport={() => {}} />);
    const sample = document.querySelector('details pre');
    expect(sample).not.toBeNull();
    const sampleHeader = (sample!.textContent ?? '').trim().split('\n')[0];
    expect(sampleHeader).toBe(text.split(/\r?\n/)[0]);
  });
});
