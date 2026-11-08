/**
 * #2045 round 2 — local UI acceptance found the "+" upload affordance never rendering on a real
 * estimate workspace page. Root cause: `estimateDetailSelect`'s `line_items.select`
 * (`backend/src/controllers/estimate.controller.ts`) does NOT select `estimate_id` per line, even
 * though `EstimateLineItem`'s own type declares the field — confirmed live on
 * localhost:3145/GET /api/estimates/:id as the SALES fixture user: every returned line has 16
 * keys, none of them `estimate_id`. `LineItemRow`'s "+" is gated on `!!line.estimate_id` (spec
 * R10), so a REAL line from the API silently never qualified, even though every frontend fixture
 * used to test that gate (including this file's own sibling `LineItemRow.test.tsx` and the frozen
 * `repro-2045.test.tsx`) happened to set `estimate_id` by hand.
 *
 * Fix site: `EstimateLineItemsEditor.tsx`'s `toInvoiceLineShape` now stamps
 * `estimate_id: line.estimate_id ?? estimateId` using the estimate id the editor already holds —
 * chosen over widening the backend select because that select's exact `line_items.select` block
 * is where #2041/#2053 already has unmerged hunks on `staging` (adding `is_optional`/
 * `is_selected` at the identical spot), while `toInvoiceLineShape`/`estimateLinesToInvoiceShape`
 * have zero hunks there (verified via `git diff origin/main origin/staging --
 * frontend/src/components/estimates/EstimateLineItemsEditor.tsx`).
 *
 * This test feeds a line shaped EXACTLY like the real API response — no `estimate_id` key at
 * all — through `EstimateLineItemsEditor` (not a hand-built `InvoiceLineItem` with the field
 * already set, which is what let the bug through before) and expects the "+" to render anyway.
 *
 * #2029 narrowed WHICH line qualifies: the "+" fills the CATALOG item's image, and the per-line
 * upload path an ad-hoc line used to fall back to is retired, so only a LINKED line is offered
 * one. The stamp this file exists to pin is unchanged — it is still what lets an API-shaped
 * linked line qualify at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { EstimateLineItemsEditor } from '@/components/estimates/EstimateLineItemsEditor';
import { buildAbility } from '@/lib/ability';
import type { EstimateLineItem } from '@/lib/api/estimates';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return {
    ...actual,
    addEstimateLine: vi.fn().mockResolvedValue({ estimate: { line_items: [] } }),
    updateEstimateLine: vi.fn().mockResolvedValue({ estimate: {} }),
    deleteEstimateLine: vi.fn().mockResolvedValue({ estimate: { line_items: [] } }),
    reorderEstimateLines: vi.fn().mockResolvedValue({ estimate: {} }),
  };
});

vi.mock('@/lib/api/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/invoices')>();
  return { ...actual, searchPriceBookItems: vi.fn().mockResolvedValue([]) };
});

const ESTIMATE_ID = 'est-2045-round2';

// Shaped exactly like a real `estimateDetailSelect` line_items row: NO `estimate_id` key at all
// (cast, not a literal `EstimateLineItem` — a real object literal satisfying that interface
// cannot omit a non-optional field, which is exactly the type/reality mismatch this bug lived in).
const API_SHAPED_ADHOC_LINE = {
  id: 'line-2045-round2-adhoc',
  sequence: 1,
  description: 'Ad hoc labor',
  quantity: 1,
  unit_price: 200,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 200,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
} as unknown as EstimateLineItem;

const API_SHAPED_LINKED_NO_IMAGE_LINE = {
  id: 'line-2045-round2-linked',
  sequence: 2,
  description: 'Linked item, no image',
  quantity: 1,
  unit_price: 500,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 500,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'MATERIAL',
  price_book_item_id: 'item-2045-round2',
  price_book_item: { image_url: null },
} as unknown as EstimateLineItem;

const adminAbility = () => buildAbility([{ action: 'update', subject: 'Estimate' }]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateLineItemsEditor — the "+" affordance survives the REAL (estimate_id-less) API shape (#2045 round 2)', () => {
  it('offers "Add image" to the LINKED line only — the ad-hoc line beside it has no catalog item to fill (#2029)', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{
          id: ESTIMATE_ID,
          line_items: [API_SHAPED_ADHOC_LINE, API_SHAPED_LINKED_NO_IMAGE_LINE],
          total_amount: 700,
        }}
        canManage
        canSeePricing={false}
        canSaveToPriceBook={false}
      />,
      { ability: adminAbility() },
    );

    // The linked row's "+" is the round-2 stamp still working: a line that arrives with no
    // `estimate_id` key qualifies anyway.
    expect(await screen.findByRole('button', { name: /add image/i })).toBeInTheDocument();
    // Exactly one, across both rows — so the ad-hoc row rendered and was offered nothing.
    expect(screen.getAllByRole('button', { name: /add image/i })).toHaveLength(1);
  });

  it('renders "Add image" for a linked, image-less line even when the API response carries no estimate_id field', async () => {
    renderWithProviders(
      <EstimateLineItemsEditor
        estimate={{ id: ESTIMATE_ID, line_items: [API_SHAPED_LINKED_NO_IMAGE_LINE], total_amount: 500 }}
        canManage
        canSeePricing={false}
        canSaveToPriceBook={false}
      />,
      { ability: adminAbility() },
    );

    expect(await screen.findByRole('button', { name: /add image/i })).toBeInTheDocument();
  });
});
