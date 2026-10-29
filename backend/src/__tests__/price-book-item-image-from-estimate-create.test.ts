/**
 * Create-then-attach, for the operator this flow actually has.
 *
 * Saving a line to the catalog from inside an estimate needs `create PriceBook`. Giving that
 * brand-new item a picture must NOT also need `update PriceBook`, because the two grants are
 * separate and an estimate-building role can hold the first without the second. That is precisely
 * why the fill-if-empty endpoint exists: it is gated on `update Estimate`, it accepts only an
 * item with no picture in either column, and a just-created item is image-less by definition.
 *
 * So this file pins the seam the estimate flow rides on, for a principal built on purpose:
 * `update Estimate` + `create PriceBook`, and NO `update PriceBook`.
 *
 *   1. the create succeeds, and the row it makes carries no picture in either column - the
 *      picture is deliberately not a field on that payload;
 *   2. the fill endpoint then accepts that item, with the estimate NAMED (not left to the
 *      endpoint's own no-estimate fallback), and writes the canonical column;
 *   3. the REPLACE sibling refuses the same principal - which is what makes the fill route
 *      load-bearing here rather than a convenience.
 *
 * The fill endpoint's own gate, behaviour and tests are untouched by this slice;
 * `price-book-item-image.test.ts` and `price-book-item-image-replace.test.ts` remain their owners.
 *
 * Harness: supertest against app, prisma + supabase mocked (setup.ts) - same conventions as
 * price-book-item-image.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, TEST_USERS, ALPHA_ORG_ID } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  priceBookItem: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
};

// setup.ts's storage.from is a mockReturnValue of ONE shared object regardless of bucket name.
const storage = supabaseAdmin.storage.from('org-assets') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  getPublicUrl: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = 'f1000000-0000-0000-0000-000000005606';
const LINE_ID = 'a1000000-0000-0000-0000-000000005606';
const NEW_ITEM_ID = 'b1000000-0000-0000-0000-000000005606';

function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}

/**
 * The principal this flow actually has: an estimate editor who may ADD to the catalog but may not
 * rewrite it. Built explicitly rather than inherited - SALES holds neither PriceBook write by
 * default, so a role default would make every assertion below vacuous in a different direction.
 */
function mockEstimateEditorWhoMayCreateCatalogItems() {
  mockAuthAs('sales');
  mockPrisma.rolePermission.findMany.mockResolvedValue([
    ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
    { role: 'SALES', action: 'create', subject: 'PriceBook' },
  ]);
  clearPermissionCache();
}

/** The guard row `loadGuardedEstimate` reads: an own, editable estimate carrying the new line. */
function guardRow() {
  return {
    id: ESTIMATE_ID,
    status: 'DRAFT',
    version: 1,
    tax_rate: 0.1,
    discount_type: null,
    discount_value: null,
    subtotal: 120,
    tax_amount: 12,
    total_amount: 132,
    discount_amount: 0,
    scopes: [],
    organization: { lock_on_send: false },
    invoices: [],
    line_items: [{ id: LINE_ID, price_book_item_id: NEW_ITEM_ID }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockEstimateEditorWhoMayCreateCatalogItems();
});

describe('create a catalog item from an estimate, then fill its picture', () => {
  it('lets an estimate editor who may create catalog items (but not update them) do both', async () => {
    // 1. The create. No picture on the payload - the item is born image-less on purpose.
    mockPrisma.priceBookItem.create.mockResolvedValue({
      id: NEW_ITEM_ID,
      name: 'Deadbolt',
      type: 'MATERIAL',
      unit_price: 120,
      taxable: true,
      image_url: null,
      photo_url: null,
      organization_id: ALPHA_ORG_ID,
    });

    const create = await request(app)
      .post('/api/price-book/items')
      .set(authHeader('sales'))
      .send({ name: 'Deadbolt', type: 'MATERIAL', unit_price: 120, taxable: true });

    expect(create.status).toBe(201);
    const createdData = mockPrisma.priceBookItem.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(createdData.image_url).toBeNull();
    expect(createdData.photo_url).toBeNull();

    // 2. The fill, naming the estimate the line now sits on.
    mockPrisma.priceBookItem.findUnique.mockResolvedValue({
      id: NEW_ITEM_ID,
      image_url: null,
      photo_url: null,
      organization_id: ALPHA_ORG_ID,
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ESTIMATE_ID,
      organization_id: ALPHA_ORG_ID,
      lead_id: null,
      created_by: TEST_USERS.sales.id,
    });
    mockPrisma.priceBookItem.update.mockImplementation(
      (args: { where: { id: string }; data: Record<string, unknown> }) =>
        Promise.resolve({ id: args.where.id, ...args.data }),
    );

    const fill = await request(app)
      .post(`/api/price-book/items/${NEW_ITEM_ID}/image`)
      .set(authHeader('sales'))
      .field('estimate_id', ESTIMATE_ID)
      .attach('file', jpegBuf(), { filename: 'deadbolt.jpg', contentType: 'image/jpeg' });

    expect(fill.status).toBe(201);
    // The estimate was NAMED: the guarded lookup ran, rather than the no-estimate fallback.
    expect(mockPrisma.estimate.findUnique).toHaveBeenCalled();
    // Stored the same way a picture attached from the price book is: the bytes go to the shared
    // object layout under the org, and the canonical column takes that object's public URL. The
    // inline column is not written at all.
    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringContaining(`${ALPHA_ORG_ID}/price-book-items/${NEW_ITEM_ID}/`),
      expect.anything(),
      expect.objectContaining({ contentType: 'image/jpeg' }),
    );
    const written = mockPrisma.priceBookItem.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(written.image_url).toBe(storage.getPublicUrl.mock.results[0]!.value.data.publicUrl);
    expect(written).not.toHaveProperty('photo_url');
    expect(fill.body.item).toMatchObject({ id: NEW_ITEM_ID, image_url: written.image_url });
  });

  it('refuses the same principal at the REPLACE sibling — the fill route is what makes this flow possible', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue({
      id: NEW_ITEM_ID,
      image_url: null,
      photo_url: null,
      organization_id: ALPHA_ORG_ID,
    });

    const res = await request(app)
      .put(`/api/price-book/items/${NEW_ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'deadbolt.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
