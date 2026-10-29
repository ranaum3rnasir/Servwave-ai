/**
 * REPRODUCTION for issue #1991 — "Markup % is capped at 100", CLIENT half.
 *
 * The backend bound (repro-1991.test.ts) is only one of the two gates a user meets. The shared
 * line-item dialog refused a large markup BEFORE any request was sent, so on the reported flow
 * the Network tab showed no 400 at all — just an inline error naming the range.
 *
 * That one `validatePricingFields` serves BOTH the new-item form and the edit form, and the
 * dialog is shared by all three surfaces (Job LineItemsEditor, Invoice InvoiceLineItemsEditor,
 * Estimate EstimateLineItemsEditor), so exercising it through the Job editor covers the rule
 * for every surface.
 *
 * Ran settled the product question on 2026-09-18: markup is NOT capped. The inline refusal and
 * the derivation's clamp both come out, and the copy that named the old range goes with them.
 * This file asserts the UNCAPPED behaviour. The negative-markup guardrail must survive and is
 * asserted here too.
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

describe('the shared line dialog does not cap markup', () => {
  for (const markup of [108, 1000, 100000, 100001, 5_000_000]) {
    it(`edit form saves markup_percent ${markup} instead of blocking the submit`, async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      await userEvent.type(dialog.getByLabelText(/markup/i), String(markup));
      await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

      // Checked FIRST so the failure prints the blocking message the user sees
      // (AddLineDialog.tsx:222) rather than a DOM dump from the timed-out waitFor below.
      expect(dialog.queryByText(/^Markup % must be/)?.textContent ?? null).toBeNull();
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

    expect(dialog.queryByText(/^Markup % must be/)?.textContent ?? null).toBeNull();
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        `/api/jobs/${JOB_ID}/line-items`,
        expect.objectContaining({ markup_percent: 108 }),
      );
    });
  });

  // Guardrail uncapping must NOT relax — the wording changes with the bound, the block does not.
  it('still blocks a negative markup_percent before any request', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

    const dialog = within(screen.getByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/markup/i), '-1');
    await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

    expect(await dialog.findByText(/^Markup % must be/)).toBeInTheDocument();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  // The copy that named the old range has to be GONE, not widened. A message that still reads
  // "between 0 and <some bigger number>" would satisfy every other test in this file.
  it('no longer offers a range in the markup error copy', async () => {
    renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });

    await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

    const dialog = within(screen.getByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/markup/i), '-1');
    await userEvent.click(dialog.getByRole('button', { name: /save changes/i }));

    const message = (await dialog.findByText(/^Markup % must be/)).textContent ?? '';
    expect(message).not.toMatch(/between/i);
    expect(message).not.toMatch(/100,?000/);
  });
});

/**
 * The markup readout in the live strip, as a NUMBER, read back out of whatever the strip rendered.
 *
 * Deliberately NOT an equality check against a rendered string. This cluster's percentage
 * rendering is `formatProfitabilityPercent` (slice 08), which groups digits, so the same markup
 * reads "1,499,900%" there and "1499900%" on a branch that predates it. Pinning either literal
 * makes this test a hostage to which branch it is standing on.
 *
 * It also keeps the negative assertion honest. `queryByText('Markup 100000%')` was vacuous the
 * moment the ungrouped form stopped being producible: it looked for a string nothing could ever
 * render and passed for that reason, not because the clamp was gone. Reading the rendered NUMBER
 * cannot go vacuous that way — a clamped 100000 fails it under either rendering.
 */
function renderedMarkupPercent(dialog: ReturnType<typeof within>): number {
  // Reads the markup figure out of the profitability pair, as a NUMBER, so this helper is
  // indifferent to how the figure is formatted or marked up.
  //
  // It has now been wrong twice, in opposite directions, and both times only on a merged
  // tree. The markup readout was once a single `Markup {n}%` span; the profitability sweep
  // split it into a <dt>Markup</dt>/<dd> pair, and the shared formatter added digit
  // grouping. A matcher tied to either shape passes on one branch and fails on the other.
  // Match the labelled pair and parse the digits — not the text, not the punctuation.
  const pair = dialog.getByRole('group', { name: /profitability/i });
  const readout = within(pair).getByText('Markup').parentElement?.querySelector('dd');
  return Number((readout?.textContent ?? '').replace(/[^\d]/g, ''));
}

// ── The client half of the round trip: stored -> read back -> rendered ────────────────────────
// The write half (a 5,000,000 markup surviving Prisma's create and a fresh read on real Postgres)
// is proven against the migrated schema. This is the other end: a markup far above the retired
// ceiling has to come back out of the API and render, both as the field value the operator sees
// and in the live profitability strip, with the line total still correct.
describe('a markup far above the retired ceiling is read back and rendered', () => {
  const BIG = 5_000_000;

  // Case 1 — the line STORES the big markup. This is a pin, not a red-then-green: the pre-fill
  // reads markup_percent straight through and never clamped it.
  describe('stored on the line', () => {
    const STORED: JobLineItem = { ...LINE, unit_cost: 0.01, markup_percent: BIG };

    beforeEach(() => {
      vi.spyOn(api, 'get').mockResolvedValue({ data: { lines: [STORED], billing: billingFor([STORED]) } });
    });

    it('pre-fills the Markup % field from the stored value', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });
      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));
      expect(within(screen.getByRole('dialog')).getByLabelText(/markup/i)).toHaveValue(String(BIG));
    });

    it('renders it in the live strip, with the line total unaffected by it', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });
      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      expect(renderedMarkupPercent(dialog)).toBe(BIG);
      // quantity 2 x unit_price 150 — the markup is stored alongside, it does not move the total.
      expect(dialog.getByText('$300.00')).toBeInTheDocument();
    });
  });

  // Case 2 — the line has NO stored markup and the dialog derives one from cost and price. This
  // is the path `deriveMarkupFromCost` clamped at 100000: unit_cost 0.01 against unit_price 150
  // implies ((150 - 0.01) / 0.01) * 100 = 1,499,900%, and the operator was shown 100000 instead —
  // a number that contradicted their own two inputs. Uncapping means showing what they imply.
  describe('derived from unit cost and price', () => {
    const DERIVED_FROM = ((150 - 0.01) / 0.01) * 100; // 1,499,900
    const UNCOSTED: JobLineItem = { ...LINE, unit_cost: 0.01, markup_percent: null };

    beforeEach(() => {
      vi.spyOn(api, 'get').mockResolvedValue({ data: { lines: [UNCOSTED], billing: billingFor([UNCOSTED]) } });
    });

    it('pre-fills the derived markup without clamping it', async () => {
      expect(DERIVED_FROM).toBe(1_499_900);
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });
      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));
      expect(within(screen.getByRole('dialog')).getByLabelText(/markup/i)).toHaveValue(String(DERIVED_FROM));
    });

    it('renders the derived markup in the live strip, not a clamped stand-in', async () => {
      renderWithProviders(<LineItemsEditor jobId={JOB_ID} canManage />, { ability: pricingAbility() });
      await userEvent.click(await screen.findByRole('button', { name: /edit compressor swap/i }));

      const dialog = within(screen.getByRole('dialog'));
      const shown = renderedMarkupPercent(dialog);
      expect(shown).toBe(DERIVED_FROM);
      // The clamp's own value, checked as a number so it stays meaningful under any rendering.
      expect(shown).not.toBe(100_000);
      expect(dialog.getByText('$300.00')).toBeInTheDocument();
    });
  });
});
