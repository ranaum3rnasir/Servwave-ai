/* =============================================================================
   Line-item workspace grid guard - #2091.

   A two-column grid built as `grid-cols-[1fr_320px]` (a Tailwind arbitrary
   value) resolves the bare `1fr` track to `minmax(auto, 1fr)`, whose MINIMUM
   is the content's own min-content width, not zero. When the wide column
   hosts `LineItemsTable` (min-width ~1040px, meant to scroll inside its own
   `overflow-x-auto` wrapper), that min-content width wins and the grid track
   - and with it the whole page - is forced wide at narrower viewports
   (~1280px). The line-item table's Totals column is pushed off-screen and
   the page's own scroll container (`main.canvas-body`) becomes horizontally
   scrollable, with clicks on some controls scrolling it sideways and no
   visible way back.

   Fix: `minmax(0,1fr)` instead of the bare `1fr` on every such grid. A zero
   minimum lets the track shrink to the space actually available, so the
   table's own `overflow-x-auto` wrapper is what scrolls, not the page.

   This guard scans every page source file that renders a `LineItemsTable`-
   backed editor (`EstimateLineItemsEditor`, `InvoiceLineItemsEditor`,
   `LineItemsEditor`) for a `grid-cols-[1fr_...px]`-shaped Tailwind class:
   a bare `1fr` immediately followed by a fixed pixel track. That shape is
   the bug; `minmax(0,1fr)` in the same spot is the fix and does not match.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pages');

const LINE_ITEM_EDITORS = ['EstimateLineItemsEditor', 'InvoiceLineItemsEditor', 'LineItemsEditor'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** A bare `1fr` track immediately followed by a fixed-pixel track: the min-content trap. */
const BARE_1FR_TRACK = /grid-cols-\[1fr_[0-9]+px/g;

function hostsLineItemsTable(src: string): boolean {
  return LINE_ITEM_EDITORS.some((name) => src.includes(`<${name}`));
}

describe('line-item workspace grid guard (#2091)', () => {
  const pages = sourceFiles(PAGES).map((file) => [file, readFileSync(file, 'utf8')] as const);
  const hosts = pages.filter(([, src]) => hostsLineItemsTable(src));

  it('found at least one page that hosts a line-item table editor', () => {
    // Sanity check that the scan itself is wired correctly, matching the
    // both-directions pattern of the other source-scan guards in this suite.
    expect(hosts.length).toBeGreaterThan(0);
  });

  it('no page hosting a line-item table uses a bare-1fr grid track next to a fixed sidebar', () => {
    const offenders: string[] = [];
    for (const [file, src] of hosts) {
      for (const m of src.matchAll(BARE_1FR_TRACK)) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${relative(PAGES, file)}:${line} (${m[0]})`);
      }
    }
    expect(
      offenders,
      `Use minmax(0,1fr) instead so the table's own overflow-x-auto wrapper scrolls, not the page:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the pattern fires on the bug shape and stays quiet on the minmax(0,...) fix', () => {
    expect('lg:grid-cols-[1fr_320px]'.match(BARE_1FR_TRACK)).toHaveLength(1);
    expect('lg:grid-cols-[1fr_260px]'.match(BARE_1FR_TRACK)).toHaveLength(1);
    expect('lg:grid-cols-[minmax(0,1fr)_320px]'.match(BARE_1FR_TRACK)).toBeNull();
    expect('lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]'.match(BARE_1FR_TRACK)).toBeNull();
  });
});
