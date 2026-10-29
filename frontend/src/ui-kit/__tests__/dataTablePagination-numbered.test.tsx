import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { getCoreRowModel, useReactTable, type PaginationState } from '@tanstack/react-table';

import { DataTablePagination, type DataTablePaginationProps } from '@/ui-kit/components/data/dataTable/dataTablePagination';

/**
 * The kit pager's opt-in numbered mode (visits slice 06): clickable page numbers with ellipses
 * for long ranges, inside a labelled nav, with "Showing X-Y of N" and the rows selector kept.
 * The default mode is unchanged for every other table.
 *
 * Driven through a server-paged table instance - the same shape DataTable's server paging and
 * the customer page's list pager hand it.
 */
function Harness({ total, variant }: { total: number; variant?: DataTablePaginationProps<never>['variant'] }) {
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });
  const table = useReactTable<never>({
    data: [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: total,
    pageCount: Math.ceil(total / pagination.pageSize),
    state: { pagination },
    onPaginationChange: setPagination,
  });
  return <DataTablePagination table={table} variant={variant} />;
}

const readout = () => screen.getByText(/^Showing/).textContent;

afterEach(() => {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
});

describe('DataTablePagination variant="numbered"', () => {
  it('draws the page numbers inside a labelled nav, the current one marked', () => {
    render(<Harness total={150} variant="numbered" />);

    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    const pages = within(nav).getAllByRole('button', { name: /^Page \d+$/ }).map((b) => b.textContent);
    expect(pages).toEqual(['1', '2', '3', '4', '5', '8']);
    expect(within(nav).getAllByText('…')).toHaveLength(1);
    expect(within(nav).getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Page 2' })).not.toHaveAttribute('aria-current');
    // The readout and the rows selector stay.
    expect(readout()).toBe('Showing 1-20 of 150');
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('clicking 3 loads page 3', () => {
    render(<Harness total={150} variant="numbered" />);

    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));

    expect(readout()).toBe('Showing 41-60 of 150');
    expect(screen.getByRole('button', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page');
  });

  it('previous and next step one page, and the window follows the current page', () => {
    render(<Harness total={150} variant="numbered" />);

    fireEvent.click(screen.getByRole('button', { name: 'Page 8' }));
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));

    expect(readout()).toBe('Showing 101-120 of 150');
    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    expect(within(nav).getAllByRole('button', { name: /^Page \d+$/ }).map((b) => b.textContent))
      .toEqual(['1', '4', '5', '6', '7', '8']);
    expect(screen.getByRole('button', { name: 'Page 6' })).toHaveAttribute('aria-current', 'page');
  });

  it('one page: a single current page, previous and next disabled', () => {
    render(<Harness total={20} variant="numbered" />);

    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('on a phone the window is compact: first, current, last', () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === '(max-width: 639px)', media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);
    render(<Harness total={2000} variant="numbered" />);

    fireEvent.click(screen.getByRole('button', { name: 'Page 100' }));
    fireEvent.click(screen.getByRole('button', { name: 'Page 98' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    expect(within(nav).getAllByRole('button', { name: /^Page \d+$/ }).map((b) => b.textContent))
      .toEqual(['1', '97', '100']);
    expect(within(nav).getAllByText('…')).toHaveLength(2);
  });
});

describe('DataTablePagination default mode is unchanged', () => {
  it('"Page n of m" with first/previous/next/last, and no page numbers', () => {
    render(<Harness total={150} />);

    expect(screen.getByText(/^Page \d+ of \d+$/)).toHaveTextContent('Page 1 of 8');
    expect(screen.getByRole('button', { name: 'First page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last page' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Page 2' })).toBeNull();
  });
});
