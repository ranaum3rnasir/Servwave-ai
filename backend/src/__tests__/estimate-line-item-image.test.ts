/**
 * The estimate detail response has to carry a catalog-linked line's item image from EITHER of
 * the item's two image columns.
 *
 * A `PriceBookItem` stores its image in one of two columns and both are legitimate — see
 * `lib/catalog/item-resolution.ts` for which one a reader resolves to. `estimateDetailSelect`
 * asked for `image_url` alone, so every image the catalog dialog wrote into `photo_url` was
 * simply not on the wire: the estimate row rendered a placeholder while the SAME item showed a
 * picture on a job line and an invoice line, whose own projections ask for both columns
 * (`job-lines.controller.ts`, `invoice.controller.ts` — deliberately left alone, they are the
 * shape this one is brought into line with).
 *
 * The assertion that matters is on the SELECT, not on the returned body: prisma is mocked, so a
 * fixture row comes back whole whether or not the query ever asked for the column (the same
 * "mocked passthrough" caveat `estimates.test.ts`'s own job_link test calls out). The body
 * assertion beside it pins that nothing downstream strips the column back off again.
 *
 * Harness: supertest against `app`, prisma fully mocked (setup.ts) — mirrors estimates.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { estimateDetailSelect } from '../controllers/estimate.controller';
import { ALPHA_ORG_ID, ESTIMATE_FIXTURE, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
};

// The catalog dialog's storage strategy: a data URI in `photo_url`, nothing in `image_url`.
// This is the case the old single-column select could not see.
const LEGACY_COLUMN_IMAGE = 'data:image/png;base64,AAAA';

function estimateWithLinkedLine(priceBookItem: Record<string, unknown> | null) {
  return {
    ...ESTIMATE_FIXTURE,
    line_items: [
      {
        id: 'e1000000-0000-0000-0000-000000000001',
        sequence: 1,
        description: 'Catalog part',
        quantity: 1,
        unit_price: 500,
        is_taxable: true,
        line_total: 500,
        price_book_item_id: 'b0000000-0000-0000-0000-000000000001',
        price_book_item: priceBookItem,
        unit_cost: null,
        markup_percent: null,
        discount_type: null,
        discount_value: null,
        discount_amount: 0,
        item_type: 'MATERIAL',
        is_optional: false,
        is_selected: true,
      },
    ],
    scopes: [],
    scope_photos: [],
  };
}

/**
 * Honours the `organization_id` in the query's own `where` — a plain `mockResolvedValue` would
 * hand the row to ANY caller and the tenancy test below would pass on a query with no tenant
 * clause at all.
 */
function mockOrgScopedEstimate(row: Record<string, unknown>, orgId = ALPHA_ORG_ID) {
  mockPrisma.estimate.findUnique.mockImplementation(
    ({ where }: { where: { id?: string; organization_id?: string } }) =>
      Promise.resolve(where?.organization_id === orgId ? row : null),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
});

describe('GET /api/estimates/:id — the line item carries the catalog item image from either column', () => {
  it('asks for BOTH image columns, matching the job-line and invoice projections', () => {
    const lineSelect = (estimateDetailSelect as unknown as {
      line_items: { select: Record<string, unknown> };
    }).line_items.select;

    expect(lineSelect.price_book_item).toEqual({
      select: expect.objectContaining({ image_url: true, photo_url: true }),
    });
  });

  it('returns the image for an item whose image lives only in the legacy column', async () => {
    mockAuthAs('admin');
    mockOrgScopedEstimate(
      estimateWithLinkedLine({ image_url: null, photo_url: LEGACY_COLUMN_IMAGE }),
    );

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The select is what decides whether this column is on the wire at all (header note).
    const select = mockPrisma.estimate.findUnique.mock.calls[0]?.[0]?.select as {
      line_items: { select: Record<string, unknown> };
    };
    expect(select.line_items.select.price_book_item).toEqual({
      select: expect.objectContaining({ image_url: true, photo_url: true }),
    });
    expect(res.body.estimate.line_items[0].price_book_item.photo_url).toBe(LEGACY_COLUMN_IMAGE);
  });

  it('never hands an item image to a caller from another organization', async () => {
    mockAuthAs('orgB_admin');
    // The row exists — but it belongs to ALPHA_ORG_ID, and the query is tenant-scoped.
    mockOrgScopedEstimate(
      estimateWithLinkedLine({ image_url: null, photo_url: LEGACY_COLUMN_IMAGE }),
    );

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(LEGACY_COLUMN_IMAGE);
  });
});
