/**
 * The Price column on the ROUTED Price Book grid.
 *
 * App.tsx builds its route table from `v2Routes()`, so `pages/v2/inventory/PriceBookPage`
 * and these columns are what an operator actually opens. Two defects are pinned here, both
 * of which make this grid disagree with the price book picker about the same row:
 *
 *   1. The cell tested the resolved answer for TRUTHINESS, so an item priced at 0 fell
 *      through to the "No price" arm. `unit_price` is `Decimal(12,2)` NOT NULL and the
 *      create schema refuses a body carrying neither price column, so no row can be
 *      unpriced — the label described an unreachable state, and the only rows that ever
 *      reached it were genuine zeros. A zero IS a price and renders as $0.00 (Ran,
 *      2026-09-18). The label is deleted from this grid rather than hidden.
 *   2. The cell preferred `listPrice` over `sellPrice`, a column precedence it invented
 *      for itself. `list_price` is the VENDOR's list price, a different concept, and
 *      `backend/src/lib/catalog/item-resolution.ts` deliberately does not fall back to it.
 *      The grid now reads the resolved answer through the one shared helper, so it cannot
 *      quote a different number than the picker for the same item.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import type { Item } from '@/lib/api/inventory';
import { PriceBookPicker, type PriceBookPickerItem } from '@/components/jobs/items/PriceBookPicker';
import * as invoicesApi from '@/lib/api/invoices';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildPriceBookColumns } from '../priceBookColumns';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

const listPriceBookItems = invoicesApi.listPriceBookItems as unknown as ReturnType<typeof vi.fn>;

/** The grid reads six of an Item's thirty-odd fields; a full literal for the rest is noise. */
function gridRow(overrides: Partial<Item>): Item {
  return {
    id: 'pb-1',
    sku: 'TUNE-1',
    name: 'AC Tune-Up',
    category: 'HVAC',
    type: 'SERVICE',
    taxable: true,
    visibility: 'catalog',
    stock: [],
    ...overrides,
  } as unknown as Item;
}

function renderGrid(item: Item) {
  const columns = buildPriceBookColumns({
    brands: [],
    finishNameById: new Map(),
    onToggleVisibility: () => {},
  });
  return render(
    <DataTable
      columns={columns as never}
      data={[item] as never}
      getRowId={(_row, index) => String(index)}
    />,
  );
}

/** The one Price cell in the grid: the row's cell under the Price column header. */
function gridPriceCell(): HTMLElement {
  const headers = screen.getAllByRole('columnheader');
  const priceIndex = headers.findIndex((th) => th.textContent?.trim().startsWith('Price'));
  expect(priceIndex).toBeGreaterThan(-1);
  const row = screen.getAllByRole('row').at(-1) as HTMLElement;
  return within(row).getAllByRole('cell')[priceIndex] as HTMLElement;
}

function pickerItem(overrides: Partial<PriceBookPickerItem>): PriceBookPickerItem {
  return {
    id: 'pb-1',
    name: 'AC Tune-Up',
    description: null,
    image_url: null,
    photoUrl: null,
    sellPrice: 0,
    type: 'SERVICE',
    unit_cost: null,
    unit_price: 0,
    taxable: true,
    category: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the Price Book grid price cell', () => {
  it('renders a genuine zero as $0.00, not as an absent price', () => {
    renderGrid(gridRow({ sellPrice: 0 }));

    const cell = gridPriceCell();
    expect(within(cell).getByText('$0.00')).toBeInTheDocument();
    expect(cell.textContent).not.toMatch(/no price/i);
  });

  it('quotes the same figure the picker quotes when the two price columns differ', async () => {
    // One catalog row, two readers. `list_price` is the vendor's list price and the shared
    // resolution never falls back to it, so the resolved selling price is what BOTH surfaces
    // must show. When the grid preferred listPrice, the same item read $99.00 here and
    // $45.00 in the picker.
    renderGrid(gridRow({ sellPrice: 45, listPrice: 99 }));
    const gridText = gridPriceCell().textContent?.trim();

    listPriceBookItems.mockResolvedValue([pickerItem({ sellPrice: 45, unit_price: 45 })]);
    renderWithProviders(
      <PriceBookPicker
        open
        onOpenChange={() => {}}
        onAdd={() => {}}
        targetLabel="job"
        onCreateAdhoc={() => {}}
      />,
    );
    const heading = await screen.findByText('AC Tune-Up', { selector: 'p' });
    const card = heading.closest('div.flex.flex-col.overflow-hidden') as HTMLElement;
    const pickerText = within(card).getByText(/^\$/).textContent?.trim();

    expect(gridText).toBe('$45.00');
    expect(gridText).toBe(pickerText);
  });
});
