/**
 * The item dialog's profitability display (PRD #2186, slice 08).
 *
 * The dialog used to render a single "{margin}% GM" badge computed inline: it
 * gated on a string's truthiness (so the string "0" passed as a present cost),
 * it had no guard at all on a zero selling price (so it printed "-Infinity% GM"
 * and "NaN% GM"), and "GM" is an abbreviation nothing on screen defines.
 *
 * It now consumes the shared profitability calculator and shows margin and
 * markup side by side under their full words.
 *
 * Seam hooks mocked with the sanctioned stable-data pattern (see
 * AddItemDialogSubtitle.test.tsx).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { AddItemDialog } from '../AddItemDialog';
import type { Item } from '@/lib/api/inventory';
import { buildAbility } from '@/lib/ability';

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useLocations: stable([
      { id: 'loc_1', name: 'Main Warehouse', type: 'warehouse', branchId: 'br_1' },
    ]),
    useBranches: stable([{ id: 'br_1', name: 'HQ' }]),
    useFinishes: stable([]),
    useUpsertFinish: mutation,
    useUpsertBrand: mutation,
    useUpsertLocation: mutation,
    useUpsertBranch: mutation,
    useDeleteFinish: mutation,
    useDeleteBrand: mutation,
    useDeleteCategory: mutation,
  };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { default_inventory_location_id: 'loc_1' }, isLoading: false }),
}));

function itemWith(unitCost: number | undefined, sellPrice: number): Item {
  return {
    id: 'itm_1',
    sku: 'LOCK-1',
    name: 'Lock',
    category: 'Locks',
    trade: 'locksmith' as Item['trade'],
    kind: 'material' as Item['kind'],
    uom: 'EA',
    unitCost,
    sellPrice,
    serialized: false,
    hazmat: false,
    status: 'active' as const,
    vendor: '',
    stock: [],
    updatedAt: '2026-01-01',
  };
}

/** "See financial data" — the same gate every sibling cost editor reads. */
const pricingAbility = () => buildAbility([{ action: 'read', subject: 'Pricing' }]);

function renderDialog(
  unitCost: number | undefined,
  sellPrice: number,
  { canSeePricing = true } = {},
) {
  renderWithProviders(
    <AddItemDialog
      open
      onClose={vi.fn()}
      onSave={vi.fn()}
      vendors={[]}
      onAddVendor={vi.fn()}
      categories={[]}
      onAddCategory={vi.fn()}
      brands={[]}
      editItem={itemWith(unitCost, sellPrice)}
    />,
    // No ability at all is the deny-everything posture, which is what a viewer
    // without "See financial data" gets.
    canSeePricing ? { ability: pricingAbility() } : undefined,
  );
}

/** The margin / markup pair, addressed the way an operator reads it. */
function profitability() {
  return screen.getByRole('group', { name: /profitability/i });
}

function figureUnder(word: string) {
  const term = within(profitability()).getByText(word);
  const value = term.parentElement?.querySelector('dd');
  return value?.textContent ?? '';
}

describe('AddItemDialog — margin and markup side by side', () => {
  it('shows margin and markup under their full words, and never says "GM"', () => {
    renderDialog(40, 178);

    // (178 - 40) / 178 = 77.5% -> 78%. (178 - 40) / 40 = 345%.
    expect(figureUnder('Margin')).toBe('78%');
    expect(figureUnder('Markup')).toBe('345%');
    expect(screen.queryByText(/GM/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/gross margin/i)).not.toBeInTheDocument();
  });

  it('renders neither Infinity nor NaN when the selling price is zero', () => {
    renderDialog(40, 0);

    expect(document.body.textContent).not.toMatch(/Infinity|NaN/);
  });

  it('shows an em dash for an uncosted item, and invites the operator to add a cost', () => {
    renderDialog(undefined, 178);

    expect(figureUnder('Margin')).toBe('\u2014');
    expect(figureUnder('Markup')).toBe('\u2014');
    // Not a dead end: the block itself says what would fill the dashes in.
    expect(within(profitability()).getByText(/add a unit cost/i)).toBeInTheDocument();
  });

  it('shows a viewer who cannot see pricing no cost, margin or markup at all, and nothing in their place', () => {
    renderDialog(undefined, 178, { canSeePricing: false });

    // Not a dash and not an invitation into a cost field they may not read: the whole block is absent.
    expect(screen.queryByRole('group', { name: /profitability/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/unit cost/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/margin|markup/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/add a unit cost/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/add a unit cost/i)).not.toBeInTheDocument();
  });

  it('shows a real figure with a VISIBLE qualifier when the cost is entered as zero', () => {
    renderDialog(0, 100);

    expect(figureUnder('Margin')).toBe('100%');
    expect(figureUnder('Margin')).not.toBe('\u2014');
    // Visible, not hover-only: the group already has an accessible name, so a
    // title attribute alone would never be announced.
    expect(within(profitability()).getByText(/entered as zero/i)).toBeInTheDocument();
    expect(profitability().getAttribute('title')).toMatch(/zero/i);
  });

  it('does not colour a zero-cost 100% as a healthy margin', () => {
    renderDialog(0, 100);

    const value = within(profitability()).getByText('Margin').parentElement?.querySelector('dd');
    expect(value?.className).not.toMatch(/text-success/);
  });

  it('calls a negative cost a bad value, and does not tell the operator to add one', () => {
    renderDialog(-5, 100);

    // -5 is sitting in the Unit Cost field beside this - "add a unit cost"
    // would be nonsense.
    expect(figureUnder('Margin')).toBe('\u2014');
    expect(figureUnder('Markup')).toBe('\u2014');
    expect(screen.queryByText(/add a unit cost/i)).not.toBeInTheDocument();
    expect(within(profitability()).getByText(/not a usable amount/i)).toBeInTheDocument();
  });

  it('reports a cost above the price as a loss rather than suppressing it', () => {
    renderDialog(150, 100);

    expect(figureUnder('Margin')).toBe('-50%');
    expect(figureUnder('Markup')).toBe('-33%');
  });
});
