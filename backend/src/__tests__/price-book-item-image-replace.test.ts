/**
 * price-book-item-image-replace.test.ts — `PUT /api/price-book/items/:id/image`.
 *
 * The REPLACE-capable sibling of the narrow "fill if empty" POST (#2045, covered by
 * price-book-item-image.test.ts, which this file never touches). Same controller, same storage
 * layout, same MIME allowlist / magic-byte sniff / size cap / audit / conditional write — the
 * only differences are the gate (`update PriceBook`, the catalog permission, not `update
 * Estimate`) and that an item which ALREADY has an image is the normal case rather than a refusal.
 *
 * Why a second route rather than widening the first: the POST exists precisely so someone who may
 * edit an estimate but NOT the catalog can give an image-less item a picture from a line. Merging
 * the two gates would hand every estimate editor the ability to overwrite any catalog image.
 *
 * Harness: supertest against app, prisma + supabase mocked (setup.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  priceBookItem: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

// setup.ts's storage.from is a mockReturnValue of ONE shared object regardless of bucket name.
const storage = supabaseAdmin.storage.from('org-assets') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  getPublicUrl: ReturnType<typeof vi.fn>;
};

const ITEM_ID = 'b1000000-0000-0000-0000-000000002184';

const PREVIOUS_URL =
  `https://test.supabase.co/storage/v1/object/public/org-assets/${ALPHA_ORG_ID}/price-book-items/${ITEM_ID}/1700000000000-old.jpg`;

function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}

function itemWithImage(over: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    image_url: PREVIOUS_URL,
    photo_url: null,
    organization_id: ALPHA_ORG_ID,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.priceBookItem.update.mockImplementation(
    (args: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ id: args.where.id, ...args.data }),
  );
});

describe('PUT /api/price-book/items/:id/image — replace', () => {
  it('writes the public storage URL to the canonical column and clears the legacy inline column', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(itemWithImage());

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(storage.upload).toHaveBeenCalledTimes(1);

    const [storagePath] = storage.upload.mock.calls[0] as [string];
    expect(storagePath.startsWith(`${ALPHA_ORG_ID}/price-book-items/${ITEM_ID}/`)).toBe(true);

    const update = mockPrisma.priceBookItem.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).toEqual({
      image_url: 'https://test.supabase.co/storage/v1/object/public/test/file.jpg',
      photo_url: null,
    });
    expect(res.body.item.image_url).toBe(
      'https://test.supabase.co/storage/v1/object/public/test/file.jpg',
    );
  });

  it('removes the superseded storage object, AFTER the row already points at the new one', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(itemWithImage());

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(storage.remove).toHaveBeenCalledWith([
      `${ALPHA_ORG_ID}/price-book-items/${ITEM_ID}/1700000000000-old.jpg`,
    ]);
    expect(mockPrisma.priceBookItem.update.mock.invocationCallOrder[0]!).toBeLessThan(
      storage.remove.mock.invocationCallOrder[0]!,
    );
  });

  it('leaves a legacy inline image alone — there is no object to remove, and a data URI must never be parsed into a delete', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(
      itemWithImage({ image_url: null, photo_url: 'data:image/png;base64,iVBORw0K' }),
    );

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('never removes an object outside the requester org\'s own prefix, however the column reads', async () => {
    const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(
      itemWithImage({
        image_url: `https://test.supabase.co/storage/v1/object/public/org-assets/${OTHER_ORG}/price-book-items/${ITEM_ID}/1-stolen.jpg`,
      }),
    );

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('audits the write', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(itemWithImage());

    await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    await vi.waitFor(() => expect(mockPrisma.auditLog.create).toHaveBeenCalled());
    const audited = mockPrisma.auditLog.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(audited.data).toMatchObject({
      action: 'pricebook.item_image_replaced',
      resource_type: 'PriceBookItem',
      resource_id: ITEM_ID,
    });
  });

  it('409s and removes the object it just uploaded when another writer moved the image mid-upload', async () => {
    // The row the handler READ still carries PREVIOUS_URL; by the time the awaited upload finishes
    // another writer has moved it. The update mock emulates Prisma's filtered-update WHERE
    // semantics against that already-moved row, so this only passes while the persist actually
    // pins the columns it read — a `where` of id + org alone would match and answer 200.
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(itemWithImage());
    const movedRow: Record<string, unknown> = {
      id: ITEM_ID,
      organization_id: ALPHA_ORG_ID,
      image_url: `https://test.supabase.co/storage/v1/object/public/org-assets/${ALPHA_ORG_ID}/price-book-items/${ITEM_ID}/1700000000001-someone-else.jpg`,
      photo_url: null,
    };
    mockPrisma.priceBookItem.update.mockImplementation(
      (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matches = Object.entries(args.where).every(([k, v]) => movedRow[k] === v);
        if (!matches) {
          const err = new Error('Record to update not found.') as Error & { code: string };
          err.code = 'P2025';
          return Promise.reject(err);
        }
        return Promise.resolve({ ...movedRow, ...args.data });
      },
    );

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBeTypeOf('string');
    // The just-uploaded object is the one removed, never the one still on the row.
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect((storage.remove.mock.calls[0] as [string[]])[0][0]).not.toContain('1700000000000-old.jpg');
  });
});

describe('PUT /api/price-book/items/:id/image — the two gates stay separate', () => {
  it('403s a requester who holds the ESTIMATE write but not the catalog one', async () => {
    mockAuthAs('sales');
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(itemWithImage());

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
  });

  it('404s a cross-org item with the byte-identical body a missing one gets', async () => {
    // tenantWhere(req) is spread into the findUnique, so a cross-org row never matches.
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Item not found' });
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe('PUT /api/price-book/items/:id/image — the same validation as the fill route', () => {
  beforeEach(() => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(itemWithImage());
  });

  it('400s a type outside the allowlist, before any storage call', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', svg, { filename: 'a.svg', contentType: 'image/svg+xml' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'File type not allowed. Accepted: JPG, PNG' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s bytes that disagree with the declared type — the header alone is never trusted', async () => {
    const notAJpeg = Buffer.from('%PDF-1.7 definitely not a photo');

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', notAJpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'File content does not match its declared type' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('413s an oversized upload with the item-image cap, never a raw 500 (#2194 handler stays mounted)', async () => {
    const oversized = jpegBuf(10 * 1024 * 1024 + 1);

    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', oversized, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(413);
    expect(res.body.error).toBeTypeOf('string');
    expect(res.body.error).not.toContain('Internal server error');
    expect(res.body.error).toContain('8MB');
  });

  it('400s a request with no file at all', async () => {
    const res = await request(app)
      .put(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .field('unused', 'x');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No file provided' });
  });
});
