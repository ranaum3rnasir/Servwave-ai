/**
 * price-book-item-image.test.ts — #2045, `POST /api/price-book/items/:id/image`.
 *
 * The narrow "fill if empty" endpoint: a requester who holds `update Estimate` (SALES) but not
 * `update PriceBook` may fill an image-less catalog item's picture from one of their own
 * estimate's lines. Once an item has an image, the route refuses everyone — including ADMIN — and
 * replacing an existing image stays a `PATCH /api/price-book/items/:id` (`update PriceBook`)
 * action, untouched by this file.
 *
 * Gate order under test (spec.md R5): tenant-scoped item lookup -> already-has-image -> estimate
 * row scope (with/without `estimate_id`) -> file validation -> upload/CONDITIONAL persist/audit.
 *
 * Round-3 security fix: the :63 refusal reads a SNAPSHOT, and the awaited Storage upload holds a
 * window open for a concurrent write (another request for the same item, or an ADMIN's
 * `PATCH /api/price-book/items/:id`) to fill the item in between. The persist is
 * `priceBookItem.update({ where: { id, ...tenantWhere, image_url: null, photo_url: null }, data:
 * { image_url } })` — Prisma's filtered-update `where` re-checks both columns are STILL null,
 * atomically, at the moment of the write. A row that no longer matches throws `P2025`
 * ("RecordNotFound"), which the handler catches explicitly and treats as "lost the race": 403 the
 * same de-branded body, best-effort remove the just-uploaded Storage object, never audit.
 * (`updateMany` would express the same atomicity with a `count` instead of a throw, but this
 * controller keeps `update()` — the SAME call the frozen `repro-2045.test.ts` mocks and asserts
 * on; switching to `updateMany` breaks that file, which this stage never edits. Both approaches
 * give Postgres the identical single-statement conditional UPDATE.)
 *
 * Harness: supertest against app, prisma + supabase mocked (setup.ts) — same conventions as
 * repro-2045.test.ts / estimate-photos.test.ts / price-book.test.ts.
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
  auditLog: { create: ReturnType<typeof vi.fn> };
};

// setup.ts's storage.from is a mockReturnValue of ONE shared object regardless of bucket name —
// grab the handle (same pattern as estimate-photos.test.ts / repro-2045.test.ts).
const storage = supabaseAdmin.storage.from('org-assets') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  getPublicUrl: ReturnType<typeof vi.fn>;
};

function p2025(): Error & { code: string } {
  const err = new Error(
    'An operation failed because it depends on one or more records that were required but not found.',
  ) as Error & { code: string };
  err.code = 'P2025';
  return err;
}

/**
 * Wires `priceBookItem.update` to actually emulate Prisma's filtered-update WHERE semantics
 * against a single mutable row — a scalar-equality match on every key in `where` (the only shape
 * this controller's `where` ever is: `id`, `organization_id`, `image_url: null`,
 * `photo_url: null`). REJECTS with a `P2025` error and leaves the row untouched when any key
 * mismatches (the row already has an image, or belongs to a different org) — exactly what real
 * Prisma throws for a filtered `update()` whose predicate matches zero rows. Resolves with the
 * updated row and applies `data` when every key matches. This is what makes the "two sequential
 * fills" test (round 3, case c) work: the second call's `where` still requires `image_url: null`,
 * but the first call's `data` already set it.
 */
function installConditionalUpdateMock(initialRow: {
  id: string;
  organization_id: string;
  image_url: string | null;
  photo_url: string | null;
}) {
  let row = { ...initialRow };
  mockPrisma.priceBookItem.update.mockImplementation(
    (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const matches = Object.entries(args.where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
      if (!matches) return Promise.reject(p2025());
      row = { ...row, ...(args.data as Partial<typeof row>) };
      return Promise.resolve({ ...row });
    },
  );
  return { getRow: () => row };
}

const ESTIMATE_ID = 'f1000000-0000-0000-0000-000000002045';
const OTHER_ESTIMATE_ID = 'f1000000-0000-0000-0000-000000002099';
const LINE_LINKED_ID = 'a1000000-0000-0000-0000-000000002045';
const LINE_OTHER_ITEM_ID = 'a1000000-0000-0000-0000-000000002046';
const ITEM_ID = 'b1000000-0000-0000-0000-000000002045';
const ITEM_WITH_IMAGE_ID = 'b1000000-0000-0000-0000-000000002046';
const ITEM_WITH_PHOTO_URL_ID = 'b1000000-0000-0000-0000-000000002047';
const ITEM_OTHER_ORG_ID = 'b1000000-0000-0000-0000-000000002048';

function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
function pngBuf(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

function guardRow(over: Record<string, unknown> = {}) {
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
    line_items: [
      { id: LINE_LINKED_ID, price_book_item_id: ITEM_ID },
      { id: LINE_OTHER_ITEM_ID, price_book_item_id: 'b1000000-0000-0000-0000-00000000ffff' },
    ],
    ...over,
  };
}

function ownEstimateRow(id = ESTIMATE_ID) {
  return { id, organization_id: ALPHA_ORG_ID, lead_id: null, created_by: TEST_USERS.sales.id };
}

function imagelessItem(id = ITEM_ID) {
  return { id, image_url: null, photo_url: null, organization_id: ALPHA_ORG_ID };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('sales');
  // Default: the write always lands — tests that specifically exercise the race (round 3) install
  // their own `installConditionalUpdateMock` instead.
  mockPrisma.priceBookItem.update.mockImplementation(
    (args: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ id: args.where.id, image_url: null, photo_url: null, ...args.data }),
  );
});

describe('POST /api/price-book/items/:id/image — gate order (R5)', () => {
  it('404s on a nonexistent item, before any image-state or scope check', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Item not found' });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('404s on a cross-org item, with the BYTE-IDENTICAL body a missing item gets (tenancy first, never an existence oracle)', async () => {
    // tenantWhere(req) is spread into the findUnique — a cross-org row simply never matches, so
    // the mock (which the test fully controls) answers null exactly as the "missing" case does.
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_OTHER_ORG_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Item not found' });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
  });

  it('404s a malformed (non-uuid) item id before Prisma is ever touched', async () => {
    const res = await request(app)
      .post('/api/price-book/items/not-a-real-uuid/image')
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Item not found' });
    expect(mockPrisma.priceBookItem.findUnique).not.toHaveBeenCalled();
  });

  it('refuses (403, de-branded) when the item already has image_url, and never touches storage or the DB', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue({
      id: ITEM_WITH_IMAGE_ID,
      image_url: 'https://cdn.example.com/qa-2045-existing.png',
      photo_url: null,
      organization_id: ALPHA_ORG_ID,
    });

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_WITH_IMAGE_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This item already has an image.' });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('refuses (403) when only photo_url is set (the ADMIN-dialog column) — image_url alone is not the whole story', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue({
      id: ITEM_WITH_PHOTO_URL_ID,
      image_url: null,
      photo_url: 'data:image/png;base64,iVBORw0K...',
      organization_id: ALPHA_ORG_ID,
    });

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_WITH_PHOTO_URL_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This item already has an image.' });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe('POST /api/price-book/items/:id/image — estimate_id row scope (R6)', () => {
  beforeEach(() => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(imagelessItem());
  });

  it('404s "Estimate not found" when estimate_id is a malformed uuid — never a 500', async () => {
    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .field('estimate_id', 'not-a-uuid')
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Estimate not found' });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
  });

  it('404s when the supplied estimate_id does not exist / is cross-org', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .field('estimate_id', OTHER_ESTIMATE_ID)
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Estimate not found' });
  });

  it('403s when the supplied estimate is outside the requester\'s own row scope', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());
    // matchesScopeWhere throws on relations the fixture doesn't declare, e.g. `lead` — supply a
    // row that fails BOTH OR branches of OWN_ESTIMATE_VIA_LEAD_OR_CREATOR (created by someone else).
    mockScopedFindFirst(mockPrisma.estimate.findFirst, {
      id: ESTIMATE_ID,
      organization_id: ALPHA_ORG_ID,
      lead_id: null,
      created_by: 'not-this-sales-user',
    });

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .field('estimate_id', ESTIMATE_ID)
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
  });

  it('403s (Insufficient permissions) when the supplied estimate carries no line linked to this item', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ line_items: [{ id: LINE_OTHER_ITEM_ID, price_book_item_id: 'b1000000-0000-0000-0000-00000000ffff' }] }),
    );
    mockScopedFindFirst(mockPrisma.estimate.findFirst, ownEstimateRow());

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .field('estimate_id', ESTIMATE_ID)
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s (locked) when the supplied estimate is frozen (WON) — same B1 lock every line/scope mutation enforces', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'WON' }));
    mockScopedFindFirst(mockPrisma.estimate.findFirst, ownEstimateRow());

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .field('estimate_id', ESTIMATE_ID)
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
  });

  it('201s when estimate_id is supplied AND the estimate carries a line linked to the item', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());
    mockScopedFindFirst(mockPrisma.estimate.findFirst, ownEstimateRow());

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .field('estimate_id', ESTIMATE_ID)
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    // Round 3 (case b) — the persist must be CONDITIONAL: id + tenant + both image columns still
    // null, not a bare `{ id }` — this is what closes the TOCTOU window an awaited Storage upload
    // holds open between the :63 read and the write.
    expect(mockPrisma.priceBookItem.update).toHaveBeenCalledWith({
      where: { id: ITEM_ID, organization_id: ALPHA_ORG_ID, image_url: null, photo_url: null },
      data: { image_url: expect.stringMatching(/^https:\/\//) },
    });
  });

  it('403s when no estimate_id is supplied and the requester has NO estimate at all in their own row scope', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/price-book/items/:id/image — file validation (R1), no storage call on any refusal', () => {
  beforeEach(() => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(imagelessItem());
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
  });

  it('400s "No file provided" when no file is attached', async () => {
    const res = await request(app).post(`/api/price-book/items/${ITEM_ID}/image`).set(authHeader('sales'));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No file provided' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s the disallowed-type message for a non-image MIME', async () => {
    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', Buffer.from('plain text'), { filename: 'x.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'File type not allowed. Accepted: JPG, PNG' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s the spoofed-magic-bytes message when the declared type disagrees with the sniffed one', async () => {
    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', Buffer.from('not actually a png'), { filename: 'fake.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'File content does not match its declared type' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s the oversize message for a file over the 8MB cap', async () => {
    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(9 * 1024 * 1024), { filename: 'big.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'File too large. Maximum: 8MB' });
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe('POST /api/price-book/items/:id/image — happy path: write, audit, no role check', () => {
  beforeEach(() => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(imagelessItem());
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
  });

  it('201s, writes image_url (not photo_url), and audits pricebook.item_image_filled with the actor', async () => {
    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', pngBuf(), { filename: 'catalog.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    const data = mockPrisma.priceBookItem.update.mock.calls[0]?.[0]?.data ?? {};
    expect(data.image_url).toBeTruthy();
    expect(data.photo_url).toBeUndefined();
    expect(storage.upload).toHaveBeenCalledTimes(1);
    // Path convention: `${orgId}/price-book-items/${itemId}/...` (R9).
    expect(storage.upload.mock.calls[0]?.[0]).toContain(`${ALPHA_ORG_ID}/price-book-items/${ITEM_ID}/`);

    const audit = mockPrisma.auditLog.create.mock.calls[0]?.[0]?.data;
    expect(audit).toMatchObject({
      action: 'pricebook.item_image_filled',
      resource_type: 'PriceBookItem',
      resource_id: ITEM_ID,
      actor_id: TEST_USERS.sales.id,
    });
  });

  it('never fires the pricebook.item_image_filled audit on a refusal (already-has-image case)', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue({
      id: ITEM_WITH_IMAGE_ID,
      image_url: 'https://cdn.example.com/x.png',
      photo_url: null,
      organization_id: ALPHA_ORG_ID,
    });

    await request(app)
      .post(`/api/price-book/items/${ITEM_WITH_IMAGE_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    // A global access-denied logger also writes to auditLog.create on a 403 — this asserts the
    // fill-specific audit action never fires, not that the table is untouched.
    const actions = mockPrisma.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
    expect(actions).not.toContain('pricebook.item_image_filled');
  });

  it('accepts an ADMIN caller too — the gate is the item/estimate, never a role check', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('admin'))
      .attach('file', pngBuf(), { filename: 'catalog.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.update).toHaveBeenCalled();
  });
});

describe('POST /api/price-book/items/:id/image — round 3: conditional persist closes the TOCTOU window', () => {
  beforeEach(() => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(imagelessItem());
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
  });

  it('(a) refuses (403, de-branded) when the item gained an image between the :63 read and the write, best-effort removes the just-uploaded object, and never audits', async () => {
    // The :54 read (findUnique, mocked in the outer beforeEach) sees the item as image-less and
    // passes :63 — but by the time the CONDITIONAL update actually runs, the row already has an
    // image (a concurrent write — e.g. an ADMIN's PATCH — landed in the window the awaited Storage
    // upload holds open). Emulated here via a row whose OWN state already has image_url set, so
    // the filtered update's `image_url: null` clause never matches and Prisma throws P2025.
    installConditionalUpdateMock({
      id: ITEM_ID,
      organization_id: ALPHA_ORG_ID,
      image_url: 'https://cdn.example.com/concurrent-admin.png',
      photo_url: null,
    });

    const res = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This item already has an image.' });
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove.mock.calls[0]?.[0]?.[0]).toContain(`${ALPHA_ORG_ID}/price-book-items/${ITEM_ID}/`);
    const actions = mockPrisma.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
    expect(actions).not.toContain('pricebook.item_image_filled');
  });

  it('(c) two sequential fills on the same item: the first 201s, the second 403s — last-writer-wins is closed', async () => {
    installConditionalUpdateMock({ id: ITEM_ID, organization_id: ALPHA_ORG_ID, image_url: null, photo_url: null });

    const first = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'first.jpg', contentType: 'image/jpeg' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/price-book/items/${ITEM_ID}/image`)
      .set(authHeader('sales'))
      .attach('file', jpegBuf(), { filename: 'second.jpg', contentType: 'image/jpeg' });
    expect(second.status).toBe(403);
    expect(second.body).toEqual({ error: 'This item already has an image.' });

    expect(mockPrisma.priceBookItem.update).toHaveBeenCalledTimes(2);
    // Only the WINNING request's object survives — the loser's just-uploaded object is removed.
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });
});

describe('control — PATCH /api/price-book/items/:id (update PriceBook) is untouched by this endpoint', () => {
  it('SALES still 403s on the general write route (no widening)', async () => {
    mockPrisma.priceBookItem.findUnique.mockResolvedValue(imagelessItem());

    const res = await request(app)
      .patch(`/api/price-book/items/${ITEM_ID}`)
      .set(authHeader('sales'))
      .send({ image_url: 'https://example.com/x.png' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
  });
});
