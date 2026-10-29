import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { buildSelectColumn } from '@/pages/v2/_shared/selectColumn';

/**
 * Mobile slice 39 (TOUCH-01, A11Y-08): below md a list row is ONE named button that opens the
 * record, not a clickable div; its checkbox sits in its own row above the details, only selects,
 * and never opens the card; other controls in the card (links, the actions menu) still work.
 */

interface Row { id: string; name: string; status: string }

const data: Row[] = [
  { id: 'a', name: 'Alpha Job', status: 'Open' },
  { id: 'b', name: 'Bravo Job', status: 'Done' },
];

const columns: ColumnDef<Row, unknown>[] = [
  buildSelectColumn<Row>({ allLabel: 'Select all', rowLabel: (r) => `Select ${r.name}` }),
  { id: 'name', accessorKey: 'name', header: 'Name', cell: (c) => <a href={`/jobs/${c.row.original.id}`}>{String(c.getValue())}</a> },
  { id: 'status', accessorKey: 'status', header: 'Status', cell: (c) => String(c.getValue()) },
  { id: 'actions', header: '', cell: () => <button type="button">Row menu</button> },
];

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: true, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
});
afterEach(() => vi.restoreAllMocks());

function renderCards(onRowClick = vi.fn()) {
  const utils = render(
    <DataTable columns={columns} data={data} getRowId={(r) => r.id} onRowClick={onRowClick} mobileCards />,
  );
  return { ...utils, onRowClick };
}

describe('DataTable phone cards (mobile slice 39)', () => {
  it('gives each card one open button, named for its row', () => {
    const { onRowClick } = renderCards();
    const open = screen.getByRole('button', { name: /alpha job/i });
    fireEvent.click(open);
    expect(onRowClick).toHaveBeenCalledWith(data[0]);
    expect(screen.getAllByRole('button', { name: /job/i }).filter((b) => b.getAttribute('data-slot') === 'table-card-open')).toHaveLength(2);
  });

  it('has no click handler on the card itself', () => {
    const { container, onRowClick } = renderCards();
    fireEvent.click(container.querySelector('[data-slot="table-card"]') as HTMLElement);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('puts the checkbox in its own unlabelled row; it selects and does not open', () => {
    const { container, onRowClick } = renderCards();
    const card = container.querySelector('[data-slot="table-card"]') as HTMLElement;
    // No "Select" caption row: the checkbox is not a labelled detail.
    expect(card.querySelector('dt')?.textContent).toBe('Name');
    const box = screen.getByRole('checkbox', { name: 'Select Alpha Job' });
    fireEvent.click(box);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(card).toHaveAttribute('data-state', 'selected');
  });

  it('two selected cards stay selected together', () => {
    const { container } = renderCards();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha Job' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bravo Job' }));
    expect(container.querySelectorAll('[data-slot="table-card"][data-state="selected"]')).toHaveLength(2);
  });

  it('an action button inside the card does not open the record', () => {
    const { onRowClick } = renderCards();
    fireEvent.click(screen.getAllByRole('button', { name: 'Row menu' })[0]!);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('without onRowClick the card has no open button', () => {
    const { container } = render(
      <DataTable columns={columns} data={data} getRowId={(r) => r.id} mobileCards />,
    );
    expect(container.querySelector('[data-slot="table-card-open"]')).toBeNull();
  });
});
