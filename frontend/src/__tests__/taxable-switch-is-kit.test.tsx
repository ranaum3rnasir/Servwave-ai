/**
 * Payments W2: the Taxable switch in the line row, the scope-of-work block and the Edit line item
 * dialog is the ui-kit Switch, and toggling it still calls the same handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { renderWithProviders } from './helpers';
import { LineItemRow } from '@/components/jobs/items/LineItemRow';
import type { InvoiceLineItem } from '@/lib/api/jobs';

const LINE: InvoiceLineItem = {
  id: 'line-w2', sequence: 1, description: 'Compressor swap', quantity: 2, unit_price: 150,
  unit_cost: null, markup_percent: null, is_taxable: false, line_total: 300, discount_type: null,
  discount_value: null, discount_amount: 0, item_type: 'SERVICE', price_book_item_id: null,
};

describe('Taxable switch in the line item row', () => {
  it('renders the ui-kit Switch and calls onUpdate when toggled', async () => {
    const onUpdate = vi.fn();
    renderWithProviders(
      <DndContext><table><tbody><SortableContext items={[LINE.id]}>
        <LineItemRow line={LINE} canEdit canManage canSeePricing onUpdate={onUpdate} onDelete={vi.fn()} onEdit={vi.fn()} />
      </SortableContext></tbody></table></DndContext>,
    );
    const sw = screen.getByRole('switch', { name: /taxable for compressor swap/i });
    expect(sw.getAttribute('data-slot')).toBe('switch');
    await userEvent.click(sw);
    expect(onUpdate).toHaveBeenCalledWith({ is_taxable: true });
  });
});

describe('Taxable switch in the scope-of-work block', () => {
  it('renders the ui-kit Switch and calls onUpdate with the flipped value', async () => {
    const { ScopeOfWorkCard } = await import('@/components/jobs/items/ScopeOfWorkCard');
    const onUpdate = vi.fn();
    renderWithProviders(
      <ScopeOfWorkCard
        scopes={[{ id: 's1', title: 'Install door', body: '', flat_price: 100, is_taxable: false, internal_cost: null }]}
        canEdit
        canSeePricing
        onAdd={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    const sw = screen.getByRole('switch', { name: /taxable for scope 1/i });
    expect(sw.getAttribute('data-slot')).toBe('switch');
    await userEvent.click(sw);
    expect(onUpdate).toHaveBeenCalledWith(0, { is_taxable: true });
  });
});

describe('Taxable / Save to price book switches in the Add line item dialog', () => {
  it('render the ui-kit Switch', async () => {
    const { AddLineDialog } = await import('@/components/jobs/items/AddLineDialog');
    renderWithProviders(
      <AddLineDialog open onOpenChange={vi.fn()} onAdd={vi.fn()} onUpdate={vi.fn()} initialQuery="New line" canSaveToPriceBook />,
    );
    for (const id of ['new-taxable', 'new-save-pricebook']) {
      const sw = document.getElementById(id);
      expect(sw?.getAttribute('role')).toBe('switch');
      expect(sw?.getAttribute('data-slot')).toBe('switch');
    }
  });
});
