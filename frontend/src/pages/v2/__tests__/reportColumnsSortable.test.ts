import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every report column that has an order to sort into declares one.
 *
 * `ReportTable` gives a column a clickable header exactly when it carries a
 * `sortValue`, so a missing one is a header that looks like plain text and is.
 * The owner asked for sorting across the report grids; almost all of them
 * already had it, and this pins the handful that did not plus the short list
 * that legitimately cannot.
 *
 * A SOURCE SCAN rather than a render, because the column arrays are built
 * inside their report components from live data - reaching them through the UI
 * would mean standing up nine reports with fixtures to assert a property of the
 * declarations. The scan reads the same thing the adapter does.
 *
 * REPORT TABLES GET SORTING BUT NO SELECTION CHECKBOX, which is why this file
 * says nothing about one: a report row has no bulk action behind it, so a
 * checkbox there would tick a state nothing can consume. Confirmed with the
 * owner.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(HERE, '..', 'reports');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * `{ id: 'x', ... cell: ... }` object literals that carry a `cell` - the report
 * column model's one required renderer - and no `sortValue`.
 *
 * The enclosing literal is found by walking back to its unmatched `{`, so a
 * column written across ten lines is read the same as one written inline.
 */
function unsortableColumnIds(source: string): string[] {
  const ids: string[] = [];
  const re = /\bid:\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let depth = 0;
    let start = match.index - 1;
    while (start >= 0) {
      const ch = source[start];
      if (ch === '}') depth++;
      else if (ch === '{') { if (depth === 0) break; depth--; }
      start--;
    }
    if (start < 0) continue;

    let open = 0;
    let end = start;
    while (end < source.length) {
      const ch = source[end];
      if (ch === '{') open++;
      else if (ch === '}') { open--; if (open === 0) break; }
      end++;
    }

    const block = source.slice(start, end + 1);
    if (!/\bcell:/.test(block)) continue;
    if (/\bsortValue\b/.test(block)) continue;
    ids.push(match[1]!);
  }
  return ids;
}

/**
 * The columns with genuinely nothing to order by. Each one is a rendering, not
 * a value: three eight-week sparklines (a shape, and sorting by "which line
 * looks steepest" is not a thing a user can ask for), a follow-up link under a
 * blank header, and a Time off column whose cell is the literal "-" until the
 * field exists.
 */
const NO_ORDER: Record<string, string[]> = {
  'EstimateConversionReport.tsx': ['followUp'],
  'EstimatesReport.tsx': ['trend'],
  'GenericReport.tsx': ['trend'],
  'TechPerformanceBoard.tsx': ['trend'],
  'TimesheetsReport.tsx': ['timeoff'],
};

describe('report grids sort on every column that has an order', () => {
  it('leaves only the columns that render a shape or an action unsortable', () => {
    const found: Record<string, string[]> = {};
    for (const file of tsxFiles(REPORTS_DIR)) {
      const ids = unsortableColumnIds(readFileSync(file, 'utf8'));
      if (ids.length) found[file.split(/[\\/]/).pop()!] = ids;
    }

    expect(found).toEqual(NO_ORDER);
  });
});
