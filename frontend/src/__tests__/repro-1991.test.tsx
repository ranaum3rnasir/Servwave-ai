/**
 * REPRODUCTION for issue #1991 — "Markup % is capped at 100", CLIENT half.
 *
 * The backend cap (repro-1991.test.ts) is only one of the two gates a user meets. The shared
 * line-item dialog refuses a markup above 100 BEFORE any request is sent, so on the reported
 * flow the Network tab shows no 400 at all — just the inline error:
 *
 *   frontend/src/components/jobs/items/AddLineDialog.tsx:220-222
 *     if (newMarkup.trim() !== '' && (... || markupNum > 100)) {
 *       return 'Markup % must be between 0 and 100.';
 *
 * That one `validatePricingFields` serves BOTH the new-item form and the edit form, and the
 * dialog is shared by all three surfaces (Job LineItemsEditor, Invoice InvoiceLineItemsEditor,
 * Estimate EstimateLineItemsEditor), so exercising it through the Job editor covers the rule
 * for every surface. The live total bar already renders "Markup 108%" correctly while the save
 * is blocked — the reporter's "it's already calculated correctly".
 *
 * Asserts the FIXED behaviour (bound widened to 100000, matching the backend), so it fails on
 * the base commit at AddLineDialog.tsx:221 and passes once that bound is widened.
 * The negative-markup guardrail must survive the fix and is asserted here too.
 *
 * Harness copied from job-items-editor.test.tsx (same editor, same mocks).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LineItemsEditor } from '@/components/jobs/items/LineItemsEditor';
import { buildAbility } from '@/lib/ability';
import api from '@/lib/axios';
import type { JobLineItem, JobBilling } from '@/lib/api/jobs';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    searchPriceBookItems: vi.fn().mockResolvedValue([]),
    listPriceBookItems: vi.fn().mockResolvedValue([]),
  };
});

const hoisted = vi.hoisted(() => ({ LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001' }));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  return {
    ...actual,
    useLocations: () => ({
      data: [{ id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }],
      isLoading: false,
      isError: false,
    }),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', default_inventory_location_id: hoisted.LOC_MAIN_ID, block_negative_stock: false },
      isLoading: false,
      isError: false,
    }),
  };
});

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

const LINE: JobLineItem = {
  id: 'line-1',
  job_id: JOB_ID,
  sequence: 1,
  description: 'Compressor swap',
  quantity: 2,
  unit_price: 150,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 300,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
};

function billingFor(lines: JobLineItem[]): JobBilling {
  const total = lines.reduce((s, l) => s + Number(l.line_total), 0);
  return { total, invoiced: 0, remaining: total };
}

// Cost/markup fields are gated on read:Pricing, exactly like the backend's canSeePricing gate.
const pricingAbility = () =>
  buildAbility([
    { action: 'manage_lines', subject: 'Job' },
    { action: 'read', subject: 'Pricing' },
  ]);

let postSpy: ReturnType<typeof vi.spyOn>;
let patchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(api, 'get').mockResolvedValue({ data: { lines: [LINE], billing: billingFor([LINE]) } });
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: { line: LINE, billing: billingFor([LINE]) } });
  patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { line: LINE, billing: billingFor([LINE]) } });
  vi.spyOn(api, 'delete').mockResolvedValue({ data: { billing: { total: 0, invoiced: 0, remaining: 0 } } });
});

describe('#1991 — the shared line dialog must accept a markup above 100', () => {
  for (const markup of [108, 1000, 100000]) {
    it(`edit form saves markup_percent ${markup} instead of blocking the submit`, async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      await userEvent.type(dialog.getByLabelText(/markup/i), String(markup));
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      // Checked FIRST so the failure prints the blocking message the user sees
      // (AddLineDialog.tsx:222) rather than a DOM dump from the timed-out waitFor below.
      expect(dialog.queryByText(/^Markup % must be between 0 and/)?.textContent ?? null).toBeNull();
      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith(
          `/api/jobs/${JOB_ID}/line-items/${LINE.id}`,
          expect.objectContaining({ markup_percent: markup }),
        );
      });
    });
  }

  it('new-item form sends markup_percent 108 on add', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /^add item$/i }));

    const dialog = within(screen.getByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/search the price book/i), 'Diagnostic fee');
    await userEvent.click(await dialog.findByRole('button', { name: /^add new item: diagnostic fee$/i }));

    const priceInput = dialog.getByLabelText(/^price \(\$\)$/i);
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '100');
    await userEvent.type(dialog.getByLabelText(/markup/i), '108');
    await userEvent.click(dialog.getByRole('button', { name: /^add item$/i }));

    expect(dialog.queryByText(/^Markup % must be between 0 and/)?.textContent ?? null).toBeNull();
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        `/api/jobs/${JOB_ID}/line-items`,
        expect.objectContaining({ markup_percent: 108 }),
      );
    });
  });

  // Guardrail the fix must NOT relax — the wording may change with the new bound, the block
  // must not. Matched on the stable prefix of AddLineDialog.tsx:222.
  it('still blocks a negative markup_percent before any request', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

    const dialog = within(screen.getByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/markup/i), '-1');
    await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

    expect(await dialog.findByText(/^Markup % must be between 0 and/)).toBeInTheDocument();
    expect(patchSpy).not.toHaveBeenCalled();
  });
});
