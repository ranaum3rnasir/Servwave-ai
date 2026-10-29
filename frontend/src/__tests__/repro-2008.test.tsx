/**
 * Repro for #2008 — "Estimate description fields are fixed at ~3 lines and clip the text"
 * (QA 001 + 003).
 *
 * All four description textareas on the Job/Invoice/Estimate line-item and scope-of-work
 * surfaces import the LEGACY, fixed-height `Textarea` (`@/components/ui/textarea`) instead of
 * the ui-kit's auto-grow `Textarea` (`@/ui-kit/components/ui/textarea`, `[field-sizing:content]`
 * — the only auto-grow primitive in the repo). A long description is silently clipped inside a
 * ~2-3 line box with no scrollbar affordance and, on the two AddLineDialog forms, no manual
 * resize handle either (`resize-none`).
 *
 * Desired behaviour asserted per surface: the rendered textarea (a) carries the auto-grow
 * sizing marker, (b) does not pin a fixed 2-row box with resize disabled, and (c) carries a
 * growth cap so it cannot run away unbounded on a very long description.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { ScopeOfWorkCard } from '@/components/jobs/items/ScopeOfWorkCard';
import { AddLineDialog } from '@/components/jobs/items/AddLineDialog';
import type { Scope } from '@/lib/api/jobs';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { combineDescription } from '@/lib/lineItems';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return { ...actual, searchPriceBookItems: vi.fn().mockResolvedValue([]) };
});

const TEN_LINE_BODY = Array.from({ length: 10 }, (_, i) => `qa-2008 line ${i + 1}`).join('\n');

/** Auto-grow marker: the ui-kit Textarea's `[field-sizing:content]` arbitrary class — the only
 * auto-grow implementation in the repo (grep -rn "field-sizing" frontend/src, one hit). */
const AUTO_GROW_CLASS = /field-sizing:content/;
/** A growth cap the fix will pick a concrete value for (e.g. max-h-[40vh]) — assert the pattern
 * so the fix decides the exact number. */
const MAX_HEIGHT_CLASS = /max-h-/;

function assertGrowsAndCapped(textarea: HTMLElement, label: string) {
  expect(textarea.className, `${label}: description textarea carries no auto-grow sizing`).toMatch(
    AUTO_GROW_CLASS,
  );
  expect(textarea.className, `${label}: description textarea has no growth cap`).toMatch(
    MAX_HEIGHT_CLASS,
  );
}

function assertNotFixedTwoRowBox(textarea: HTMLElement, label: string) {
  const rows = textarea.getAttribute('rows');
  const isFixedTwoRows = rows !== null && Number(rows) <= 2;
  expect(
    isFixedTwoRows,
    `${label}: description textarea is a fixed 2-row box (rows="${rows}")`,
  ).toBe(false);
  expect(
    textarea.className,
    `${label}: description textarea blocks manual resize too (resize-none)`,
  ).not.toMatch(/resize-none/);
}

describe('#2008 — description textareas must auto-grow instead of clipping at ~3 lines', () => {
  it('Scope of Work saved-block editor: a 10-line description renders in an auto-growing, capped textarea', () => {
    const scope: Scope = {
      id: 'scope-1',
      title: 'Demo & haul-away',
      body: TEN_LINE_BODY,
      flat_price: 250,
      is_taxable: true,
      internal_cost: 100,
    };
    renderWithProviders(
      <ScopeOfWorkCard
        scopes={[scope]}
        canEdit
        canSeePricing
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    const textarea = screen.getByLabelText(/description for scope 1/i);
    expect(textarea).toHaveValue(TEN_LINE_BODY);
    assertGrowsAndCapped(textarea, 'Scope saved-block editor');
    assertNotFixedTwoRowBox(textarea, 'Scope saved-block editor');
  });

  it('Scope of Work "add block" form: the new-scope description textarea auto-grows instead of a fixed min-height box', async () => {
    renderWithProviders(
      <ScopeOfWorkCard
        scopes={[]}
        canEdit
        canSeePricing
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));
    const textarea = form.getByLabelText(/new scope description/i);

    assertGrowsAndCapped(textarea, 'Scope add form');
    assertNotFixedTwoRowBox(textarea, 'Scope add form');
  });

  it('AddLineDialog edit form: a 10-line description renders in an auto-growing, capped textarea, not rows=2/resize-none', () => {
    const editingLine: InvoiceLineItem = {
      id: 'line-1',
      sequence: 1,
      description: combineDescription('Labor', TEN_LINE_BODY),
      quantity: 1,
      unit_price: 225,
      is_taxable: true,
      line_total: 225,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      item_type: 'SERVICE',
      price_book_item_id: null,
    };

    renderWithProviders(
      <AddLineDialog
        open
        onOpenChange={() => {}}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        editingLine={editingLine}
        canSeePricing
      />,
    );

    const textarea = screen.getByLabelText('Description');
    expect(textarea).toHaveValue(TEN_LINE_BODY);
    assertGrowsAndCapped(textarea, 'AddLineDialog edit form');
    assertNotFixedTwoRowBox(textarea, 'AddLineDialog edit form');
  });

  it('AddLineDialog create form: the new-item description textarea auto-grows instead of a fixed rows=2/resize-none box', async () => {
    renderWithProviders(
      <AddLineDialog open onOpenChange={() => {}} onAdd={vi.fn()} initialQuery="LABOR." canSeePricing />,
    );

    const textarea = await screen.findByLabelText('Description');
    assertGrowsAndCapped(textarea, 'AddLineDialog create form');
    assertNotFixedTwoRowBox(textarea, 'AddLineDialog create form');
  });
});
