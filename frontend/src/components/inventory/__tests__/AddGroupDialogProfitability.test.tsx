/**
 * The item-group dialog's per-line profitability (PRD #2186, slice 09).
 *
 * The bundle lines table used to compute its own margin and hardcode `return
 * 100` for a zero-or-negative cost. That guard was written as a value, so a
 * free-form line with a price and no cost claimed 100% margin — the loudest
 * spelling of the defect this cluster exists to remove. It also showed margin
 * alone, with no markup beside it.
 *
 * It now reads the shared calculator, shows margin and markup side by side
 * under their full words, and renders an em dash where there is no figure.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { AddGroupDialog } from '../AddGroupDialog';
import { buildAbility } from '@/lib/ability';
import { impossibleOnPurpose } from '@/__tests__/support/backendSwitchCatalog';
import type { Item, ItemGroup, ItemGroupLine } from '@/lib/api/inventory';

const COSTED_ITEM_ID = 'itm_costed';

function costedItem(): Item {
  return {
    id: COSTED_ITEM_ID,
    sku: 'LOCK-1',
    name: 'Costed Lock',
    category: 'Locks',
    trade: 'locksmith' as Item['trade'],
    kind: 'material' as Item['kind'],
    uom: 'EA',
    unitCost: 40,
    sellPrice: 178,
    serialized: false,
    hazmat: false,
    status: 'active' as const,
    vendor: '',
    stock: [],
    updatedAt: '2026-01-01',
  };
}

/** "See costs" — the same gate every sibling cost editor reads. */
const pricingAbility = () => buildAbility([{ action: 'read', subject: 'Prices' }, { action: 'read', subject: 'Pricing' }]);

function renderDialog(lines: ItemGroupLine[], { canSeePricing = true, ability }: { canSeePricing?: boolean; ability?: ReturnType<typeof buildAbility> } = {}) {
  const group: ItemGroup = {
    id: 'grp_1',
    name: 'QA Bundle',
    groupType: 'individual',
    isActive: true,
    lines,
  };
  renderWithProviders(
    <AddGroupDialog
      open
      onClose={vi.fn()}
      onUpdate={vi.fn()}
      editGroup={group}
      items={[costedItem()]}
    />,
    // A viewer without "See costs" still has "See prices" here (the Price column
    // is under test); with neither, the bundle shows no price line at all
    // (priceBookBundlesWithoutPrices.test.tsx).
    { ability: ability ?? (canSeePricing ? pricingAbility() : buildAbility([{ action: 'read', subject: 'Prices' }])) },
  );
}

/** The margin / markup pair for one bundle line, addressed as an operator reads it. */
function profitability(lineName: string) {
  return screen.getByRole('group', { name: new RegExp(`profitability for ${lineName}`, 'i') });
}

function figureUnder(lineName: string, word: string) {
  const term = within(profitability(lineName)).getByText(word);
  return term.parentElement?.querySelector('dd')?.textContent ?? '';
}

describe('AddGroupDialog — per-line margin and markup', () => {
  it('shows margin and markup side by side under their full words', () => {
    renderDialog([{ id: 'ln_1', itemId: COSTED_ITEM_ID, name: 'Costed Lock', quantity: 1 }]);

    // (178 - 40) / 178 = 77.5% -> 78%. (178 - 40) / 40 = 345%.
    expect(figureUnder('Costed Lock', 'Margin')).toBe('78%');
    expect(figureUnder('Costed Lock', 'Markup')).toBe('345%');
  });

  it('shows an em dash, never 100%, for a line that was never costed', () => {
    renderDialog([{ id: 'ln_2', name: 'Travel fee', quantity: 1, priceOverride: 50 }]);

    expect(figureUnder('Travel fee', 'Margin')).toBe('—');
    expect(figureUnder('Travel fee', 'Markup')).toBe('—');
    expect(within(profitability('Travel fee')).queryByText('100%')).not.toBeInTheDocument();
  });

  it('keeps a cost entered as zero distinct from a line that was never costed', () => {
    renderDialog([
      { id: 'ln_3', name: 'Comped part', quantity: 1, priceOverride: 50, costOverride: 0 },
    ]);

    // A cost WAS entered and it is zero: the whole price is margin, and markup
    // has no base to be a percentage of.
    expect(figureUnder('Comped part', 'Margin')).toBe('100%');
    expect(figureUnder('Comped part', 'Markup')).toBe('—');
  });

  // Pre-PR review, parked item: margin and markup are worked out from the sell price, and their hint asks for one ("Enter a sell
  // price above zero"). A person who holds See costs but not See prices can neither see nor enter a sell price, so the
  // profitability column, and the hint with it, is not drawn for them; their cost column stays.
  it('shows a See-costs holder without See prices no margin, markup or sell-price hint, and keeps their cost column', () => {
    const { container } = (() => {
      renderDialog([{ id: 'ln_4', itemId: COSTED_ITEM_ID, name: 'Costed Lock', quantity: 1 }], {
        ability: impossibleOnPurpose(
          buildAbility([{ action: 'read', subject: 'Pricing' }]),
          'PENDING RAN: this case is about a See costs holder without See prices, which the catalog no longer allows (See costs needs See prices).',
        ),
      });
      return { container: document.body };
    })();

    expect(screen.queryByRole('group', { name: /profitability for costed lock/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Profitability' })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/sell price/i);
    expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument();
  });

  it('shows a viewer without pricing access no cost, margin or markup at all', () => {
    renderDialog([{ id: 'ln_2', name: 'Travel fee', quantity: 1, priceOverride: 50 }], {
      canSeePricing: false,
    });

    expect(screen.queryByRole('group', { name: /profitability for travel fee/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Profitability' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Price' })).toBeInTheDocument();
  });
});
