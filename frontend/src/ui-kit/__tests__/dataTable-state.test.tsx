import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';

/**
 * The kit DataTable held sorting, row selection and column visibility in its own
 * useState with no prop in and no callback out, and had no hook-in for the
 * per-user saved view the legacy table persists.
 *
 * That was not a latent risk. Five merged v2 lists each hit it and each worked
 * around it differently: estimates declared `enableSorting: false` on every
 * column and lost sorting outright, customers reached into the table instance
 * from components/bulkBar.tsx, invoices did the same from
 * components/tableEffects.tsx for BOTH visibility and selection, and all five
 * dropped the saved view that `tableKey` used to drive.
 *
 * Every assertion below was run against the unfixed component first. The
 * controlled-state, saved-view, pinning, resize and card-layout specs failed
 * there; the uncontrolled specs passed, and are here to prove the default path
 * did not move.
 */

interface Row {
  id: string;
  name: string;
  amount: number;
}

const rows: Row[] = [
  { id: 'a', name: 'Alpha', amount: 30 },
  { id: 'b', name: 'Bravo', amount: 20 },
  { id: 'c', name: 'Charlie', amount: 10 },
];

const columns: ColumnDef<Row, unknown>[] = [
  {
    id: '__select',
    size: 40,
    enableSorting: false,
    enableHiding: false,
    enableResizing: false,
    meta: { pinned: true, fixed: true },
    header: () => 'Pick',
    cell: ({ row }) => (
      <button type="button" onClick={() => row.toggleSelected()}>
        {`pick ${row.original.id}`}
      </button>
    ),
  },
  {
    accessorKey: 'name',
    meta: { label: 'Name' },
    header: ({ column }) => (
      <button type="button" onClick={column.getToggleSortingHandler()}>
        Name
      </button>
    ),
    cell: ({ row }) => row.original.name,
  },
  {
    accessorKey: 'amount',
    meta: { label: 'Amount' },
    header: () => 'Amount',
    cell: ({ row }) => String(row.original.amount),
  },
];

/** Body rows in render order, by their first data column. */
function names(): string[] {
  const body = document.querySelector('[data-slot="table-body"]')!;
  return Array.from(body.querySelectorAll('tr')).map(
    (tr) => tr.querySelectorAll('td')[1]?.textContent ?? '',
  );
}

function headerTexts(): string[] {
  return screen.getAllByRole('columnheader').map((th) => th.textContent ?? '');
}

// ─── sorting ──────────────────────────────────────────────────────────────────

describe('DataTable sorting', () => {
  it('reports a header click out through onSortingChange when controlled', async () => {
    const onSortingChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        sorting={[]}
        onSortingChange={onSortingChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Name' }));

    expect(onSortingChange).toHaveBeenCalledWith([{ id: 'name', desc: false }]);
  });

  it('renders the order the controlled sorting prop asks for', () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        sorting={[{ id: 'name', desc: true }]}
        onSortingChange={() => {}}
      />,
    );

    expect(names()).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('leaves the rows in server order when manualSorting is set', () => {
    // Server-side sorting: the page has already ordered the rows, so the table
    // must not re-sort them under the same sorting state.
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        manualSorting
        sorting={[{ id: 'name', desc: true }]}
        onSortingChange={() => {}}
      />,
    );

    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('still sorts itself when no sorting prop is passed', async () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });
});

// ─── row selection ────────────────────────────────────────────────────────────

describe('DataTable row selection', () => {
  it('lifts the selection out through onRowSelectionChange', async () => {
    const onRowSelectionChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        onRowSelectionChange={onRowSelectionChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'pick b' }));

    expect(onRowSelectionChange).toHaveBeenCalledWith({ b: true });
  });

  it('keeps selecting internally when only the callback is passed', async () => {
    // Observed-but-uncontrolled: the page reads the ids without having to own
    // the state, which is what the bulk bars actually need.
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        onRowSelectionChange={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'pick b' }));

    const body = document.querySelector('[data-slot="table-body"]')!;
    const selected = body.querySelectorAll('tr[data-state="selected"]');
    expect(selected).toHaveLength(1);
  });

  it('renders the selection the rowSelection prop asks for', () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        rowSelection={{ c: true }}
        onRowSelectionChange={() => {}}
      />,
    );

    const body = document.querySelector('[data-slot="table-body"]')!;
    const selected = Array.from(body.querySelectorAll('tr[data-state="selected"]'));
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain('Charlie');
  });

  it('still selects on its own when neither prop is passed', async () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    await userEvent.click(screen.getByRole('button', { name: 'pick a' }));

    const body = document.querySelector('[data-slot="table-body"]')!;
    expect(body.querySelectorAll('tr[data-state="selected"]')).toHaveLength(1);
  });
});

// ─── column visibility ────────────────────────────────────────────────────────

describe('DataTable column visibility', () => {
  it('hides the columns defaultColumnVisibility marks false, from the first render', () => {
    // The invoices list needs four money columns off until asked for.
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        defaultColumnVisibility={{ amount: false }}
      />,
    );

    expect(headerTexts()).toEqual(['Pick', 'Name']);
  });

  it('renders the visibility the columnVisibility prop asks for, and reports changes out', async () => {
    const onColumnVisibilityChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        columnVisibility={{ amount: false }}
        onColumnVisibilityChange={onColumnVisibilityChange}
      >
        {(table) => (
          <button type="button" onClick={() => table.getColumn('name')!.toggleVisibility(false)}>
            hide name
          </button>
        )}
      </DataTable>,
    );

    expect(headerTexts()).toEqual(['Pick', 'Name']);

    await userEvent.click(screen.getByRole('button', { name: 'hide name' }));

    expect(onColumnVisibilityChange).toHaveBeenCalledWith({ amount: false, name: false });
    // Controlled: the parent did not feed the new value back, so nothing moved.
    expect(headerTexts()).toEqual(['Pick', 'Name']);
  });

  it('still toggles on its own when no visibility props are passed', async () => {
    render(
      <DataTable columns={columns} data={rows} getRowId={(row) => row.id}>
        {(table) => (
          <button type="button" onClick={() => table.getColumn('amount')!.toggleVisibility(false)}>
            hide amount
          </button>
        )}
      </DataTable>,
    );

    expect(headerTexts()).toEqual(['Pick', 'Name', 'Amount']);
    await userEvent.click(screen.getByRole('button', { name: 'hide amount' }));
    expect(headerTexts()).toEqual(['Pick', 'Name']);
  });
});

// ─── saved view: REMOVED ──────────────────────────────────────────────────────

// The DataTable had a `savedView` adapter and a `helpers.saveView` /
// `helpers.resetColumnSizing` render-prop pair, and this file pinned all three:
// restore-once-when-the-fetch-settles, do-nothing-when-nothing-is-stored, and
// package-the-current-state-on-save. The only control that reached any of them
// was the v2 toolbar's "View" menu, which the owner asked to remove, so the
// prop and the helpers came out with it and these three cases have nothing left
// to assert against. The removal itself is pinned from the page side, in
// pages/v2/__tests__/listTableAdoption.test.tsx ("the saved-view menu is gone").

// ─── pinned columns ───────────────────────────────────────────────────────────

describe('DataTable pinned columns', () => {
  it('sticks a leading meta.pinned column to the left edge and leaves the rest alone', () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);

    const pinned = screen.getByRole('columnheader', { name: 'Pick' });
    expect(pinned.style.position).toBe('sticky');
    expect(pinned.style.left).toBe('0px');

    const unpinned = screen.getByRole('columnheader', { name: 'Amount' });
    expect(unpinned.style.position).toBe('');

    const body = document.querySelector('[data-slot="table-body"]')!;
    const firstCell = body.querySelector('tr')!.querySelectorAll('td')[0]!;
    expect(firstCell.style.position).toBe('sticky');
  });
});

// ─── column resizing ──────────────────────────────────────────────────────────

describe('DataTable column resizing', () => {
  it('renders no resize grip by default', () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
  });

  it('renders one grip per resizable column when enabled', () => {
    render(
      <DataTable columns={columns} data={rows} getRowId={(row) => row.id} enableColumnResizing />,
    );
    // '__select' sets enableResizing: false, so two of the three get a grip.
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  /**
   * The grip used to be 8px wide and centred on the column boundary, painting a
   * `bg-transparent` rule until hovered. TableHead clips its overflow, so the
   * outer half of that grip was clipped for hit-testing as well as for paint:
   * a 4px target against an invisible line, which is why the boundary read as
   * not draggable at all. Both halves of that are asserted here - the target
   * width and the resting rule - because both were the bug.
   */
  it('gives the grip a wide hit area inside the cell and a visible resting rule', () => {
    render(
      <DataTable columns={columns} data={rows} getRowId={(row) => row.id} enableColumnResizing />,
    );

    for (const grip of screen.getAllByRole('separator')) {
      expect(grip.className).toContain('w-3');       // 12px target, not 8px
      expect(grip.className).toContain('right-0');   // wholly inside the clip
      expect(grip.className).toContain('after:bg-input');
      expect(grip.className).not.toContain('after:bg-transparent');
    }
  });
});

// ─── mobile card layout ───────────────────────────────────────────────────────

describe('DataTable mobile cards', () => {
  function setViewport(matches: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);
  }

  it('swaps the table for labelled cards below the md breakpoint', () => {
    setViewport(true);
    const { container } = render(
      <DataTable columns={columns} data={rows} getRowId={(row) => row.id} mobileCards />,
    );

    expect(container.querySelector('table')).toBeNull();
    const cards = container.querySelectorAll('[data-slot="table-card"]');
    expect(cards).toHaveLength(3);
    // The label comes from meta.label, so a card reads "Name / Alpha", never
    // "name / Alpha".
    expect(within(cards[0] as HTMLElement).getByText('Name')).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText('Alpha')).toBeTruthy();
    vi.restoreAllMocks();
  });

  it('keeps the table above the breakpoint, and whenever the prop is off', () => {
    setViewport(true);
    const off = render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);
    expect(off.container.querySelector('table')).not.toBeNull();
    off.unmount();

    setViewport(false);
    const wide = render(
      <DataTable columns={columns} data={rows} getRowId={(row) => row.id} mobileCards />,
    );
    expect(wide.container.querySelector('table')).not.toBeNull();
    vi.restoreAllMocks();
  });
});
