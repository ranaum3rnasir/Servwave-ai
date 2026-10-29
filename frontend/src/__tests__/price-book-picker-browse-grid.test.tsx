/**
 * price-book-picker-browse-grid.test.tsx — what an item card in the picker's browse
 * grid actually shows.
 *
 * A catalog item's image lives in one of two columns and its selling price in one of
 * two more. Browse used to hand the client both raw columns and let the card pick, and
 * the card picked the legacy one — so an item the price book lists with a photo and a
 * price browsed as a grey placeholder and a confident $0.00.
 *
 * The backend now resolves both and sends one answer each (`photoUrl` / `sellPrice`),
 * with `null` as the explicit absent state. These tests pin what the card does with
 * that: a thumbnail and a price for a populated item, and a neutral placeholder for one
 * with no image in either column.
 *
 * There is deliberately NO "unpriced" case (Ran, 2026-09-18): `unit_price` is
 * `Decimal(12,2)` NOT NULL with no default and the create schema refuses a body carrying
 * neither price column, so an unpriced item is a state no row can reach. Every item has a
 * price and $0.00 IS a price. An earlier revision of this file pinned the words "No price"
 * for that arm; the label and the tests for it are gone rather than left as dead copy.
 *
 * The picker is rendered directly rather than through one of its three host editors:
 * the browse grid is the unit under test, and its host's add-line plumbing is not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { PriceBookPicker, type PriceBookPickerItem } from '@/components/jobs/items/PriceBookPicker';
import * as invoicesApi from '@/lib/api/invoices';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

const listPriceBookItems = invoicesApi.listPriceBookItems as unknown as ReturnType<typeof vi.fn>;

const PHOTO = 'https://cdn.example.com/tune-up.png';

function item(overrides: Partial<PriceBookPickerItem>): PriceBookPickerItem {
  return {
    id: 'pb-1',
    name: 'AC Tune-Up',
    description: null,
    image_url: null,
    photoUrl: null,
    sellPrice: 0,
    type: 'SERVICE',
    unit_cost: 50,
    unit_price: 0,
    taxable: true,
    category: null,
    ...overrides,
  };
}

function renderPicker() {
  return renderWithProviders(
    <PriceBookPicker
      open
      onOpenChange={() => {}}
      onAdd={() => {}}
      targetLabel="job"
      onCreateAdhoc={() => {}}
    />,
  );
}

/** The one item card in the grid, found by the item name the fixture gave it. */
async function itemCard(name = 'AC Tune-Up') {
  const heading = await screen.findByText(name);
  // name -> card-body button -> the card itself (thumb + body + stepper).
  const card = heading.closest('div.flex.flex-col.overflow-hidden');
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PriceBookPicker browse grid — a populated item', () => {
  it('renders the resolved thumbnail and the resolved price', async () => {
    listPriceBookItems.mockResolvedValue([item({ photoUrl: PHOTO, sellPrice: 500 })]);

    renderPicker();
    const card = await itemCard();

    const img = within(card).getByRole('img');
    expect(img).toHaveAttribute('src', PHOTO);
    expect(within(card).getByText('$500.00')).toBeInTheDocument();
  });

  it('renders the thumbnail for an item whose image only reached the legacy column', async () => {
    // The backend resolved it out of the legacy column and sent the answer. The raw
    // `image_url` is deliberately left null here: the card must read the ANSWER, not
    // re-derive the column precedence for itself.
    listPriceBookItems.mockResolvedValue([
      item({ photoUrl: 'https://cdn.example.com/legacy.png', image_url: null, sellPrice: 500 }),
    ]);

    renderPicker();
    const card = await itemCard();

    expect(within(card).getByRole('img')).toHaveAttribute('src', 'https://cdn.example.com/legacy.png');
  });

  it('renders the resolved price even when the legacy price column says zero', async () => {
    // The exact defect shape: sell_price 500, unit_price 0. The card used to read unit_price.
    listPriceBookItems.mockResolvedValue([item({ sellPrice: 500, unit_price: 0 })]);

    renderPicker();
    const card = await itemCard();

    expect(within(card).getByText('$500.00')).toBeInTheDocument();
    expect(within(card).queryByText('$0.00')).not.toBeInTheDocument();
  });
});

describe('PriceBookPicker browse grid — an absent value', () => {
  // CHARACTERIZATION TEST, not a regression guard. This one cannot fail against the
  // pre-fix card: that card read the raw `image_url`, which this fixture also leaves null,
  // so the placeholder rendered either way. It is here to pin WHAT the placeholder is -
  // no <img> element at all, so it can never appear as a failed load - which is the
  // acceptance criterion about being distinguishable from a broken image. Do not read a
  // green here as evidence that the resolution is wired up; the tests above do that.
  it('renders a neutral placeholder, not a broken image, for an item with no image', async () => {
    listPriceBookItems.mockResolvedValue([item({ photoUrl: null, sellPrice: 500 })]);

    renderPicker();
    const card = await itemCard();

    // Nothing that could render as a failed load: no <img> at all, and no empty src.
    expect(within(card).queryByRole('img')).not.toBeInTheDocument();
    expect(card.querySelector('img')).toBeNull();
    // The placeholder is the dashed type-glyph tile ProductThumb draws for a src-less item.
    expect(card.querySelector('.border-dashed')).not.toBeNull();
  });
});

describe('PriceBookPicker browse grid — zero is a price', () => {
  it('renders $0.00 for a genuinely free item', async () => {
    // sellPrice 0 against a legacy column of 125 — a card reading the raw column would
    // render $125.00, so this cannot pass by accident.
    listPriceBookItems.mockResolvedValue([item({ sellPrice: 0, unit_price: 125 })]);

    renderPicker();
    const card = await itemCard();

    expect(within(card).getByText('$0.00')).toBeInTheDocument();
    expect(within(card).queryByText('$125.00')).not.toBeInTheDocument();
  });
});

describe('PriceBookPicker browse grid — the grid still browses', () => {
  it('asks the browse endpoint for the catalog when the search box is empty', async () => {
    listPriceBookItems.mockResolvedValue([item({ photoUrl: PHOTO, sellPrice: 500 })]);

    renderPicker();
    await waitFor(() => expect(listPriceBookItems).toHaveBeenCalled());
    expect(invoicesApi.searchPriceBookItems).not.toHaveBeenCalled();
  });
});
