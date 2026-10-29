/**
 * repro-2045.test.ts — failing reproduction for #2045.
 *
 * "Upload a line-item image from the estimate: fill the catalog item's missing image, per-line
 * photos for ad-hoc lines" (Sales-Role QA row 002, Ran's decision 2026-09-10).
 *
 * The acceptance criteria call for a NARROW endpoint — `POST /api/price-book/items/:id/image` —
 * that lets a requester who holds `update Estimate` but NOT `update PriceBook` (SALES) fill an
 * image-less catalog item's picture from an estimate line, and refuses (403) the same call when
 * the item already has an image (replacing an existing image stays an `update PriceBook` action).
 * Confirmed on prod (handoffs/reproduce-a.md §1/§4): this route does not exist at all today — it
 * 404s — and SALES gets a flat 403 on the general `PATCH /api/price-book/items/:id` route.
 *
 * This file once carried a THIRD case, a CONTROL over the existing
 * `POST /api/estimates/:id/line-items/:lineItemId/photos` route (R5f, 2026-07-22). #2029 retired
 * that route, its handlers and the `EstimateLineItemPhoto` model outright (Ran, directly: a line
 * item's image is an attribute of the stock/price-book item, and that is all), so the control has
 * nothing left to hold green. `line-item-photos-retired.test.ts` now pins its absence instead.
 * The narrow fill-if-empty endpoint below is unaffected — it writes `PriceBookItem.image_url`,
 * never a per-line photo.
 *
 * Harness: supertest against app, prisma + supabase mocked (setup.ts) — same conventions as
 * estimate-photos.test.ts / price-book.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, mockScopedFindFirst, TEST_USERS, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  priceBookItem: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

// setup.ts's storage.from is a mockReturnValue of ONE shared object — grab the handle (same
// pattern as estimate-photos.test.ts).
const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  createSignedUrls: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = 'f0000000-0000-0000-0000-000000002045';
const LINE_LINKED_NO_IMAGE_ID = 'aa000000-0000-0000-0000-000000002045';
const LINE_ADHOC_ID = 'aa000000-0000-0000-0000-000000002046';
const ITEM_NO_IMAGE_ID = '7f000000-0000-0000-0000-000000002045';
const ITEM_WITH_IMAGE_ID = '7f000000-0000-0000-0000-000000002046';

function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}

function linkedLine() {
  return {
    id: LINE_LINKED_NO_IMAGE_ID,
    estimate_id: ESTIMATE_ID,
    sequence: 1,
    description: 'qa-2045 AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: ITEM_NO_IMAGE_ID,
  };
}

function adhocLine() {
  return {
    id: LINE_ADHOC_ID,
    estimate_id: ESTIMATE_ID,
    sequence: 2,
    description: 'qa-2045 custom labor',
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
  };
}

// estimate-lines.controller's loadGuardedEstimate select shape (same shape estimate-photos.test.ts
// uses) — status defaults DRAFT (editable, unlocked) so the guard is inert unless a test opts in.
function guardRow() {
  return {
    id: ESTIMATE_ID,
    status: 'DRAFT',
    version: 1,
    tax_rate: 0.1,
    discount_type: null,
    discount_value: null,
    subtotal: 1200,
    tax_amount: 120,
    total_amount: 1320,
    discount_amount: 0,
    scopes: [],
    organization: { lock_on_send: false },
    invoices: [],
    line_items: [linkedLine(), adhocLine()],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // SALES: holds `update Estimate` unconditionally, and only `read PriceBook` — NOT
  // `update PriceBook` (defaultGrants.ts). This is the exact requester the issue's narrow
  // fill-if-empty endpoint exists for.
  mockAuthAs('sales');
  mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());
  // loadGuardedEstimate's canAccessRow derives its per-instance scope from the `read Estimate`
  // grant (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR — CONDITIONAL for SALES, unlike the unconditional
  // `update Estimate` route-level canDo), and runs a SEPARATE prisma.estimate.findFirst to
  // evaluate it. A leadless estimate created by this SALES user matches the "OR created_by me"
  // branch.
  mockScopedFindFirst(mockPrisma.estimate.findFirst, {
    id: ESTIMATE_ID,
    organization_id: ALPHA_ORG_ID,
    lead_id: null,
    created_by: TEST_USERS.sales.id,
  });
});

// ═══ The narrow "fill if empty" endpoint the issue asks for — does not exist yet ═══════════════

describe('#2045 — POST /api/price-book/items/:id/image (narrow fill-if-empty endpoint)', () => {
  it('SALES (update Estimate, no update PriceBook) fills an image-less item they may edit via the estimate: expect 200/201 and image_url set (today: 404, route missing)', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue({
      id: ITEM_NO_IMAGE_ID,
      image_url: null,
      photo_url: null,
      organization_id: ALPHA_ORG_ID,
    });
    mockPrisma.priceBookItem.update.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: ITEM_NO_IMAGE_ID, image_url: null, photo_url: null, ...args.data }),
    );

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_NO_IMAGE_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'catalog.jpg', contentType: 'image/jpeg' });

    // FAILS TODAY: the route does not exist, so this 404s ({"error":"Not found"}) instead of
    // 200/201 — see handoffs/reproduce-a.md §4.
    expect([200, 201]).toContain(res.status);
    expect(mockPrisma.priceBookItem.update).toHaveBeenCalled();
    const data = mockPrisma.priceBookItem.update.mock.calls[0]?.[0]?.data ?? {};
    expect(data.image_url).toBeTruthy();
  });

  it('SALES calling the same endpoint on an item that ALREADY has an image is refused: expect 403, not the missing-route 404 (today: 404)', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue({
      id: ITEM_WITH_IMAGE_ID,
      image_url: 'https://cdn.example.com/qa-2045-existing.png',
      photo_url: null,
      organization_id: ALPHA_ORG_ID,
    });

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_WITH_IMAGE_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'catalog.jpg', contentType: 'image/jpeg' });

    // Asserting 403 (not merely "not 200") on purpose: a route that does not exist ALSO does not
    // return 200, so a bare "not 200" assertion would pass today for the wrong reason (setup —
    // no route — rather than the actual behaviour the issue asks for: a real 403 refusal once an
    // image is already set). Today this is 404, not 403, so the assertion below fails.
    expect(res.status).toBe(403);
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
  });
});
