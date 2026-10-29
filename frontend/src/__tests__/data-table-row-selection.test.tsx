import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { DataTable } from '@/components/data/data-table';

const mockApi = vi.mocked(api);

// DataTable's own width-measurement effect constructs a ResizeObserver; a
// constructable class is needed in jsdom (mirrors the other data-table-*.test.tsx files).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  // Radix's Popover (the Columns picker) needs these in jsdom to actually open —
  // mirrors data-table-visibility.test.tsx's beforeEach.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

type Row = { id: string; name: string; status: string };

const columns: ColumnDef<Row, unknown>[] = [
  { id: 'name', accessorKey: 'name', header: 'Name', cell: (c) => String(c.getValue()) },
  { id: 'status', accessorKey: 'status', header: 'Status', cell: (c) => String(c.getValue()) },
];

const data: Row[] = [
  { id: 'r1', name: 'Alpha Row', status: 'ACTIVE' },
  { id: 'r2', name: 'Beta Row', status: 'ACTIVE' },
];

// ─── Opt-in row selection (Estimates bulk-delete) ──────────────────────────
// DataTable is shared by 5 list pages (Estimates/Leads/Jobs/Invoices/Customers). SRVW-104 added
// Jobs as a second opt-in (bulk status/assign) alongside Estimates (bulk delete) - Leads, Invoices
// and Customers pass none of these props at all. The "omitted" suite below is the regression guard
// that matters most for those 3 - see file header of data-table.tsx.

describe('DataTable — enableRowSelection OMITTED (regression guard for the 3 non-opted-in callers)', () => {
  it('renders no checkbox column and is behaviorally unchanged', async () => {
    renderWithProviders(<DataTable columns={columns} data={data} />);

    expect(await screen.findByRole('columnheader', { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
    // No selection UI anywhere — this is the load-bearing assertion for the regression guard.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText('Alpha Row')).toBeInTheDocument();
    expect(screen.getByText('Beta Row')).toBeInTheDocument();
  });
});

describe('DataTable — enableRowSelection passed (Estimates bulk-delete opt-in)', () => {
  it('renders a checkbox column; clicking a row checkbox reports that row id as selected', async () => {
    const onRowSelectionChange = vi.fn();
    renderWithProviders(
      <DataTable
        columns={columns}
        data={data}
        enableRowSelection
        rowSelection={{}}
        onRowSelectionChange={onRowSelectionChange}
        getRowId={(row) => row.id}
      />
    );

    await screen.findByRole('columnheader', { name: /name/i });
    expect(screen.getByRole('checkbox', { name: /select all rows/i })).toBeInTheDocument();
    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    expect(rowCheckboxes).toHaveLength(2);

    fireEvent.click(rowCheckboxes[0]);

    expect(onRowSelectionChange).toHaveBeenCalledWith({ r1: true });
  });

  it('clicking the header checkbox selects all currently-rendered rows', async () => {
    const onRowSelectionChange = vi.fn();
    renderWithProviders(
      <DataTable
        columns={columns}
        data={data}
        enableRowSelection
        rowSelection={{}}
        onRowSelectionChange={onRowSelectionChange}
        getRowId={(row) => row.id}
      />
    );

    const selectAll = await screen.findByRole('checkbox', { name: /select all rows/i });
    fireEvent.click(selectAll);

    expect(onRowSelectionChange).toHaveBeenCalledWith({ r1: true, r2: true });
  });

  it('clicking the header checkbox again deselects all rows when all are already selected', async () => {
    const onRowSelectionChange = vi.fn();
    renderWithProviders(
      <DataTable
        columns={columns}
        data={data}
        enableRowSelection
        rowSelection={{ r1: true, r2: true }}
        onRowSelectionChange={onRowSelectionChange}
        getRowId={(row) => row.id}
      />
    );

    const selectAll = await screen.findByRole('checkbox', { name: /select all rows/i }) as HTMLInputElement;
    expect(selectAll.checked).toBe(true);

    fireEvent.click(selectAll);

    expect(onRowSelectionChange).toHaveBeenCalledWith({});
  });

  it('does not leak the "__select" checkbox column into the Columns visibility picker', async () => {
    renderWithProviders(
      <DataTable
        columns={columns}
        data={data}
        enableRowSelection
        rowSelection={{}}
        onRowSelectionChange={vi.fn()}
        getRowId={(row) => row.id}
      />
    );

    await screen.findByRole('columnheader', { name: /name/i });
    fireEvent.click(screen.getByRole('button', { name: /columns/i }));

    // The real columns (name, status) are listed as checkboxes; the synthetic '__select' column —
    // which would otherwise render as a broken, mislabeled "  select" row since its header is a
    // component, not a string — must not appear at all.
    expect(await screen.findByRole('checkbox', { name: /^name$/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^status$/i })).toBeInTheDocument();
    // Anchored/exact — a loose /select/i would also match the table's own "Select all rows" /
    // "Select row" checkboxes, which legitimately exist elsewhere on the page. A leaked '__select'
    // popover entry would have an accessible name of exactly "select" (its id with underscores
    // turned to spaces, whitespace-collapsed) — distinct from those.
    expect(screen.queryByRole('checkbox', { name: /^select$/i })).not.toBeInTheDocument();
  });
});
