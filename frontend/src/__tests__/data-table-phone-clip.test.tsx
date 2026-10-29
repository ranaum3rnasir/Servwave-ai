import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { DataTable } from '@/components/data/data-table';

const mockApi = vi.mocked(api);

// Radix's floating-ui calls ResizeObserver with `new`; DataTable's own effect
// also constructs one to measure the scroll container — a constructable class is
// needed in jsdom. Scoped to this file.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom always reports clientWidth === 0, which would drive computeLayout with a
// 0-width box. Pin a realistic wide content box so the measured-width path
// (scrollContainerRef.clientWidth) produces a deterministic layout. This is the
// value the fix reads; the pre-fix code read the OUTER wrapper's offsetWidth.
const MEASURED_WIDTH = 1200;

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: MEASURED_WIDTH,
  });
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

afterEach(() => {
  // Restore clientWidth so we don't leak the override into other suites.
  delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
});

// ─── Bug #454 ─────────────────────────────────────────────
// The Leads Phone column was left-clipped (":301) 758-4551") because the desktop
// table phantom-overflowed its scroll box: DataTable measured the OUTER wrapper's
// offsetWidth (wider than the inner scroll container's clientWidth), so columns
// summed wider than the real box → scrollLeft > 0 → the opaque sticky customer
// column painted over the phone cell's left edge. The fix measures the scroll
// container's clientWidth, so the resolved widths never exceed the real box.

type Row = { id: string; customer: string; phone: string };

const columns: ColumnDef<Row, unknown>[] = [
  {
    id: 'customer',
    accessorKey: 'customer',
    header: 'Customer',
    enableHiding: false,
    enableSorting: false,
    meta: { locked: true, pinned: true, growWeight: 1.5, minWidth: 140 },
    cell: (c) => String(c.getValue()),
  },
  {
    id: 'phone',
    accessorKey: 'phone',
    header: 'Phone',
    enableSorting: false,
    meta: { fixed: true, minWidth: 80 },
    cell: (c) => String(c.getValue()),
  },
];

const data: Row[] = [{ id: 'r1', customer: 'Alpha Co', phone: '(301) 758-4551' }];

describe('DataTable measures the scroll-container content box (Bug #454)', () => {
  it('resolved column widths sum within the measured content box (no phantom overflow)', async () => {
    renderWithProviders(<DataTable columns={columns} data={data} tableKey="bug454" />);

    // Desktop header renders.
    expect(await screen.findByRole('columnheader', { name: /customer/i })).toBeInTheDocument();

    await waitFor(() => {
      const heads = Array.from(
        document.querySelectorAll<HTMLElement>('th[data-col-id]')
      );
      expect(heads.length).toBeGreaterThan(0);
      const sum = heads.reduce((acc, th) => acc + parseFloat(th.style.width || '0'), 0);
      // Columns must fit within the measured content box — never wider (which is
      // what let the sticky column clip its neighbor).
      expect(sum).toBeLessThanOrEqual(MEASURED_WIDTH + 0.5);
    });
  });

  it('renders the full phone value (no left clip)', async () => {
    renderWithProviders(<DataTable columns={columns} data={data} tableKey="bug454b" />);
    expect(await screen.findByText('(301) 758-4551')).toBeInTheDocument();
  });
});
