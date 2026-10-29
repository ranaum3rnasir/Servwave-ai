import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';

/**
 * A pinned column has to stick where it actually sits.
 *
 * `pinnedOffsets` built each sticky `left` by accumulating the widths the
 * table's own layout pass ASSIGNS to the columns before it. Those are a
 * request, not a fact: the table renders `table-layout: auto`, so the browser
 * recomputes every column from its content and routinely disagrees with the
 * request. When it does, the second and later pinned columns stick to an edge
 * that is not their own, and because a pinned cell is opaque
 * (`TableCell pinned` -> `bg-kit-card`) it paints over its neighbour.
 *
 * Measured in the running app rather than argued from the source:
 *
 *   /v2/inventory  SKU asks 120px, renders 85px. The Item column's sticky
 *                  edge therefore sat 35px right of where Item actually
 *                  starts, and Item painted over the first 35px (~3
 *                  characters) of Category - "egory", "gnostics", "ctrical /
 *                  ts" - in the header and in every row, at scrollLeft 0.
 *   /v2/leads      Lead # asks 90px, renders 102px. Sign flipped, so nothing
 *                  is wrong at rest, but once the table is scrolled Lead #
 *                  paints 12px over the Customer column.
 *
 * Five of the six v2 lists pin more than one column and are all exposed;
 * invoices pins only the leading checkbox, whose offset is 0 either way, and
 * is the one that cannot show it.
 */

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [{ id: 'a', name: 'Alpha' }];

const columns: ColumnDef<Row, unknown>[] = [
  {
    id: 'sku',
    // Asks for 40. The stub below renders it at 64, the same shape as
    // inventory's 120-asked / 85-rendered.
    size: 40,
    meta: { pinned: true, fixed: true },
    header: () => 'SKU',
    cell: () => 'S-1',
  },
  {
    id: 'item',
    size: 100,
    meta: { pinned: true },
    header: () => 'Item',
    cell: ({ row }) => row.original.name,
  },
  {
    id: 'category',
    size: 100,
    meta: { label: 'Category' },
    header: () => 'Category',
    cell: () => 'Diagnostics',
  },
];

/** Render every cell at the width the browser would actually give it. */
function stubRenderedWidths(widths: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = widths[this.dataset.colId ?? ''] ?? 0;
    return {
      width,
      height: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DataTable pinned column offsets', () => {
  it('offsets a pinned column by the width its neighbour actually renders, not the width it asked for', () => {
    stubRenderedWidths({ sku: 64, item: 100, category: 100 });
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    const item = screen.getByRole('columnheader', { name: 'Item' });
    expect(item.style.position).toBe('sticky');
    // 64, the rendered width of SKU - not 40, the width SKU asked for.
    expect(item.style.left).toBe('64px');
  });

  it('offsets the body cells by the same measurement as the header', () => {
    stubRenderedWidths({ sku: 64, item: 100, category: 100 });
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    const cells = document
      .querySelector('[data-slot="table-body"]')!
      .querySelector('tr')!
      .querySelectorAll('td');

    expect(cells[1]!.style.left).toBe('64px');
    // The unpinned column is never given an offset, whatever was measured.
    expect(cells[2]!.style.position).toBe('');
  });

  it('leaves the first pinned column at the left edge', () => {
    stubRenderedWidths({ sku: 64, item: 100, category: 100 });
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    expect(screen.getByRole('columnheader', { name: 'SKU' }).style.left).toBe('0px');
  });

  it('falls back to the requested width when nothing has been measured yet', () => {
    // No stub: jsdom reports every box as 0x0, which is what the very first
    // paint looks like before layout has happened. A zero must not collapse
    // every pinned column onto the left edge on top of each other.
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    expect(screen.getByRole('columnheader', { name: 'Item' }).style.left).toBe('40px');
  });
});
