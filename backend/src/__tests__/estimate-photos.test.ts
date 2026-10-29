/**
 * estimate-photos.test.ts — R5f: photos on Estimate scope-of-work blocks.

 * The per-line-item photo path was retired in #2029 — line items carry only the price-book
 * item's own image attribute, and nothing may be uploaded against them.
 *
 * Mirrors inv-stages-attachments.test.ts's conventions exactly (magic-byte fixtures, storage
 * mock handles, upload-before-insert ordering) applied to the estimate-scoped surface: gating
 * reuses estimate-lines.controller.ts's loadGuardedEstimate/isMutationBlocked (same
 * DRAFT/SENT/PENDING + lock guard every other line/scope mutation route uses), and — unlike
 * those handlers — never recomputes totals (a photo carries no price) and never runs inside a
 * `$transaction`.
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
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  estimateScopePhoto: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

// setup.ts's storage.from is a mockReturnValue of ONE shared object — grab the handles.
const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  createSignedUrls: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = 'f0000000-0000-0000-0000-000000000001';
const OTHER_ESTIMATE_ID = 'f0000000-0000-0000-0000-000000000099';
const LINE_ID = 'aa000000-0000-0000-0000-000000000003';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000003';
const PHOTO_ID = 'ee000000-0000-0000-0000-000000000001';

// ─── magic-byte fixtures (file-sniff.ts contract) — same as inv-stages-attachments.test.ts ──────
function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
function pngBuf(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}
const pdfBuf = () => Buffer.from('%PDF-1.4\n');

function line(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    estimate_id: ESTIMATE_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    ...over,
  };
}

function scope(over: Record<string, unknown> = {}) {
  return {
    id: SCOPE_ID,
    title: 'Permit fee',
    body: '',
    flat_price: 100,
    is_taxable: true,
    internal_cost: null,
    ...over,
  };
}

// estimate-lines.controller's loadGuardedEstimate select shape (same shape estimate-lines.test.ts
// uses) — status defaults DRAFT (editable, unlocked) so the guard is inert unless a test opts in.
function guardRow({
  status = 'DRAFT' as string,
  lineItems = [line()] as unknown[],
  scopes = [scope()] as unknown[] | null,
  invoices = [] as { status: string }[],
  lockOnSend = false as boolean,
} = {}) {
  return {
    id: ESTIMATE_ID,
    status,
    version: 1,
    tax_rate: 0.1,
    discount_type: null,
    discount_value: null,
    subtotal: 1000,
    tax_amount: 100,
    total_amount: 1100,
    discount_amount: 0,
    scopes,
    organization: { lock_on_send: lockOnSend },
    invoices,
    line_items: lineItems,
  };
}


function scopePhoto(over: Record<string, unknown> = {}) {
  return {
    id: PHOTO_ID,
    estimate_id: ESTIMATE_ID,
    scope_id: SCOPE_ID,
    storage_path: `${ALPHA_ORG_ID}/estimate_scope/${ESTIMATE_ID}/${SCOPE_ID}/123-a.jpg`,
    mime_type: 'image/jpeg',
    caption: null,
    uploaded_at: new Date('2026-07-22T10:00:00Z'),
    uploaded_by: 'Test Admin',
    size_bytes: 1024,
    organization_id: ALPHA_ORG_ID,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin'); // ADMIN bypasses CASL entirely — canDo/canAccessRow/canSeePricing all pass.
  mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());
  mockPrisma.estimateScopePhoto.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: PHOTO_ID, ...args.data }),
  );
  mockPrisma.estimateScopePhoto.delete.mockResolvedValue({});
});

describe('POST /api/estimates/:id/scopes/:scopeId/photos', () => {
  it('happy path: uploads to Storage under the org/estimate_scope/:estimateId/:scopeId path, persists the row, 201s a signed url', async () => {
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'permit.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);

    const [path] = storage.upload.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${ALPHA_ORG_ID}/estimate_scope/${ESTIMATE_ID}/${SCOPE_ID}/\\d+-permit\\.jpg$`));

    const data = mockPrisma.estimateScopePhoto.create.mock.calls[0][0].data;
    expect(data.estimate_id).toBe(ESTIMATE_ID);
    expect(data.scope_id).toBe(SCOPE_ID);
    expect(data.storage_path).toBe(path);
    expect(data.organization_id).toBe(ALPHA_ORG_ID);

    expect(res.body.photo.url).toContain(path);
  });

  it("404s when the scope id doesn't exist on this estimate", async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [] }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s on a frozen (DECLINED) estimate', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'DECLINED' }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

// ═══ Scope photo delete ═══════════════════════════════════════════════════════

describe('DELETE /api/estimates/:id/scopes/:scopeId/photos/:photoId', () => {
  it('removes the Storage object (best-effort) and deletes the row', async () => {
    mockPrisma.estimateScopePhoto.findFirst.mockResolvedValue(scopePhoto());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos/${PHOTO_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(storage.remove).toHaveBeenCalledWith([scopePhoto().storage_path]);
    expect(mockPrisma.estimateScopePhoto.delete).toHaveBeenCalledWith({ where: { id: PHOTO_ID } });

    const where = mockPrisma.estimateScopePhoto.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: PHOTO_ID, estimate_id: ESTIMATE_ID, scope_id: SCOPE_ID, organization_id: ALPHA_ORG_ID });
  });

  it("404s when the scope id doesn't exist on THIS estimate", async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [] }));

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos/${PHOTO_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.estimateScopePhoto.findFirst).not.toHaveBeenCalled();
  });

  // The scope-id-collision scenario (duplicate()/revise() copy scopes[] VERBATIM including id):
  // a photo attached to scope X on estimate A must NOT be visible/deletable via estimate B even
  // when B also has a scope with the same id X. The compound findFirst where-clause is the only
  // thing standing between "correct" and "cross-estimate leak" here — assert it's actually sent.
  it('does NOT delete a same-scope-id photo that belongs to a DIFFERENT estimate (post-duplicate/revise collision)', async () => {
    // Estimate B (OTHER_ESTIMATE_ID) also has a scope with id SCOPE_ID (post-duplicate/revise).
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope({ id: SCOPE_ID })] }));
    // The photo lookup is scoped to (estimate_id: ESTIMATE_ID, scope_id: SCOPE_ID) — a photo that
    // actually belongs to OTHER_ESTIMATE_ID's same-id scope must never match here; findFirst
    // returns null because the mocked lookup enforces the compound key.
    mockPrisma.estimateScopePhoto.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(
        args.where.estimate_id === OTHER_ESTIMATE_ID ? scopePhoto({ estimate_id: OTHER_ESTIMATE_ID }) : null,
      ),
    );

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos/${PHOTO_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.estimateScopePhoto.delete).not.toHaveBeenCalled();
    const where = mockPrisma.estimateScopePhoto.findFirst.mock.calls[0][0].where;
    expect(where.estimate_id).toBe(ESTIMATE_ID);
    expect(where.scope_id).toBe(SCOPE_ID);
  });

  it('still deletes the row when the Storage remove fails (log-warn, not 500)', async () => {
    storage.remove.mockResolvedValueOnce({ data: null, error: { message: 'gone already' } });
    mockPrisma.estimateScopePhoto.findFirst.mockResolvedValue(scopePhoto());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos/${PHOTO_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.estimateScopePhoto.delete).toHaveBeenCalled();
  });

  it('400s a delete on a locked PENDING estimate (org lock_on_send)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'PENDING', lockOnSend: true }));

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos/${PHOTO_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(mockPrisma.estimateScopePhoto.delete).not.toHaveBeenCalled();
  });
});
