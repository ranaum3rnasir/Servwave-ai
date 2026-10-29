/**
 * The inventory Filter on the shared list filter (mobile slice 64).
 *
 * RED before the change: inventory had its own 560 px popover (four columns in a fixed-width
 * panel, no phone layout). It now goes through the shared filter. The model is the legacy one
 * (`Filters`), so this pins the translation to and from the shared facets and that what the
 * filter does not edit - the category selector's names, and the trades nothing writes - still
 * counts in the button and is still cleared by Clear all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEffect, useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { emptyFilters, type Filters } from '@/lib/inventory/filters';
import type { Vendor } from '@/lib/api/inventory';

import { applyFilterState, InventoryFilterPopover, toFilterState } from '../components/inventoryFilter';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const VENDORS = [{ id: 'v1', name: 'Hingeco' }, { id: 'v2', name: 'Boltworks' }] as unknown as Vendor[];

const original = { w: window.innerWidth, h: window.innerHeight };
const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
};

let latest: Filters = emptyFilters;

function Harness({ initial = emptyFilters, vendors = VENDORS }: { initial?: Filters; vendors?: Vendor[] }) {
  const [filters, setFilters] = useState<Filters>(initial);
  useEffect(() => { latest = filters; }, [filters]);
  return (
    <InventoryFilterPopover filters={filters} onChange={setFilters} vendors={vendors} resultCount={3} totalCount={9} />
  );
}

const filterButton = () => screen.getByRole('button', { name: /^Filter/ });

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  latest = emptyFilters;
});
afterEach(() => setViewport(original.w, original.h));

describe('the model translation', () => {
  it('writes the four sections and keeps what the filter does not edit', () => {
    const prev: Filters = { ...emptyFilters, categories: ['Hardware'], trades: ['plumbing' as Filters['trades'][number]] };
    const next = applyFilterState(prev, {
      kinds: { kind: 'multi', values: ['material'] },
      vendors: { kind: 'multi', values: ['Hingeco'] },
    });
    expect(next).toEqual({ ...prev, kinds: ['material'], vendors: ['Hingeco'], stockStates: [], flags: [] });
  });

  it('reads only a section with something picked', () => {
    expect(toFilterState({ ...emptyFilters, stockStates: ['low_stock'], categories: ['Hardware'] })).toEqual({
      stockStates: { kind: 'multi', values: ['low_stock'] },
    });
  });
});

describe('the inventory Filter at desktop width', () => {
  beforeEach(() => setViewport(1280, 720));

  it('keeps its four sections and the "Showing x of y" line, and a pick applies as you click', async () => {
    render(<Harness />);
    await userEvent.click(filterButton());

    const tabs = within(await screen.findByRole('tablist', { name: 'Filter facets' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Item Kind', 'Stock Status', 'Vendor', 'Flags']);
    expect(screen.getByText('Showing 3 of 9 items')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Material' }));
    expect(latest.kinds).toEqual(['material']);
    await userEvent.click(screen.getByRole('tab', { name: 'Stock Status' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Low stock' }));
    expect(latest.stockStates).toEqual(['low_stock']);
    expect(within(filterButton()).getByText('2')).toBeInTheDocument();
  });

  it('offers no Vendor section until there are vendors', async () => {
    render(<Harness vendors={[]} />);
    await userEvent.click(filterButton());
    const tabs = within(await screen.findByRole('tablist', { name: 'Filter facets' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Item Kind', 'Stock Status', 'Flags']);
  });

  it('counts the category selection in the button and clears it with Clear all, as before', async () => {
    render(<Harness initial={{ ...emptyFilters, categories: ['Hardware'], kinds: ['service'] }} />);
    expect(within(filterButton()).getByText('2')).toBeInTheDocument();

    await userEvent.click(filterButton());
    await userEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    expect(latest).toEqual(emptyFilters);
  });

  it('offers Clear all for a category selection alone', async () => {
    render(<Harness initial={{ ...emptyFilters, categories: ['Hardware'] }} />);
    await userEvent.click(filterButton());
    await userEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    expect(latest.categories).toEqual([]);
  });
});

describe('the inventory Filter on a phone', () => {
  beforeEach(() => setViewport(320, 568));

  it('is a bottom sheet, and a pick reaches the list only on Apply', async () => {
    render(<Harness initial={{ ...emptyFilters, categories: ['Hardware'] }} />);
    await userEvent.click(filterButton());

    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(screen.queryByRole('tablist', { name: 'Filter facets' })).not.toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole('button', { name: /^Flags/ }));
    await userEvent.click(within(sheet).getByRole('checkbox', { name: 'Hazmat' }));
    expect(latest.flags).toEqual([]);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(latest.flags).toEqual(['hazmat']);
    // The category selector's choice rode through the Apply untouched.
    expect(latest.categories).toEqual(['Hardware']);
  });

  it('Clear then Apply clears the category selection too', async () => {
    render(<Harness initial={{ ...emptyFilters, categories: ['Hardware'], flags: ['hazmat'] }} />);
    await userEvent.click(filterButton());
    const sheet = await screen.findByRole('dialog');

    await userEvent.click(within(sheet).getByRole('button', { name: 'Clear' }));
    expect(latest.flags).toEqual(['hazmat']); // still a draft
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(latest).toEqual(emptyFilters);
  });
});
