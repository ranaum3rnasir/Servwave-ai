/**
 * Roles & Permissions S07.17 - the routed Price Book page is view only without the Price Book boxes, shows no cost
 * without See financial data, and offers its download only with Export price book.
 *
 * Every ability below is the grant list the switches compile to (read / create / update / delete / export on
 * PriceBook, read on Pricing), never a role name. The page is the real routed file; only the data hooks are
 * seamed with stable data (the sanctioned pattern - a pending query would re-seed the page's local mirrors forever).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { buildAbility, type AbilityRule } from '@/lib/ability';
// The REAL writer: it is what turns the row objects' keys into the header row of the file that lands on disk.
import { toCSV as realToCSV } from '@/lib/csv';

const h = vi.hoisted(() => ({
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000007017',
  BRAND_ID: 'bbbbbbb1-0000-4000-8000-0000000070b1',
  GROUP_ID: 'bbbbbbb1-0000-4000-8000-0000000070a1',
  upsertItem: vi.fn(async (p: Record<string, unknown>) => ({ id: 'bbbbbbb1-0000-4000-8000-000000007099', ...p })),
  upsertItemGroup: vi.fn(),
  upsertBrand: vi.fn(),
  toCSV: vi.fn(),
  downloadCSV: vi.fn(),
}));

vi.mock('@/lib/inventory/csv', () => ({ toCSV: h.toCSV, downloadCSV: h.downloadCSV }));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable = <T,>(data: T) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  const items = [
    {
      id: h.ITEM_ID,
      sku: 'PB-7017',
      name: 'Costed hinge',
      category: 'Hinges',
      trade: 'general',
      kind: 'material',
      type: 'MATERIAL',
      uom: 'EA',
      unitCost: 40,
      sellPrice: 178,
      serialized: false,
      hazmat: false,
      trackInventory: false,
      taxable: true,
      status: 'active',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ];
  const brands = [{ id: h.BRAND_ID, name: 'Acme Locks', isActive: true, defaultMarkupPct: 1.4 }];
  const groups = [
    {
      id: h.GROUP_ID,
      name: 'Rekey Bundle',
      groupType: 'individual' as const,
      isActive: true,
      lines: [{ id: 'ln_1', itemId: h.ITEM_ID, name: 'Costed hinge', quantity: 1 }],
    },
  ];
  const categories = [{ id: 'bbbbbbb1-0000-4000-8000-0000000070c1', name: 'Hinges' }];
  return {
    ...actual,
    usePriceBookItems: stable(items),
    useBrands: stable(brands),
    useItemGroups: stable(groups),
    useCategories: stable(categories),
    useVendors: stable([]),
    useLocations: stable([]),
    useFinishes: stable([]),
    useUpsertItem: () => ({ mutate: vi.fn(), mutateAsync: h.upsertItem, isPending: false }),
    useUpsertBrand: () => ({ mutate: h.upsertBrand, mutateAsync: vi.fn(), isPending: false }),
    useUpsertItemGroup: () => ({ mutate: h.upsertItemGroup, mutateAsync: vi.fn(), isPending: false }),
    useUpsertCategory: mutation,
    useUpsertVendor: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
    useSetThresholds: mutation,
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const VIEW: AbilityRule = { action: 'read', subject: 'PriceBook' };
const CREATE: AbilityRule = { action: 'create', subject: 'PriceBook' };
const EDIT: AbilityRule = { action: 'update', subject: 'PriceBook' };
const DELETE: AbilityRule = { action: 'delete', subject: 'PriceBook' };
const EXPORT: AbilityRule = { action: 'export', subject: 'PriceBook' };
const FINANCIAL: AbilityRule = { action: 'read', subject: 'Pricing' };

function renderPage(...rules: AbilityRule[]) {
  return renderWithProviders(<PriceBookPage />, {
    initialEntries: ['/inventory/price-book'],
    ability: buildAbility(rules),
  });
}

async function openTab(name: RegExp, expectedText: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
  expect(await screen.findByText(expectedText)).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.toCSV.mockImplementation((rows: Record<string, unknown>[]) => realToCSV(rows));
});

describe('S07.17 - the Price Book controls follow the Price Book boxes', () => {
  it('shows no add, edit, delete or category control on any tab to a person who only holds View price book', async () => {
    renderPage(VIEW);
    await screen.findByText('Costed hinge');
    expect(screen.queryByRole('button', { name: /add item/i })).not.toBeInTheDocument();

    await openTab(/brands/i, 'Acme Locks');
    expect(screen.queryByRole('button', { name: /add brand/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit acme locks/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete acme locks/i })).not.toBeInTheDocument();

    await openTab(/groups/i, 'Rekey Bundle');
    expect(screen.queryByRole('button', { name: /new bundle/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit rekey bundle/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete rekey bundle/i })).not.toBeInTheDocument();

    await openTab(/categories/i, 'Hinges');
    expect(screen.queryByRole('button', { name: /^add category$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit hinges/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete hinges/i })).not.toBeInTheDocument();
  });

  it('gives each box its own controls: Create the adds, Edit the category pencil, Delete the trash cans', async () => {
    const { unmount } = renderPage(VIEW, CREATE);
    await screen.findByText('Costed hinge');
    expect(screen.getByRole('button', { name: /add item/i })).toBeInTheDocument();
    await openTab(/brands/i, 'Acme Locks');
    expect(screen.getByRole('button', { name: /add brand/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete acme locks/i })).not.toBeInTheDocument();
    unmount();

    const second = renderPage(VIEW, EDIT);
    await screen.findByText('Costed hinge');
    expect(screen.queryByRole('button', { name: /add item/i })).not.toBeInTheDocument();
    await openTab(/categories/i, 'Hinges');
    expect(screen.getByRole('button', { name: /edit hinges/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete hinges/i })).not.toBeInTheDocument();
    second.unmount();

    renderPage(VIEW, DELETE);
    await screen.findByText('Costed hinge');
    await openTab(/brands/i, 'Acme Locks');
    expect(screen.getByRole('button', { name: /delete acme locks/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add brand/i })).not.toBeInTheDocument();
  });
});

describe('S07.17 - the Items grid Visibility cell follows the Edit box', () => {
  // The button's name is its badge text; the title carries the action.
  const toggle = () => screen.queryByTitle(/visible to customers|internal only/i);

  it('shows the Visibility value as plain text, with no toggle button, to a person who only holds View price book', async () => {
    renderPage(VIEW);
    await screen.findByText('Costed hinge');
    expect(toggle()).not.toBeInTheDocument();
    // The value is still shown, in the item's own row.
    const row = screen.getByText('Costed hinge').closest('tr') as HTMLElement;
    expect(within(row).getByText('Catalog')).toBeInTheDocument();
  });

  it('keeps the toggle for a person who holds Edit price book and flips the value on click', async () => {
    renderPage(VIEW, EDIT);
    await screen.findByText('Costed hinge');
    const button = toggle();
    expect(button).toBeInTheDocument();
    fireEvent.click(button!);
    const row = screen.getByText('Costed hinge').closest('tr') as HTMLElement;
    expect(await within(row).findByText('Internal')).toBeInTheDocument();
  });
});

describe('S07.17 - cost, markup and margin show only with See financial data', () => {
  it('shows a bundle card no margin, markup or profitability figure without it, and no 0% or 100% in their place', async () => {
    renderPage(VIEW);
    await screen.findByText('Costed hinge');
    await openTab(/groups/i, 'Rekey Bundle');

    expect(screen.queryByRole('group', { name: /profitability for rekey bundle/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Margin')).not.toBeInTheDocument();
    expect(screen.queryByText('Markup')).not.toBeInTheDocument();
    expect(screen.queryByText(/^(0|100)%$/)).not.toBeInTheDocument();
    // The price the customer sees stays.
    expect(screen.getByText('$178.00')).toBeInTheDocument();
  });

  it('shows the bundle card its margin and markup with it', async () => {
    renderPage(VIEW, FINANCIAL);
    await screen.findByText('Costed hinge');
    await openTab(/groups/i, 'Rekey Bundle');

    const card = screen.getByRole('group', { name: /profitability for rekey bundle/i });
    expect(within(card).getByText('Margin')).toBeInTheDocument();
    expect(within(card).getByText('78%')).toBeInTheDocument();
    expect(within(card).getByText('345%')).toBeInTheDocument();
  });

  it("hides a brand's default markup without it and shows it with it", async () => {
    const { unmount } = renderPage(VIEW);
    await screen.findByText('Costed hinge');
    await openTab(/brands/i, 'Acme Locks');
    expect(screen.queryByText(/default markup/i)).not.toBeInTheDocument();
    unmount();

    renderPage(VIEW, FINANCIAL);
    await screen.findByText('Costed hinge');
    await openTab(/brands/i, 'Acme Locks');
    expect(screen.getByText(/default markup/i)).toBeInTheDocument();
  });

  it('opens an item with its sell price but no unit cost, margin or markup without it', async () => {
    renderPage(VIEW);
    fireEvent.click((await screen.findByText('Costed hinge')).closest('tr')!);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByLabelText('Sell price in dollars')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/unit cost/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: /profitability/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Margin')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Markup')).not.toBeInTheDocument();
  });

  it('opens an item with its unit cost, margin and markup with it', async () => {
    renderPage(VIEW, FINANCIAL);
    fireEvent.click((await screen.findByText('Costed hinge')).closest('tr')!);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByLabelText(/unit cost/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: /profitability/i })).toBeInTheDocument();
  });

  it('saves an edit without a cost when the person cannot see costs, so the hidden cost is not overwritten with 0', async () => {
    renderPage(VIEW, EDIT);
    fireEvent.click((await screen.findByText('Costed hinge')).closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(h.upsertItem).toHaveBeenCalled());
    const sent = h.upsertItem.mock.calls[0]![0];
    expect(sent.id).toBe(h.ITEM_ID);
    expect(sent.sellPrice).toBe(178);
    expect(sent.unitCost).toBeUndefined();
  });

  it('saves the unit cost as typed when the person can see costs', async () => {
    renderPage(VIEW, EDIT, FINANCIAL);
    fireEvent.click((await screen.findByText('Costed hinge')).closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(h.upsertItem).toHaveBeenCalled());
    expect(h.upsertItem.mock.calls[0]![0].unitCost).toBe(40);
  });

  describe('the bundle editor', () => {
    async function openBundle(...rules: AbilityRule[]) {
      renderPage(VIEW, CREATE, ...rules);
      await screen.findByText('Costed hinge');
      await openTab(/groups/i, 'Rekey Bundle');
      fireEvent.click(screen.getByRole('button', { name: /edit rekey bundle/i }));
      return screen.findByRole('dialog');
    }

    it('has no Cost or Profitability column without See financial data', async () => {
      const dialog = await openBundle();
      expect(within(dialog).getByRole('columnheader', { name: 'Price' })).toBeInTheDocument();
      expect(within(dialog).queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('columnheader', { name: 'Profitability' })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('group', { name: /profitability for/i })).not.toBeInTheDocument();
    });

    it('has both columns with See financial data', async () => {
      const dialog = await openBundle(FINANCIAL);
      expect(within(dialog).getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument();
      expect(within(dialog).getByRole('columnheader', { name: 'Profitability' })).toBeInTheDocument();
    });

    it('adds a free-form line with no cost of 0 when the person cannot see costs', async () => {
      const dialog = await openBundle();
      fireEvent.click(within(dialog).getByRole('button', { name: /free-form line/i }));
      fireEvent.change(within(dialog).getByPlaceholderText('Free-form line name…'), { target: { value: 'Travel fee' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

      expect(h.upsertItemGroup).toHaveBeenCalled();
      const lines = h.upsertItemGroup.mock.calls[0]![0].lines as Array<{ name: string; costOverride?: number }>;
      expect(lines.find((l) => l.name === 'Travel fee')!.costOverride).toBeUndefined();
    });
  });

  describe('the brand editor', () => {
    async function openBrand(...rules: AbilityRule[]) {
      renderPage(VIEW, CREATE, ...rules);
      await screen.findByText('Costed hinge');
      await openTab(/brands/i, 'Acme Locks');
      fireEvent.click(screen.getByRole('button', { name: /edit acme locks/i }));
      return screen.findByRole('dialog');
    }

    it('has no Default Markup field without See financial data, and saving leaves the stored markup as it was', async () => {
      const dialog = await openBrand();
      expect(within(dialog).queryByText('Default Markup')).not.toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(h.upsertBrand).toHaveBeenCalled());
      expect(h.upsertBrand.mock.calls[0]![0].defaultMarkupPct).toBe(1.4);
    });

    it('has the Default Markup field with See financial data', async () => {
      const dialog = await openBrand(FINANCIAL);
      expect(within(dialog).getByText('Default Markup')).toBeInTheDocument();
    });
  });

  it('puts no cost, margin or markup column in the download, with or without See financial data', async () => {
    for (const rules of [[VIEW, EXPORT], [VIEW, EXPORT, FINANCIAL]]) {
      h.downloadCSV.mockClear();
      const { unmount } = renderPage(...rules);
      await screen.findByText('Costed hinge');
      await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
      await waitFor(() => expect(h.downloadCSV).toHaveBeenCalled());

      const header = (h.downloadCSV.mock.calls[0]![0] as string).split('\r\n')[0]!;
      expect(header).not.toMatch(/cost|margin|markup/i);
      unmount();
    }
  });
});

describe('S07.17 - the download follows Export price book', () => {
  it('shows no Export button without it', async () => {
    renderPage(VIEW, CREATE, EDIT, DELETE, FINANCIAL);
    await screen.findByText('Costed hinge');
    expect(screen.queryByRole('button', { name: /^export$/i })).not.toBeInTheDocument();
  });

  it('shows the Export button with it, and it downloads the price book file', async () => {
    renderPage(VIEW, EXPORT);
    await screen.findByText('Costed hinge');
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));

    await waitFor(() => expect(h.downloadCSV).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^price-book-\d{4}-\d{2}-\d{2}\.csv$/)));
  });
});

describe('S07.17 - the item form offers catalog changes only with the box that allows them', () => {
  async function optionsOf(ariaLabel: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: ariaLabel }));
    const labels = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    await user.keyboard('{Escape}');
    return labels;
  }

  async function openItem(...rules: AbilityRule[]) {
    renderPage(VIEW, ...rules);
    fireEvent.click((await screen.findByText('Costed hinge')).closest('tr')!);
    await screen.findByRole('dialog');
  }

  it('offers no "+ Add" and no "Manage" entry on category, brand or finish to a person who can only edit', async () => {
    await openItem(EDIT);
    for (const field of ['Category', 'Brand', 'Finish']) {
      const labels = await optionsOf(field);
      expect(labels.some((l) => /add/i.test(l) && l.includes('+')), `${field} add`).toBe(false);
      expect(labels.some((l) => /manage/i.test(l)), `${field} manage`).toBe(false);
    }
  });

  it('offers "+ Add" with Create price book items and "Manage" with Delete price book items', async () => {
    await openItem(EDIT, CREATE, DELETE);
    for (const field of ['Category', 'Brand', 'Finish']) {
      const labels = await optionsOf(field);
      expect(labels.some((l) => /^\+ Add/i.test(l)), `${field} add`).toBe(true);
      expect(labels.some((l) => /^Manage/i.test(l)), `${field} manage`).toBe(true);
    }
  });

  it('offers only "+ Add" with Create alone', async () => {
    await openItem(EDIT, CREATE);
    const labels = await optionsOf('Brand');
    expect(labels.some((l) => /^\+ Add/i.test(l))).toBe(true);
    expect(labels.some((l) => /^Manage/i.test(l))).toBe(false);
  });
});
