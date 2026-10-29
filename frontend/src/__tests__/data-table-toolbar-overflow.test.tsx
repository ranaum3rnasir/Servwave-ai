import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
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
    value: 1200,
  });
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

afterEach(() => {
  // Restore clientWidth so we don't leak the override into other suites.
  delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
});

// ─── Bug #377 ─────────────────────────────────────────────
// The DataTable toolbar overflowed horizontally at 640-900px viewports (Invoices
// and every other list page): the search wrapper is a flex item, and flex items
// default to `min-width: auto`, so the wrapper could never shrink below the
// <input>'s intrinsic min-content width (~200px). `max-w-sm` is only a CAP — it
// never grants shrink permission — so the row's min-content width exceeded the
// viewport and pushed the Filter button + right-side actions off-screen.
// The fix is `min-w-0` on the search wrapper (shrink permission) plus
// `flex-wrap sm:shrink-0` on the right-side actions cluster (it becomes the
// fixed cluster the search yields to; below-sm the buttons wrap instead of
// clipping). jsdom cannot compute flex layout, so this guard asserts the class
// contract — do NOT "simplify" these classes away; removing `min-w-0`
// reintroduces the flexbox `min-width:auto` overflow trap.

type Row = { id: string; name: string };

const columns: ColumnDef<Row, unknown>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    enableSorting: false,
    cell: (c) => String(c.getValue()),
  },
];

const data: Row[] = [{ id: 'r1', name: 'Alpha Co' }];

describe('DataTable toolbar shrink/wrap contract (Bug #377)', () => {
  it('search wrapper has min-w-0 alongside max-w-sm so it can shrink below intrinsic width', async () => {
    renderWithProviders(
      <DataTable
        columns={columns}
        data={data}
        tableKey="bug377a"
        onSearchChange={() => {}}
        searchPlaceholder="Search invoices..."
        filters={<button type="button">Filter</button>}
        headerActions={<button type="button">New Invoice</button>}
      />
    );

    const input = await screen.findByPlaceholderText('Search invoices...');
    const wrapper = input.parentElement as HTMLElement;
    expect(wrapper.classList.contains('max-w-sm')).toBe(true);
    expect(wrapper.classList.contains('min-w-0')).toBe(true);
  });

  it('right-side actions cluster keeps sm:shrink-0 and flex-wrap so buttons never squash or clip', async () => {
    renderWithProviders(
      <DataTable
        columns={columns}
        data={data}
        tableKey="bug377b"
        onSearchChange={() => {}}
        searchPlaceholder="Search invoices..."
        filters={<button type="button">Filter</button>}
        headerActions={<button type="button" data-testid="header-action">New Invoice</button>}
      />
    );

    const action = await screen.findByTestId('header-action');
    const cluster = action.parentElement as HTMLElement;
    expect(cluster.classList.contains('flex-wrap')).toBe(true);
    expect(cluster.classList.contains('sm:shrink-0')).toBe(true);
  });
});
