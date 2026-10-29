import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui-kit/components/ui/table';

/**
 * Mobile slice 17: a wide admin table scrolls sideways inside its own box, its
 * identifying first column stays put, and the page never scrolls sideways.
 *
 * `scrollBox="<name>"` is the one switch. It names the box (the mobile gate's
 * exemption list is `ui-kit/lib/intendedScrollers.ts`), puts the marker the gate
 * reads on the scroll container, and pins the first column. Without it a table
 * renders exactly as before - desktop looks as today.
 */

const STICKY_FIRST = '[&_tr>:first-child]:sticky';

function kitTable(scrollBox?: 'settings-users') {
  return render(
    <Table scrollBox={scrollBox}>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Ada</TableCell>
          <TableCell>ada@example.com</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
}

describe('kit Table scrollBox', () => {
  it('marks the scroll container with the box name and pins the first column', () => {
    const { container } = kitTable('settings-users');
    const box = container.querySelector('[data-slot="table-container"]')!;
    expect(box).toHaveAttribute('data-mobile-scroll-x', 'settings-users');
    const classes = box.className.split(/\s+/);
    expect(classes).toContain('overflow-x-auto');
    // The box never grows past its parent, so the PAGE cannot scroll sideways.
    expect(classes).toContain('max-w-full');
    expect(classes).toContain(STICKY_FIRST);
    expect(classes).toContain('[&_tr>:first-child]:left-0');
    // Opaque, and the same colour as its row (hover and selection included).
    expect(classes).toContain('[&_tr>:first-child]:bg-inherit');
  });

  it('is a named, keyboard-focusable region, so a keyboard user can scroll it even when it holds nothing focusable', () => {
    // axe scrollable-region-focusable: a sideways scroller with no focusable content (an empty
    // Locations list on a phone) cannot be reached or scrolled without a pointer otherwise.
    kitTable('settings-users');
    const region = screen.getByRole('region', { name: 'Users table' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveAttribute('data-mobile-scroll-x', 'settings-users');
    // A visible ring for keyboard focus only - a mouse click on a row draws nothing (desktop as today).
    expect(region.className.split(/\s+/)).toContain('focus-visible:outline-2');
  });

  it('without scrollBox is not a focusable region', () => {
    const { container } = kitTable();
    const box = container.querySelector('[data-slot="table-container"]')!;
    expect(box).not.toHaveAttribute('tabindex');
    expect(box).not.toHaveAttribute('role');
  });

  it('without scrollBox renders exactly as before: no marker, no sticky column', () => {
    const { container } = kitTable();
    const box = container.querySelector('[data-slot="table-container"]')!;
    expect(box).not.toHaveAttribute('data-mobile-scroll-x');
    expect(box.className).toBe('relative w-full overflow-x-auto');
  });
});

interface Row {
  id: string;
  name: string;
  email: string;
  phone: string;
}
const rows: Row[] = [{ id: '1', name: 'Ada', email: 'ada@example.com', phone: '555' }];
const plainColumns: ColumnDef<Row, unknown>[] = [
  { id: 'name', header: () => 'Name', cell: ({ row }) => row.original.name },
  { id: 'email', header: () => 'Email', cell: ({ row }) => row.original.email },
  { id: 'phone', header: () => 'Phone', cell: ({ row }) => row.original.phone },
];
const selectColumn: ColumnDef<Row, unknown> = {
  id: 'select',
  size: 40,
  meta: { pinned: true, fixed: true },
  header: () => 'Sel',
  cell: () => 'x',
};

const sticky = (el: HTMLElement) => el.closest('td,th')!.getAttribute('style') ?? '';

describe('DataTable scrollBox', () => {
  it('pins the first column when no column is pinned, and marks the box', () => {
    const { container } = render(
      <DataTable columns={plainColumns} data={rows} scrollBox="inventory-activity" />,
    );
    expect(container.querySelector('[data-slot="table-container"]')).toHaveAttribute(
      'data-mobile-scroll-x',
      'inventory-activity',
    );
    const table = screen.getByRole('table');
    expect(sticky(within(table).getByText('Ada'))).toMatch(/position: sticky/);
    expect(sticky(within(table).getByText('Name'))).toMatch(/position: sticky/);
    expect(sticky(within(table).getByText('ada@example.com'))).not.toMatch(/sticky/);
  });

  it('pins the identifying column after a leading checkbox column, not the checkbox alone', () => {
    render(
      <DataTable columns={[selectColumn, ...plainColumns]} data={rows} scrollBox="inventory-vendors" />,
    );
    const table = screen.getByRole('table');
    expect(sticky(within(table).getByText('x'))).toMatch(/position: sticky/);
    expect(sticky(within(table).getByText('Ada'))).toMatch(/position: sticky/);
    expect(sticky(within(table).getByText('ada@example.com'))).not.toMatch(/sticky/);
  });

  it('holds the empty state in the visible part of the box, not centred across the whole table', () => {
    // Measured on staging (iPad Mini): Assets with no assets centred "No assets yet..." across a
    // 910 px table inside a 513 px box, so half of it sat out of view. The message is pinned to the
    // box's left edge and sized to the box (container query width), whatever the table's width.
    const { container } = render(
      <DataTable columns={plainColumns} data={[]} scrollBox="inventory-assets" empty={<p>Nothing yet</p>} />,
    );
    const box = container.querySelector('[data-mobile-scroll-x]')!;
    expect(box.className.split(/\s+/)).toContain('[container-type:inline-size]');
    const holder = screen.getByText('Nothing yet').parentElement!;
    expect(holder.className.split(/\s+/)).toEqual(expect.arrayContaining(['sticky', 'left-0', 'w-[100cqw]']));
  });

  it('without scrollBox leaves the empty state as it was', () => {
    const { container } = render(<DataTable columns={plainColumns} data={[]} empty={<p>Nothing yet</p>} />);
    expect(container.querySelector('[data-slot="table-container"]')!.className).not.toContain('container-type');
    expect(screen.getByText('Nothing yet').parentElement!.tagName).toBe('TD');
  });

  it('without scrollBox pins nothing it did not pin before', () => {
    const { container } = render(<DataTable columns={plainColumns} data={rows} />);
    expect(sticky(within(screen.getByRole('table')).getByText('Ada'))).not.toMatch(/sticky/);
    // Not a region of its own either: the marker below is the only thing it gained.
    const box = container.querySelector('[data-slot="table-container"]')!;
    expect(box).not.toHaveAttribute('tabindex');
    expect(box).not.toHaveAttribute('role');
  });

  // Mobile slice 75: the main record lists (leads, customers, jobs, estimates, invoices) are cards
  // below md and a table from md up. That table is wider than a tablet's box and has always scrolled
  // sideways inside it, so the gate is told it does so on purpose, under its own name.
  it('marks a DataTable that has no scrollBox as a record list', () => {
    const { container } = render(<DataTable columns={plainColumns} data={rows} />);
    expect(container.querySelector('[data-slot="table-container"]')).toHaveAttribute('data-mobile-scroll-x', 'record-list');
  });

  it('keeps its own name on a DataTable that has a scrollBox', () => {
    const { container } = render(<DataTable columns={plainColumns} data={rows} scrollBox="inventory-vendors" />);
    expect(container.querySelector('[data-slot="table-container"]')).toHaveAttribute('data-mobile-scroll-x', 'inventory-vendors');
  });
});

// Mobile slice 75 (axe scrollable-region-focusable): a table that scrolls sideways is a scroll area a
// keyboard cannot reach unless it is focusable. Any table becomes a named, focusable region while
// it overflows, and is left alone while it fits.
describe('kit Table that overflows', () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    while (restore.length) restore.pop()!();
    vi.unstubAllGlobals();
  });
  function overflowing(scrollWidth: number, clientWidth: number) {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    for (const [key, value] of [['scrollWidth', scrollWidth], ['clientWidth', clientWidth]] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
      restore.push(() => {
        if (original) Object.defineProperty(HTMLElement.prototype, key, original);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      });
    }
  }

  it('is a focusable named region while its content is wider than its box', () => {
    overflowing(900, 600);
    const { container } = kitTable();
    const box = container.querySelector('[data-slot="table-container"]')!;
    expect(box).toHaveAttribute('tabindex', '0');
    expect(box).toHaveAttribute('role', 'region');
    expect(box).toHaveAttribute('aria-label', 'Scrollable table');
  });

  it('adds no tab stop while it fits', () => {
    overflowing(600, 600);
    const { container } = kitTable();
    const box = container.querySelector('[data-slot="table-container"]')!;
    expect(box).not.toHaveAttribute('tabindex');
    expect(box).not.toHaveAttribute('role');
  });
});

// The legacy data Table's scrollBox case lives in
// src/components/data/__tests__/table-scrollBox.test.tsx: the kit may not import the app.
