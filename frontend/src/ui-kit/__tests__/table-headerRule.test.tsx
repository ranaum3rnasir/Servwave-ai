import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';

/**
 * THE HEADER RULE HAS TO SURVIVE A PINNED COLUMN.
 *
 * Reported on /v2/leads: the rule under the column headers was missing for the
 * leading checkbox, "Lead #" and "Customer" cells and only appeared from
 * "Phone" onward - exactly the width of the sticky run. The rule was declared
 * on the header `<tr>`, and under `border-collapse: collapse` a border belongs
 * to the table's grid rather than to the element that declared it, so an opaque
 * `position: sticky` cell - which paints in a later layer - covered it. Every
 * list that pins its identity columns had the same fault.
 *
 * The fix is structural: the table is `border-separate` with
 * `border-spacing-0`, and each cell draws its own `border-b`. So the assertions
 * here are (a) the separated model is in force, because a cell border under
 * `collapse` is hoisted to the grid and covered all over again, and (b) every
 * header cell carries the rule, pinned ones included.
 *
 * Asserted on classes rather than computed style because jsdom loads no
 * stylesheet - `getComputedStyle` reports nothing for a Tailwind class.
 */

interface Row {
  id: string;
  name: string;
  city: string;
}

const rows: Row[] = [{ id: 'L00001', name: 'Alpha', city: 'Richmond' }];

const columns: ColumnDef<Row, unknown>[] = [
  {
    id: 'lead_number',
    accessorKey: 'id',
    header: 'Lead #',
    size: 90,
    meta: { label: 'Lead #', pinned: true, fixed: true },
    cell: ({ row }) => <span>{row.original.id}</span>,
  },
  {
    id: 'customer',
    accessorKey: 'name',
    header: 'Customer',
    size: 170,
    meta: { label: 'Customer', pinned: true },
    cell: ({ row }) => <span>{row.original.name}</span>,
  },
  {
    id: 'city',
    accessorKey: 'city',
    header: 'City',
    size: 140,
    meta: { label: 'City' },
    cell: ({ row }) => <span>{row.original.city}</span>,
  },
];

const renderTable = () =>
  render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

describe('the header rule is drawn by the header cells', () => {
  it('runs the table in the separated border model, so a cell border is the cell\'s own', () => {
    renderTable();

    const table = document.querySelector('[data-slot="table"]')!;
    expect(table.className).toContain('border-separate');
    expect(table.className).toContain('border-spacing-0');
    // The collapsed model is the bug: it hoists every border to the table grid,
    // where a sticky cell paints over it.
    expect(table.className).not.toContain('border-collapse');
  });

  it('gives every header cell the rule, the pinned ones included', () => {
    renderTable();

    for (const name of ['Lead #', 'Customer', 'City']) {
      const cell = screen.getByRole('columnheader', { name });
      expect(cell.className).toContain('border-b');
    }
  });

  it('keeps the rule on the pinned header cell that is also sticky', () => {
    renderTable();

    const pinned = screen.getByRole('columnheader', { name: 'Lead #' });
    // Both facts together are the bug: sticky AND carrying its own rule.
    expect(pinned.style.position).toBe('sticky');
    expect(pinned.className).toContain('border-b');
  });

  it('no longer declares the rule on the header row or the row group', () => {
    renderTable();

    const head = document.querySelector('[data-slot="table-header"]')!;
    const headerRow = head.querySelector('tr')!;
    // A row cannot paint a border in the separated model at all, so leaving one
    // declared here would be a silent no-op that reads as the rule's source.
    expect(head.className).not.toContain('border-b');
    expect(headerRow.className).not.toContain('border-b');
  });

  it('draws the body rules on the cells too, and drops the last row\'s', () => {
    renderTable();

    const body = document.querySelector('[data-slot="table-body"]')!;
    const cells = body.querySelectorAll('td');
    for (const cell of cells) expect(cell.className).toContain('border-b');
    expect(body.querySelector('tr')!.className).not.toContain('border-b');
    // The container draws the table's own bottom edge, so the final row must not
    // double it.
    expect(body.className).toContain('[&_tr:last-child>td]:border-b-0');
  });
});
