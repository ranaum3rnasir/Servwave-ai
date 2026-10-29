import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { Table, TableBody, TableCell, TableRow } from '@/ui-kit/components/ui/table';

/**
 * Row hover has to tint the WHOLE row, pinned columns included.
 *
 * `TableRow` carries `hover:bg-muted` and `data-[state=selected]:bg-selected`,
 * but a pinned `TableHead`/`TableCell` painted its OWN opaque `bg-kit-card`,
 * and a background set on the cell wins over one set on the row. On every list
 * that pins its identity columns - inventory, leads, jobs, customers,
 * estimates - hovering therefore tinted only the columns right of the sticky
 * run and left the pinned ones at the resting colour, so the highlight covered
 * a fraction of the row. The selected state had the identical fault.
 *
 * The pinned background cannot simply be dropped: a sticky cell must occlude
 * the content scrolling underneath it or the two overlap. So the row owns the
 * background and the pinned cells INHERIT it - `bg-inherit` on the cell picks
 * up whatever the `<tr>` currently paints, which is the resting surface, the
 * hover tint or the selected tint, whichever applies.
 *
 * Asserted on classes rather than computed colour because jsdom loads no
 * stylesheet: `getComputedStyle` reports nothing for a Tailwind class, and a
 * `:hover` rule has no representation there at all.
 */

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [{ id: 'a', name: 'Alpha' }];

const columns: ColumnDef<Row, unknown>[] = [
  {
    id: 'sku',
    accessorKey: 'id',
    header: 'SKU',
    size: 60,
    meta: { label: 'SKU', pinned: true },
    cell: ({ row }) => <span>{row.original.id}</span>,
  },
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    size: 120,
    meta: { label: 'Name' },
    cell: ({ row }) => <span>{row.original.name}</span>,
  },
];

describe('the row owns its background', () => {
  it('paints the resting surface on the row, so hover and selected cover all of it', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>Alpha</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const row = screen.getByRole('row');
    // The base surface has to live here, not on the container: a `bg-inherit`
    // cell resolves against its <tr>, and a transparent <tr> would leave every
    // sticky cell see-through.
    expect(row.className).toContain('bg-kit-card');
    expect(row.className).toContain('hover:bg-muted');
    expect(row.className).toContain('data-[state=selected]:bg-selected');
  });
});

describe('a pinned cell adopts the row background instead of pinning its own', () => {
  it('gives the pinned header no background of its own', () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    const pinned = screen.getByRole('columnheader', { name: 'SKU' });
    expect(pinned.style.position).toBe('sticky');
    expect(pinned.className).toContain('bg-inherit');
    expect(pinned.className).not.toContain('bg-kit-card');
  });

  it('gives the pinned body cell no background of its own', () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    const body = document.querySelector('[data-slot="table-body"]')!;
    const pinned = body.querySelector('tr')!.querySelectorAll('td')[0]!;
    expect(pinned.style.position).toBe('sticky');
    expect(pinned.className).toContain('bg-inherit');
    expect(pinned.className).not.toContain('bg-kit-card');
  });

  it('leaves an unpinned cell with no background class at all', () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    const body = document.querySelector('[data-slot="table-body"]')!;
    const unpinned = body.querySelector('tr')!.querySelectorAll('td')[1]!;
    expect(unpinned.className).not.toContain('bg-inherit');
    expect(unpinned.className).not.toContain('bg-kit-card');
  });

  /**
   * The rows that opt out of the hover tint have to opt back into the resting
   * surface, not into transparency: the header row is the one row whose pinned
   * cells are always over scrolling content.
   */
  it('keeps the header row opaque rather than transparent', () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    const headerRow = document.querySelector('[data-slot="table-header"] tr')!;
    expect(headerRow.className).not.toContain('hover:bg-transparent');
    expect(headerRow.className).toContain('hover:bg-kit-card');
  });
});
