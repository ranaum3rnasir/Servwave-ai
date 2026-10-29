/**
 * price-book-picker-search-results.test.tsx — a search result card shows the same
 * thumbnail and the same price as the browse grid shows for the same item.
 *
 * The picker feeds one grid from two endpoints: an empty box browses
 * `/api/price-book/items`, a typed query narrows via `/api/price-book/items/search`.
 * They used to disagree, because search projected with an explicit `select` that never
 * named `photo_url` or `sell_price` — so an item whose photo and price landed in the
 * canonical columns searched as a grey placeholder and the legacy price while browsing
 * the same item was right. The backend select now names all four columns, so both
 * endpoints hand this card the same two resolved answers.
 *
 * SCOPE OF THIS FILE: it pins the CARD's behaviour on the SEARCH path — that a search
 * result renders from `photoUrl` / `sellPrice` and not from the raw columns, and that
 * the search endpoint is what fed it. It cannot go red against the backend projection
 * itself; a frontend test never sees the select. That half is proven in
 * backend/src/__tests__/price-book-picker-resolution.test.ts, whose findMany mock
 * honours the select on purpose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import {
  PriceBookPicker,
  type PriceBookPickerItem,
  type PriceBookPickerProps,
} from '@/components/jobs/items/PriceBookPicker';
import * as invoicesApi from '@/lib/api/invoices';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

const searchPriceBookItems = invoicesApi.searchPriceBookItems as unknown as ReturnType<typeof vi.fn>;
const listPriceBookItems = invoicesApi.listPriceBookItems as unknown as ReturnType<typeof vi.fn>;

const PHOTO = 'data:image/png;base64,AAA';

/**
 * A search result as the WIDENED projection now answers: the resolved `photoUrl` /
 * `sellPrice` carry the canonical columns' values, while the raw legacy columns
 * deliberately disagree. A card reading the raw columns renders the wrong image and
 * the wrong price against this fixture, so these assertions cannot pass by accident.
 */
function searchResult(overrides: Partial<PriceBookPickerItem> = {}): PriceBookPickerItem {
  return {
    id: 'pb-search-1',
    name: 'AC Tune-Up',
    description: null,
    image_url: 'https://cdn.example.com/legacy.png',
    photoUrl: PHOTO,
    sellPrice: 500,
    type: 'SERVICE',
    unit_cost: 50,
    unit_price: 125,
    taxable: true,
    category: null,
    ...overrides,
  };
}

function renderPicker(props: Partial<PriceBookPickerProps> = {}) {
  return renderWithProviders(
    <PriceBookPicker
      open
      onOpenChange={() => {}}
      onAdd={() => {}}
      targetLabel="job"
      onCreateAdhoc={() => {}}
      {...props}
    />,
  );
}

/** Type into the picker's search box and hand back the one result card. */
async function searchFor(query: string) {
  const user = userEvent.setup();
  renderPicker();

  const box = await screen.findByPlaceholderText(/search/i);
  await user.type(box, query);

  // The picker debounces the box by 300ms of real time before it queries.
  await waitFor(() => expect(searchPriceBookItems).toHaveBeenCalled(), { timeout: 3000 });

  const heading = await screen.findByText('AC Tune-Up');
  const card = heading.closest('div.flex.flex-col.overflow-hidden');
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  listPriceBookItems.mockResolvedValue([]);
});

describe('PriceBookPicker search results — a populated item', () => {
  it('renders the resolved thumbnail and the resolved price, not the raw columns', async () => {
    searchPriceBookItems.mockResolvedValue([searchResult()]);

    const card = await searchFor('tune');

    expect(within(card).getByRole('img')).toHaveAttribute('src', PHOTO);
    expect(within(card).getByText('$500.00')).toBeInTheDocument();
    // The legacy columns the fixture set to disagree must not surface.
    expect(within(card).queryByText('$125.00')).not.toBeInTheDocument();
    expect(card.querySelector('img')?.getAttribute('src')).not.toBe('https://cdn.example.com/legacy.png');
  });

  // PARITY test, deliberately weaker than the one above: it compares the two paths
  // against each other, so it stays green if BOTH regress together (reverting the card
  // to the raw columns degrades browse and search alike). It is here to pin the slice's
  // thesis - one grid, two endpoints, one answer - not to catch a card regression. The
  // test above is what does that.
  it('renders a search result identically to the same item browsed', async () => {
    // How the operator found the item must not change what it shows.
    listPriceBookItems.mockResolvedValue([searchResult()]);
    const { unmount } = renderPicker();
    const browsedHeading = await screen.findByText('AC Tune-Up');
    const browsedCard = browsedHeading.closest('div.flex.flex-col.overflow-hidden') as HTMLElement;
    const browsedImg = within(browsedCard).getByRole('img').getAttribute('src');
    const browsedPrice = within(browsedCard).getByText(/\$/).textContent;
    unmount();

    vi.clearAllMocks();
    listPriceBookItems.mockResolvedValue([]);
    searchPriceBookItems.mockResolvedValue([searchResult()]);
    const searchedCard = await searchFor('tune');

    expect(within(searchedCard).getByRole('img')).toHaveAttribute('src', browsedImg!);
    expect(within(searchedCard).getByText(/\$/).textContent).toBe(browsedPrice);
  });
});

/**
 * The grid must survive a refined search, because the operator is already pointing at it.
 *
 * Every keystroke settles into a new query key, and a brand-new key is `isLoading` until it
 * answers. The Items tab used to swap the entire grid - item cards, quantity steppers and the
 * dashed "Add new item: <query>" card - for a "Searching..." line for exactly that window. The
 * card carries the query LIVE (from the search box, not from the debounced one), so it reads
 * correct and clickable the instant typing stops, ~300ms before the debounce even fires. A click
 * that lands inside the in-flight window hits a node React is unmounting, no handler ever runs,
 * and the picker sits there looking like it ignored the operator.
 *
 * This is a load-sensitive race in a real browser and was one in the suite: the round-trip spec
 * (price-book-picker-adhoc-round-trip.test.tsx) failed intermittently on a loaded machine, in a
 * different test each run, always at "the picker should have closed by now".
 */
describe('PriceBookPicker — a refined search must not tear the grid out from under a click', () => {
  it('keeps the catalog grid and the "Add new item" card on screen while the search is in flight', async () => {
    const user = userEvent.setup();
    listPriceBookItems.mockResolvedValue([searchResult()]);
    // Held open deliberately: this is the window a slow network (or a loaded machine) gives you.
    let releaseSearch: (rows: PriceBookPickerItem[]) => void = () => {};
    searchPriceBookItems.mockImplementation(
      () => new Promise<PriceBookPickerItem[]>((resolve) => { releaseSearch = resolve; }),
    );

    renderPicker();
    await screen.findByText('AC Tune-Up');

    await user.type(await screen.findByPlaceholderText(/search/i), 'tune');
    await waitFor(() => expect(searchPriceBookItems).toHaveBeenCalled(), { timeout: 3000 });

    // Mid-flight: what the operator can see is still there, and still the same node.
    expect(screen.getByText('AC Tune-Up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add new item: tune/i })).toBeInTheDocument();

    releaseSearch([searchResult()]);
    await waitFor(() => expect(screen.getByText('AC Tune-Up')).toBeInTheDocument());
  });

  it('hands the query off when the card is clicked during that window', async () => {
    const user = userEvent.setup();
    const onCreateAdhoc = vi.fn();
    listPriceBookItems.mockResolvedValue([searchResult()]);
    let releaseSearch: (rows: PriceBookPickerItem[]) => void = () => {};
    searchPriceBookItems.mockImplementation(
      () => new Promise<PriceBookPickerItem[]>((resolve) => { releaseSearch = resolve; }),
    );

    renderPicker({ onCreateAdhoc });
    await screen.findByText('AC Tune-Up');

    await user.type(await screen.findByPlaceholderText(/search/i), 'tune');
    await waitFor(() => expect(searchPriceBookItems).toHaveBeenCalled(), { timeout: 3000 });

    await user.click(screen.getByRole('button', { name: /^add new item: tune/i }));

    expect(onCreateAdhoc).toHaveBeenCalledWith('tune');
    releaseSearch([]);
  });
});
