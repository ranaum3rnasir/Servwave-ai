import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { DataTable } from '@/components/data/data-table';

const mockApi = vi.mocked(api);

// The shared setup mocks ResizeObserver with an arrow fn, which Radix's
// floating-ui calls with `new` — a constructable class is needed to open the
// Columns Popover in jsdom. Scoped to this file.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

// ─── Bug #55 ──────────────────────────────────────────────
// A list page that passes only `tableKey` (no controlled columnVisibility /
// onColumnVisibilityChange props — like EstimatesPage/LeadsPage/JobsPage) must:
//   1. hide a column when it is unchecked in the Columns picker, and
//   2. re-apply a hidden column from a restored saved view on mount.
// Before the fix, the saved-view restore effect called the (undefined) parent
// callback instead of table.setColumnVisibility, so the hidden set was dropped.

type Row = { id: string; name: string; status: string };

const columns: ColumnDef<Row, unknown>[] = [
  { id: 'name', accessorKey: 'name', header: 'Name', cell: (c) => String(c.getValue()) },
  { id: 'status', accessorKey: 'status', header: 'Status', cell: (c) => String(c.getValue()) },
];

const data: Row[] = [{ id: 'r1', name: 'Alpha Row', status: 'ACTIVE' }];

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no saved view stored (controller returns empty object → null config).
  mockApi.get.mockResolvedValue({ data: {} });
});

describe('DataTable self-managed column visibility (Bug #55)', () => {
  it('hides a column when unchecked in the Columns picker (uncontrolled page)', async () => {
    renderWithProviders(<DataTable columns={columns} data={data} tableKey="bug55" />);

    // Both headers render initially. Header label "Status" appears in the table
    // header AND in the Columns popover, so scope to the column header role.
    expect(await screen.findByRole('columnheader', { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();

    // Open the Columns picker and uncheck "Status".
    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    const statusCheckbox = await screen.findByRole('checkbox', { name: /status/i });
    fireEvent.click(statusCheckbox);

    // The Status column header is now gone from the table.
    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: /status/i })).not.toBeInTheDocument();
    });
    // The locked/other column stays.
    expect(screen.getByRole('columnheader', { name: /name/i })).toBeInTheDocument();
  });

  it('re-applies a hidden column from a restored saved view on mount', async () => {
    // Saved view marks "status" as hidden.
    mockApi.get.mockResolvedValue({
      data: {
        version: 1,
        columns: {
          name: { visible: true },
          status: { visible: false },
        },
      },
    });

    renderWithProviders(<DataTable columns={columns} data={data} tableKey="bug55" />);

    // Name header is always present.
    expect(await screen.findByRole('columnheader', { name: /name/i })).toBeInTheDocument();

    // The saved view hid Status, so it must NOT appear once the view resolves.
    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: /status/i })).not.toBeInTheDocument();
    });
  });
});
